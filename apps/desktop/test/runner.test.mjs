import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

async function listeningTcpSockets(pid) {
  if (process.platform !== "linux") return [];
  const descriptors = await readdir(`/proc/${pid}/fd`);
  const owned = new Set();
  for (const descriptor of descriptors) {
    const target = await readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => "");
    const match = target.match(/^socket:\[(\d+)\]$/);
    if (match) owned.add(match[1]);
  }
  const listeners = [];
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const rows = (await readFile(table, "utf8")).trim().split("\n").slice(1);
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (fields[3] === "0A" && owned.has(fields[9])) listeners.push({ table, local: fields[1], inode: fields[9] });
    }
  }
  return listeners;
}

test("one service process handles errors and multiple durable requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-desktop-runner-"));
  const child = spawn(process.execPath, [new URL("../dist/service-bundle.mjs", import.meta.url).pathname, root], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = [];
  lines.on("line", line => replies.push(JSON.parse(line)));
  const send = request => child.stdin.write(`${JSON.stringify(request)}\n`);
  const waitFor = async count => {
    const deadline = Date.now() + 5_000;
    while (replies.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(replies.length, count);
    return replies[count - 1];
  };
  try {
    const pid = child.pid;
    assert.deepEqual(await listeningTcpSockets(pid), [], "stdin/stdout service IPC opened a TCP listener");
    send({ lane: "unsupported", payload: {} });
    assert.equal((await waitFor(1)).error.code, "INVALID_INPUT");
    child.stdin.write("{malformed-json-containing-private-path-/home/operator/secret\n");
    const internal = await waitFor(2);
    assert.deepEqual(internal.error, { code: "INTERNAL_ERROR", message: "Internal service failure" });
    send({ lane: "ui-save", payload: { schemaVersion: 1, document: { schemaVersion: 1, pages: [{ id: "page-1", parentId: null, order: 0, type: "document", title: "Durable", blocks: [{ id: "block-1", type: "paragraph", text: "same process" }] }], activePageId: "page-1" } } });
    assert.equal((await waitFor(3)).value.saved, true);
    send({ lane: "ui-load", payload: { schemaVersion: 1 } });
    const loaded = await waitFor(4);
    assert.equal(loaded.value.pages[0].blocks[0].text, "same process");
    send({ lane: "async-query", payload: { type: "backup.create", workspaceId: "web-workspace-v1" } });
    const backup = (await waitFor(5)).value;
    send({ lane: "ui-save", payload: { schemaVersion: 1, document: { schemaVersion: 1, pages: [{ id: "page-1", parentId: null, order: 0, type: "document", title: "Changed", blocks: [{ id: "block-1", type: "paragraph", text: "changed after backup" }] }], activePageId: "page-1" } } });
    assert.equal((await waitFor(6)).value.saved, true);
    send({ lane: "async-command", payload: { type: "backup.restore-new", bundle: backup, newWorkspaceId: "restored-workspace" } });
    assert.equal((await waitFor(7)).value.workspace.id, "restored-workspace");
    send({ lane: "ui-load", payload: { schemaVersion: 1 } });
    const restored = await waitFor(8);
    assert.equal(restored.value.pages[0].blocks[0].text, "same process");
    const destination = join(root, "selected.motion-backup.json"); const neighbour = join(root, "unrelated.txt");
    await writeFile(neighbour, "preserve", { mode: 0o640 });
    send({ lane: "native-backup-inspect", payload: { destination } });
    assert.deepEqual((await waitFor(9)).value, { exists: false, replacement: false });
    send({ lane: "native-backup-save", payload: { destination, replaceConfirmed: false, bundle: backup } });
    assert.equal((await waitFor(10)).value.path, destination);
    assert.equal((await lstat(destination)).mode & 0o777, 0o600);
    send({ lane: "native-backup-inspect", payload: { destination } });
    assert.deepEqual((await waitFor(11)).value, { exists: true, replacement: true });
    send({ lane: "native-backup-save", payload: { destination, replaceConfirmed: true, bundle: backup } });
    assert.equal((await waitFor(12)).value.path, destination);
    assert.equal(await readFile(neighbour, "utf8"), "preserve");
    const malformed = join(root, "malformed.json"); await writeFile(malformed, "{", { mode: 0o600 });
    send({ lane: "native-backup-inspect", payload: { destination: malformed } });
    assert.deepEqual((await waitFor(13)).error, { code: "VALIDATION_FAILED", message: "Selected target is not a valid private Motion backup" });
    assert.equal(await readFile(malformed, "utf8"), "{");
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, "motion.sqlite3"))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(root, "ui-state.json"))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(root, "attachments"))).mode & 0o777, 0o700);
    assert.equal(child.pid, pid);
    assert.equal(child.exitCode, null);
    assert.deepEqual(await listeningTcpSockets(pid), [], "service opened a TCP listener after handling IPC");
  } finally {
    child.stdin.end();
    await new Promise(resolve => child.once("exit", resolve));
    await rm(root, { recursive: true });
  }
});
