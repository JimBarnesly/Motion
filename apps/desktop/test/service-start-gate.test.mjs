import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runner = process.env.MOTION_TEST_SERVICE_BUNDLE ?? fileURLToPath(new URL("../service-runner.mjs", import.meta.url));

async function withProcess(body) {
  const parent = await mkdtemp(join(tmpdir(), "motion-start-gate-"));
  const root = join(parent, "data");
  const child = spawn(process.env.MOTION_TEST_NODE_BINARY ?? process.execPath, [runner, root], {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MOTION_SERVICE_START_GATE: "1" }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  try { await body({ child, root, exited, stderr: () => stderr }); }
  finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

test("a service request cannot substitute for the native startup gate", { timeout: 15_000 }, () => withProcess(async ({ child, root, exited }) => {
  child.stdin.write(`${JSON.stringify({ lane: "command", payload: { type: "workspace.create", name: "Must not run" } })}\n`);
  const [code] = await exited;
  assert.notEqual(code, 0);
  await assert.rejects(lstat(root), { code: "ENOENT" });
}));

test("closing the native startup pipe before authorization creates no mutable state", { timeout: 15_000 }, () => withProcess(async ({ child, root, exited }) => {
  child.stdin.end();
  const [code] = await exited;
  assert.notEqual(code, 0);
  await assert.rejects(lstat(root), { code: "ENOENT" });
}));

test("native startup gate preserves the first queued request in the same pipe chunk", { timeout: 15_000 }, () => withProcess(async ({ child, root, exited, stderr }) => {
  const replies = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const reply = once(replies, "line");
  child.stdin.write(`MOTION_SERVICE_START\n${JSON.stringify({ lane: "ui-load", payload: { schemaVersion: 2 } })}\n`);
  const [line] = await Promise.race([
    reply,
    exited.then(() => { throw new Error(`Service exited before replying: ${stderr()}`); })
  ]);
  assert.deepEqual(JSON.parse(line), { ok: true, value: { schemaVersion: 2, workspace: null, revision: 0, activePageId: null } });
  assert.equal((await lstat(join(root, "motion.sqlite3"))).isFile(), true);
  child.stdin.end();
  assert.equal((await exited)[0], 0, stderr());
}));
