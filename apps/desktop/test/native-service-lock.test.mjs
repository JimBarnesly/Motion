import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { acquireNativeServiceLock } from "../native-service-lock.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const workerPath = new URL("./fixtures/native-service-lock-worker.mjs", import.meta.url).pathname;

function startWorker(root, mutations) {
  const child = spawn(process.execPath, [workerPath, root, mutations], { stdio: ["pipe", "pipe", "pipe"] });
  const replies = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => replies.push(JSON.parse(line)));
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const next = async (count = 1, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    while (replies.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(replies.length >= count, `worker reply timed out: ${stderr}`);
    return replies[count - 1];
  };
  return { child, next, send: command => child.stdin.write(`${command}\n`) };
}

async function stop(worker) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  worker.child.kill("SIGTERM");
  await new Promise(resolve => worker.child.once("exit", resolve));
}

test("one native service owns a data root and rejects a second before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-service-owner-"));
  const mutations = join(root, "mutations.log");
  const owner = startWorker(root, mutations);
  let contender;
  try {
    assert.deepEqual(await owner.next(), { type: "acquired" });
    assert.equal((await lstat(join(root, ".motion-service.lock"))).mode & 0o777, 0o600);
    contender = startWorker(root, mutations);
    const rejected = await contender.next(1, 1_000);
    assert.deepEqual(rejected, { type: "rejected", code: "MOTION_DATA_ROOT_BUSY", message: "Motion data is already open in another desktop process" });
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(readFile(mutations, "utf8"), error => error?.code === "ENOENT");
    owner.send("mutate");
    assert.deepEqual(await owner.next(2), { type: "mutated" });
    assert.equal(await readFile(mutations, "utf8"), "revision\n");
  } finally {
    if (contender) await stop(contender);
    await stop(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed and non-private lock evidence fails closed without deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-service-hostile-lock-"));
  const lockPath = join(root, ".motion-service.lock");
  const cases = [
    async () => writeFile(lockPath, "not json", { mode: 0o600 }),
    async () => writeFile(lockPath, JSON.stringify({ schemaVersion: 1, pid: 999999, processStartToken: "stale", nonce: "not-a-uuid", createdAt: "invalid" }), { mode: 0o600 }),
    async () => { await writeFile(lockPath, "{}", { mode: 0o644 }); await chmod(lockPath, 0o644); },
    async () => mkdir(lockPath),
    ...(typeof process.getuid === "function" && process.getuid() === 0 ? [async () => {
      await writeFile(lockPath, JSON.stringify({ schemaVersion: 1, pid: 999999, processStartToken: "stale", nonce: randomUUID(), createdAt: new Date().toISOString() }), { mode: 0o600 });
      await chown(lockPath, 1, 1);
    }] : []),
    async () => { const target = join(root, "target"); await writeFile(target, "preserve", { mode: 0o600 }); await symlink(target, lockPath); }
  ];
  try {
    for (const arrange of cases) {
      await rm(lockPath, { recursive: true, force: true });
      await arrange();
      const before = await lstat(lockPath);
      assert.throws(() => acquireNativeServiceLock(root), error => error?.code === "MOTION_DATA_ROOT_BUSY" && !error.message.includes(root));
      const after = await lstat(lockPath);
      assert.deepEqual({ dev: after.dev, ino: after.ino, type: after.mode & 0o170000 }, { dev: before.dev, ino: before.ino, type: before.mode & 0o170000 });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SIGKILL leaves recoverable evidence and a later owner remains usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-service-stale-lock-"));
  const mutations = join(root, "mutations.log");
  const killed = startWorker(root, mutations);
  let successor;
  try {
    assert.deepEqual(await killed.next(), { type: "acquired" });
    killed.child.kill("SIGKILL");
    await new Promise(resolve => killed.child.once("exit", resolve));
    successor = startWorker(root, mutations);
    assert.deepEqual(await successor.next(), { type: "acquired" });
    successor.send("mutate");
    assert.deepEqual(await successor.next(2), { type: "mutated" });
    assert.equal(await readFile(mutations, "utf8"), "revision\n");
  } finally {
    if (successor) await stop(successor);
    await stop(killed);
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux process start identity distinguishes a reused PID from the recorded owner", async context => {
  if (process.platform !== "linux") { context.skip("Linux /proc identity is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "motion-service-pid-reuse-"));
  const lockPath = join(root, ".motion-service.lock");
  try {
    const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
    const actualToken = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    const evidence = { schemaVersion: 1, pid: process.pid, processStartToken: `${actualToken}-previous`, nonce: randomUUID(), createdAt: new Date(0).toISOString() };
    await writeFile(lockPath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
    const owner = acquireNativeServiceLock(root);
    assert.notEqual(JSON.parse(await readFile(lockPath, "utf8")).processStartToken, evidence.processStartToken);
    owner.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unverifiable live-PID identity mismatch fails closed", async context => {
  if (process.platform !== "linux") { context.skip("Linux /proc identity is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "motion-service-identity-mismatch-"));
  const lockPath = join(root, ".motion-service.lock");
  const evidence = { schemaVersion: 1, pid: process.pid, processStartToken: "forged-token", nonce: randomUUID(), createdAt: new Date().toISOString() };
  try {
    await writeFile(lockPath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
    const before = await lstat(lockPath);
    assert.throws(() => acquireNativeServiceLock(root), error => error?.code === "MOTION_DATA_ROOT_BUSY");
    const after = await lstat(lockPath);
    assert.deepEqual({ dev: after.dev, ino: after.ino }, { dev: before.dev, ino: before.ino });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stale recovery revalidates inode and nonce immediately before deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-service-revalidate-"));
  const lockPath = join(root, ".motion-service.lock");
  const displaced = join(root, "displaced.lock");
  const stale = { schemaVersion: 1, pid: 999999, processStartToken: "dead-process", nonce: randomUUID(), createdAt: new Date().toISOString() };
  const replacement = { ...stale, nonce: randomUUID() };
  try {
    await writeFile(lockPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
    assert.throws(() => acquireNativeServiceLock(root, { beforeStaleDelete() {
      renameSync(lockPath, displaced);
      writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    } }), error => error?.code === "MOTION_DATA_ROOT_BUSY");
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), replacement);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release removes only the caller-owned lock inode and nonce", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-service-release-"));
  const lockPath = join(root, ".motion-service.lock");
  try {
    const owner = acquireNativeServiceLock(root);
    const displaced = join(root, `.displaced-${randomUUID()}`);
    await rename(lockPath, displaced);
    await writeFile(lockPath, "replacement evidence", { mode: 0o600 });
    owner.release();
    assert.equal(await readFile(lockPath, "utf8"), "replacement evidence");
    assert.ok((await lstat(displaced)).isFile());
  } finally { await rm(root, { recursive: true, force: true }); }
});
