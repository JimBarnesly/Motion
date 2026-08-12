import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { closeSync, constants, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, link, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const workerPath = new URL("./fixtures/native-service-lock-worker.mjs", import.meta.url).pathname;
const crashWorkerPath = new URL("./fixtures/native-service-lock-crash-worker.mjs", import.meta.url).pathname;
const lockName = ".motion-service.lock";
const busy = { type: "rejected", code: "MOTION_DATA_ROOT_BUSY", message: "Motion data is already open in another desktop process" };

function startWorker(root, mutations, options = {}) {
  const child = spawn(process.execPath, [workerPath, root, mutations], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...options.env }
  });
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
  if (!worker || worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  worker.child.kill("SIGTERM");
  await new Promise(resolve => worker.child.once("exit", resolve));
}

async function crashEvidence(mode, root) {
  const child = spawn(process.execPath, [crashWorkerPath, mode, root], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const [code, signal] = await new Promise(resolve => child.once("exit", (...status) => resolve(status)));
  assert.equal(code, null, stderr);
  assert.equal(signal, "SIGKILL", stderr);
}

async function withRoot(prefix, body) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("production ownership exposes no failure-injection options", async () => {
  const source = await readFile(new URL("../native-service-lock.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /beforeEvidencePublish|afterGuardianReady|guardianCommand|afterLock/);
  assert.match(source, /export async function acquireNativeServiceLock\(dataRoot\)/);
});

test("root ownership, privacy, type, and link-count violations fail closed", async () => {
  await withRoot("motion-hostile-root-mode-", async root => {
    await fs.promises.chmod(root, 0o755);
    const before = await stat(root);
    const { acquireNativeServiceLock } = await import(`../native-service-lock.mjs?root-mode=${Date.now()}`);
    await assert.rejects(acquireNativeServiceLock(root), error => error?.code === "MOTION_DATA_ROOT_BUSY");
    assert.equal((await stat(root)).mode & 0o777, before.mode & 0o777);
  });
  await withRoot("motion-hostile-root-type-", async root => {
    const file = join(root, "not-a-directory");
    await writeFile(file, "hostile", { mode: 0o600 });
    const { acquireNativeServiceLock } = await import(`../native-service-lock.mjs?root-type=${Date.now()}`);
    await assert.rejects(acquireNativeServiceLock(file), error => error?.code === "MOTION_DATA_ROOT_BUSY");
    assert.equal(await readFile(file, "utf8"), "hostile");
  });
});

test("a fresh empty private root starts and publishes complete evidence", async () => {
  await withRoot("motion-fresh-root-", async root => {
    assert.deepEqual(await fs.promises.readdir(root), []);
    const { acquireNativeServiceLock } = await import("../native-service-lock.mjs");
    const ownership = await acquireNativeServiceLock(root);
    try {
      const evidence = JSON.parse(await readFile(join(root, lockName), "utf8"));
      assert.equal(evidence.schemaVersion, 1);
      assert.equal(evidence.pid, process.pid);
    } finally { await ownership.release(); }
  });
});

test("a crash immediately after no-replace publication does not permanently block the root", async () => {
  await withRoot("motion-after-link-crash-", async root => {
    await crashEvidence("after-link", root);
    const lockPath = join(root, lockName);
    assert.equal((await stat(lockPath)).nlink, 2);
    const successor = startWorker(root, join(root, "mutations.log"));
    try { assert.deepEqual(await successor.next(), { type: "acquired" }); }
    finally { await stop(successor); }
    assert.equal((await stat(lockPath)).nlink, 1);
    assert.deepEqual((await fs.promises.readdir(root)).filter(name => name.endsWith(".tmp")), []);
  });
});

test("a crash after truncating valid evidence does not permanently block the root", async () => {
  await withRoot("motion-after-truncate-crash-", async root => {
    const first = startWorker(root, join(root, "first-mutations.log"));
    assert.deepEqual(await first.next(), { type: "acquired" });
    await stop(first);
    await crashEvidence("after-truncate", root);
    assert.equal((await stat(join(root, lockName))).size, 0);
    const successor = startWorker(root, join(root, "mutations.log"));
    try { assert.deepEqual(await successor.next(), { type: "acquired" }); }
    finally { await stop(successor); }
    assert.ok((await stat(join(root, lockName))).size > 0);
  });
});

test("one process owns the root before mutation while the owner remains usable", async () => {
  await withRoot("motion-owner-", async root => {
    const mutations = join(root, "mutations.log");
    const owner = startWorker(root, mutations);
    let contender;
    try {
      assert.deepEqual(await owner.next(), { type: "acquired" });
      contender = startWorker(root, mutations);
      assert.deepEqual(await contender.next(1, 1_000), busy);
      await assert.rejects(readFile(mutations), error => error?.code === "ENOENT");
      owner.send("mutate");
      assert.deepEqual(await owner.next(2), { type: "mutated" });
      assert.equal(await readFile(mutations, "utf8"), "revision\n");
    } finally { await stop(contender); await stop(owner); }
  });
});

test("pathname displacement cannot create a second writer for the same data root", async () => {
  await withRoot("motion-displaced-owner-", async root => {
    const mutations = join(root, "mutations.log");
    const lockPath = join(root, lockName);
    const owner = startWorker(root, mutations);
    let contender;
    try {
      assert.deepEqual(await owner.next(), { type: "acquired" });
      await rename(lockPath, join(root, "displaced.lock"));
      await writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: "00000000-0000-4000-8000-000000000000" })}\n`, { mode: 0o600 });

      contender = startWorker(root, mutations);
      assert.deepEqual(await contender.next(1, 1_000), busy);
      await assert.rejects(readFile(mutations), error => error?.code === "ENOENT");

      owner.send("mutate");
      assert.deepEqual(await owner.next(2), { type: "mutated" });
      assert.equal(await readFile(mutations, "utf8"), "revision\n");
    } finally { await stop(contender); await stop(owner); }
  });
});

test("a PATH-controlled fake flock cannot bypass directory ownership", async () => {
  await withRoot("motion-fake-flock-", async root => {
    const fakeBin = join(root, "fake-bin");
    await fs.promises.mkdir(fakeBin);
    await writeFile(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const mutations = join(root, "mutations.log");
    const owner = startWorker(root, mutations);
    let contender;
    try {
      assert.equal((await owner.next()).type, "acquired");
      contender = startWorker(root, mutations, { env: { PATH: `${fakeBin}:${process.env.PATH}` } });
      assert.deepEqual(await contender.next(1, 1_000), busy);
      await assert.rejects(readFile(mutations), error => error?.code === "ENOENT");
    } finally { await stop(contender); await stop(owner); }
  });
});

test("killing only the guardian makes the live owner fatal before further mutation", async () => {
  await withRoot("motion-guardian-death-", async root => {
    const mutations = join(root, "mutations.log");
    const owner = startWorker(root, mutations, { env: { MOTION_TEST_EXPOSE_GUARDIAN_PID: "1" } });
    let successor;
    try {
      const acquired = await owner.next();
      assert.equal(acquired.type, "acquired");
      assert.ok(Number.isSafeInteger(acquired.guardianPid));
      process.kill(acquired.guardianPid, "SIGKILL");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("owner survived guardian death")), 1_000);
        owner.child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      await assert.rejects(readFile(mutations), error => error?.code === "ENOENT");
      successor = startWorker(root, mutations);
      assert.equal((await successor.next()).type, "acquired");
    } finally { await stop(successor); await stop(owner); }
  });
});

test("SIGKILL automatically releases ownership", async () => {
  await withRoot("motion-crash-", async root => {
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
    } finally { await stop(successor); await stop(killed); }
  });
});

test("oversized evidence is read once with a bound, rejected, and preserved", async () => {
  await withRoot("motion-bounded-", async root => {
    const lockPath = join(root, lockName);
    const hostile = Buffer.alloc(64 * 1024, 65);
    await writeFile(lockPath, hostile, { mode: 0o600 });
    const original = fs.readSync;
    const lengths = [];
    fs.readSync = function(fd, buffer, offset, length, position) { lengths.push(length); return original(fd, buffer, offset, length, position); };
    syncBuiltinESMExports();
    try {
      const { acquireNativeServiceLock } = await import(`../native-service-lock.mjs?bounded=${Date.now()}`);
      await assert.rejects(acquireNativeServiceLock(root), error => error?.code === "MOTION_DATA_ROOT_BUSY");
    } finally {
      fs.readSync = original;
      syncBuiltinESMExports();
    }
    assert.deepEqual(lengths.filter(length => length === 4097), [4097]);
    assert.deepEqual(await readFile(lockPath), hostile);
  });
});

test("symlink and unrelated hard-link evidence fail closed without mutation", async () => {
  for (const kind of ["symlink", "hardlink"]) {
    await withRoot(`motion-hostile-${kind}-`, async root => {
      const lockPath = join(root, lockName);
      const target = join(root, "hostile-target");
      await writeFile(target, "hostile", { mode: 0o600 });
      if (kind === "symlink") await fs.promises.symlink(target, lockPath);
      else await link(target, lockPath);
      const before = await lstat(lockPath);
      const owner = startWorker(root, join(root, "mutations.log"));
      try { assert.deepEqual(await owner.next(), busy); }
      finally { await stop(owner); }
      const after = await lstat(lockPath);
      assert.deepEqual({ dev: after.dev, ino: after.ino, nlink: after.nlink }, { dev: before.dev, ino: before.ino, nlink: before.nlink });
      assert.equal(await readFile(target, "utf8"), "hostile");
    });
  }
});

test("foreign-owned evidence fails closed without mutation", async context => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) { context.skip("requires root to construct foreign-owned evidence"); return; }
  await withRoot("motion-hostile-owner-", async root => {
    const lockPath = join(root, lockName);
    await writeFile(lockPath, "hostile", { mode: 0o600 });
    await fs.promises.chown(lockPath, 1, 1);
    const before = await lstat(lockPath);
    const owner = startWorker(root, join(root, "mutations.log"));
    try { assert.deepEqual(await owner.next(), busy); }
    finally { await stop(owner); }
    const after = await lstat(lockPath);
    assert.deepEqual({ dev: after.dev, ino: after.ino, uid: after.uid }, { dev: before.dev, ino: before.ino, uid: before.uid });
  });
});

test("non-private evidence is rejected without chmod or overwrite", async () => {
  await withRoot("motion-hostile-mode-", async root => {
    const lockPath = join(root, lockName);
    await writeFile(lockPath, "hostile", { mode: 0o644 });
    const before = await stat(lockPath);
    const { acquireNativeServiceLock } = await import(`../native-service-lock.mjs?hostile-mode=${Date.now()}`);

    await assert.rejects(acquireNativeServiceLock(root), error => error?.code === "MOTION_DATA_ROOT_BUSY");

    const after = await stat(lockPath);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(await readFile(lockPath, "utf8"), "hostile");
  });
});

test("malformed owner-private evidence is replaced only after acquiring the root lock", async () => {
  await withRoot("motion-malformed-", async root => {
    const lockPath = join(root, lockName);
    await writeFile(lockPath, "{", { mode: 0o600 });
    const owner = startWorker(root, join(root, "mutations.log"));
    try {
      assert.deepEqual(await owner.next(), { type: "acquired" });
      assert.doesNotMatch(await readFile(lockPath, "utf8"), /^\{$/);
    } finally { await stop(owner); }
  });
});

test("final-path replacement survives refresh and release", async () => {
  for (const phase of ["refresh", "release"]) {
    await withRoot(`motion-final-${phase}-`, async root => {
      const lockPath = join(root, lockName);
      const displaced = join(root, "displaced.lock");
      const validEvidence = `${JSON.stringify({ schemaVersion: 1, pid: 1, nonce: "00000000-0000-4000-8000-000000000000" })}\n`;
      await writeFile(lockPath, validEvidence, { mode: 0o600 });
      const originalUnlink = fs.unlinkSync;
      let unlinkCalls = 0;
      fs.unlinkSync = function(path) {
        if (path === lockPath) {
          unlinkCalls += 1;
          renameSync(lockPath, displaced);
          writeFileSync(lockPath, validEvidence, { mode: 0o600 });
        }
        return originalUnlink(path);
      };
      syncBuiltinESMExports();
      try {
        const { acquireNativeServiceLock } = await import(`../native-service-lock.mjs?phase=${phase}-${Date.now()}`);
        const ownership = await acquireNativeServiceLock(root);
        if (phase === "refresh") await new Promise(resolve => setTimeout(resolve, 10));
        await ownership.release();
        assert.equal(unlinkCalls, 0, "ownership must never use pathname unlink");
        assert.ok((await readFile(lockPath, "utf8")).length > 0);
        const successor = startWorker(root, join(root, "mutations.log"));
        try { assert.deepEqual(await successor.next(), { type: "acquired" }); }
        finally { await stop(successor); }
      } finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); }
    });
  }
});

test("release is idempotent and a pathname replacement after validation survives", async () => {
  await withRoot("motion-release-replacement-", async root => {
    const { acquireNativeServiceLock } = await import("../native-service-lock.mjs");
    const ownership = await acquireNativeServiceLock(root);
    const lockPath = join(root, lockName);
    await rename(lockPath, join(root, "old.lock"));
    await writeFile(lockPath, "replacement", { mode: 0o600 });
    await ownership.release();
    await ownership.release();
    assert.equal(await readFile(lockPath, "utf8"), "replacement");
  });
});
