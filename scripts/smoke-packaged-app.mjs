import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const appImage = process.argv[2] ? resolve(process.argv[2]) : null;
if (!appImage) throw new Error("Usage: node scripts/smoke-packaged-app.mjs <Motion.AppImage>");
if (!(await stat(appImage)).isFile()) throw new Error(`AppImage not found: ${appImage}`);

const root = await mkdtemp(join(tmpdir(), "motion-package-smoke-"));
const extracted = join(root, "extracted");
const dataRoot = join(root, "workspace");

async function run(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? accept({ stdout, stderr }) : reject(new Error(`${basename(command)} exited ${code}: ${stderr}`)));
  });
}

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    }
  }
  return null;
}

async function serviceExchange(node, runner, requests) {
  const guard = resolve("scripts/deny-network.cjs");
  const child = spawn(node, [runner, dataRoot], {
    env: { ...process.env, NODE_OPTIONS: `--require=${guard}` },
    stdio: ["pipe", "pipe", "inherit"]
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = [];
  lines.on("line", line => replies.push(JSON.parse(line)));
  try {
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    const deadline = Date.now() + 10_000;
    while (replies.length < requests.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(replies.length, requests.length, "packaged service did not answer every request");
    return replies;
  } finally {
    child.stdin.end();
    await new Promise(resolve => child.once("exit", resolve));
  }
}

try {
  await chmod(appImage, 0o755);
  await run(appImage, ["--appimage-extract"], { cwd: root, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" } });
  await stat(join(root, "squashfs-root"));
  await rename(join(root, "squashfs-root"), extracted);
  const node = await findFile(extracted, "node-runtime");
  const runner = await findFile(extracted, "service-bundle.mjs");
  assert.ok(node, "packaged Node runtime is missing");
  assert.ok(runner, "packaged service bundle is missing");
  assert.match((await run(node, ["--version"])).stdout.trim(), /^v24\./);

  const document = { schemaVersion: 1, pages: [{ id: "page-package-smoke", parentId: null, order: 0, type: "document", title: "Packaged restart", blocks: [{ id: "block-package-smoke", type: "paragraph", text: "Durable and offline" }] }], activePageId: "page-package-smoke" };
  const saved = await serviceExchange(node, runner, [{ lane: "ui-save", payload: { schemaVersion: 1, document } }]);
  assert.equal(saved[0]?.value?.saved, true);

  const backup = (await serviceExchange(node, runner, [{ lane: "async-query", payload: { type: "backup.create", workspaceId: "web-workspace-v1" } }]))[0]?.value;
  assert.equal(backup?.manifest?.format, "motion-workspace-backup");
  const changed = structuredClone(document);
  changed.pages[0].blocks[0].text = "Changed after backup";
  assert.equal((await serviceExchange(node, runner, [{ lane: "ui-save", payload: { schemaVersion: 1, document: changed } }]))[0]?.value?.saved, true);
  const restored = (await serviceExchange(node, runner, [{ lane: "async-command", payload: { type: "backup.restore-new", bundle: backup, newWorkspaceId: "packaged-restored-workspace" } }]))[0]?.value;
  assert.equal(restored?.workspace?.id, "packaged-restored-workspace");

  const loaded = await serviceExchange(node, runner, [{ lane: "ui-load", payload: { schemaVersion: 1 } }]);
  assert.equal(loaded[0]?.value?.pages?.[0]?.blocks?.[0]?.text, "Durable and offline");
  const search = await serviceExchange(node, runner, [{ lane: "query", payload: { type: "workspace.search", workspaceId: "packaged-restored-workspace", query: "Durable", limit: 10 } }]);
  assert.ok(search[0]?.value?.length > 0, "restored packaged workspace is not searchable");
  process.stdout.write("Packaged AppImage runtime, offline save/search, verified backup/restore, termination, restart, and reload passed.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
