import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { createBackup } from "@motion/backup";
import { cleanupStaleBackupFiles, createAtomicBackupFile, readAndVerifyBackupFile } from "../backup-file.mjs";

const workspace = { schemaVersion: 1, id: "workspace", name: "Atomic", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pages: [], databases: [], attachments: [] };
const bundle = createBackup(workspace, [], "2026-01-01T00:00:00Z");
const withRoot = async action => { const root = await mkdtemp(join(tmpdir(), "motion-backup-file-")); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } };
const fileEvidence = async path => {
  const metadata = await lstat(path);
  return { bytes: metadata.isFile() ? await readFile(path) : null, type: metadata.isFile() ? "file" : metadata.isSymbolicLink() ? "symlink" : "other",
    mode: metadata.mode, uid: metadata.uid, ino: metadata.ino, nlink: metadata.nlink };
};

test("complete flushed canonical backup is atomically published and verifies", () => withRoot(async root => {
  const destination = join(root, "workspace.motion-backup.json");
  await createAtomicBackupFile(destination, bundle);
  assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });
}));

test("truncation, forged metadata, digest mismatch, symlink and hard-link inputs fail without mutation", () => withRoot(async root => {
  const valid = join(root, "valid.json"); await createAtomicBackupFile(valid, bundle);
  const validBytes = await readFile(valid); const neighbour = join(root, "neighbour"); await writeFile(neighbour, "preserve", { mode: 0o640 });
  const cases = [];
  const truncated = join(root, "truncated.json"); await writeFile(truncated, validBytes.subarray(0, validBytes.byteLength - 8), { mode: 0o600 }); cases.push(truncated);
  for (const [name, mutate] of [
    ["forged", parsed => { parsed.manifest.workspaceId = "forged"; }],
    ["digest", parsed => { parsed.manifest.files[0].sha256 = "0".repeat(64); }],
  ]) { const path = join(root, `${name}.json`); const parsed = JSON.parse(validBytes); mutate(parsed); await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 }); cases.push(path); }
  const symbolic = join(root, "symbolic.json"); await symlink(valid, symbolic); cases.push(symbolic);
  const hard = join(root, "hard.json"); await link(valid, hard); cases.push(hard);
  for (const path of cases) {
    const beforeEntries = (await readdir(root)).sort(); const before = await fileEvidence(path); const neighbourBefore = await fileEvidence(neighbour);
    const result = await readAndVerifyBackupFile(path); assert.equal(result.valid, false, path);
    assert.deepEqual(await fileEvidence(path), before); assert.deepEqual(await fileEvidence(neighbour), neighbourBefore);
    assert.deepEqual((await readdir(root)).sort(), beforeEntries);
  }
}));

test("collision and symlink destination preserve existing targets", () => withRoot(async root => {
  const destination = join(root, "existing.json"); await writeFile(destination, "keep");
  await assert.rejects(createAtomicBackupFile(destination, bundle), /already exists/);
  assert.equal(await readFile(destination, "utf8"), "keep");
  const target = join(root, "target.json"); await writeFile(target, "target");
  const link = join(root, "link.json"); await symlink(target, link);
  await assert.rejects(createAtomicBackupFile(link, bundle), /symbolic link/);
  assert.equal(await readFile(target, "utf8"), "target");
  const lockDestination = join(root, "lock-link.json"); const lockTarget = join(root, "lock-target"); await writeFile(lockTarget, "lock-target");
  await symlink(lockTarget, `${lockDestination}.motion-backup.lock`);
  await assert.rejects(createAtomicBackupFile(lockDestination, bundle), /lock must not be a symbolic link/);
  assert.equal(await readFile(lockTarget, "utf8"), "lock-target");
}));

test("destination created immediately before publication is never overwritten", () => withRoot(async root => {
  const destination = join(root, "late-collision.json");
  const original = Buffer.from("created-by-another-writer");
  await assert.rejects(createAtomicBackupFile(destination, bundle, { beforePublish: async () => writeFile(destination, original) }), error => error?.code === "EEXIST");
  assert.deepEqual(await readFile(destination), original);
}));

test("unwritable/open, short-write, disk-full and verification failures publish nothing", () => withRoot(async root => {
  const cases = [
    ["short", { write: async () => ({ bytesWritten: 0 }) }],
    ["disk-full", { write: async (file, bytes, offset) => { if (offset) throw Object.assign(new Error("injected full device"), { code: "ENOSPC" }); return file.write(bytes.subarray(0, 8), 0, 8, 0); } }],
    ["verify", { verify: async () => ({ valid: false, errors: ["injected"] }) }],
    ["open", { openTemporary: async () => { throw Object.assign(new Error("injected unwritable destination"), { code: "EACCES" }); } }]
  ];
  for (const [name, options] of cases) {
    const destination = join(root, `${name}.json`);
    await assert.rejects(createAtomicBackupFile(destination, bundle, options));
    await assert.rejects(readFile(destination));
  }
}));

test("concurrent writers publish one complete backup without replacement", () => withRoot(async root => {
  const destination = join(root, "concurrent.json");
  const results = await Promise.allSettled([createAtomicBackupFile(destination, bundle), createAtomicBackupFile(destination, bundle)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });
}));

test("fresh and stale malformed locks remain byte-for-byte untouched", () => withRoot(async root => {
  for (const [name, stale, bytes, mode] of [
    ["fresh", false, Buffer.from("{incomplete"), 0o600],
    ["stale", true, Buffer.from('{"schemaVersion":1,"pid":"wrong"}\n'), 0o640]
  ]) {
    const destination = join(root, `${name}.json`); const lockPath = `${destination}.motion-backup.lock`;
    const temporary = join(root, `.${name}.json.motion-backup-malformed.tmp`); const temporaryBytes = Buffer.from("temporary-evidence");
    const nearby = join(root, `${name}-nearby`); await writeFile(nearby, "nearby", { mode: 0o640 });
    await writeFile(temporary, temporaryBytes, { mode: 0o600 }); await chmod(temporary, 0o600);
    await writeFile(lockPath, bytes, { mode }); await chmod(lockPath, mode);
    if (stale) await utimes(lockPath, new Date(0), new Date(0));
    const beforeEntries = (await readdir(root)).sort(); const beforeMode = (await stat(lockPath)).mode & 0o777;
    await assert.rejects(createAtomicBackupFile(destination, bundle), /malformed or unverifiable.*manually/i);
    assert.deepEqual(await readFile(lockPath), bytes); assert.equal((await stat(lockPath)).mode & 0o777, beforeMode);
    assert.deepEqual(await readFile(temporary), temporaryBytes); assert.equal((await stat(temporary)).mode & 0o777, 0o600);
    assert.equal(await readFile(nearby, "utf8"), "nearby"); assert.equal((await stat(nearby)).mode & 0o777, 0o640);
    assert.deepEqual((await readdir(root)).sort(), beforeEntries);
  }
}));

test("forged current PID with mismatched process identity remains blocked", () => withRoot(async root => {
  const destination = join(root, "pid-reuse.json"); const lockPath = `${destination}.motion-backup.lock`;
  const nonce = "11111111-1111-4111-8111-111111111111"; const temporaryName = `.pid-reuse.json.motion-backup-${process.pid}-${nonce}.tmp`;
  const nearby = join(root, temporaryName); await writeFile(nearby, "do-not-remove", { mode: 0o600 }); await chmod(nearby, 0o600); const temporaryState = await stat(nearby);
  const metadata = { schemaVersion: 2, pid: process.pid, processStartToken: "1", createdAt: new Date().toISOString(), nonce, temporaryName,
    temporaryDev: temporaryState.dev, temporaryIno: temporaryState.ino };
  const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`); await writeFile(lockPath, bytes, { mode: 0o600 }); await chmod(lockPath, 0o600);
  await assert.rejects(createAtomicBackupFile(destination, bundle), /not a verifiable PID reuse.*manually/i);
  assert.deepEqual(await readFile(lockPath), bytes); assert.equal(await readFile(nearby, "utf8"), "do-not-remove");
}));

test("SIGKILL lock recovery permits retry and unowned temporary cleanup fails closed", () => withRoot(async root => {
  const destination = join(root, "interrupted.json");
  const child = spawn(process.execPath, [new URL("./fixtures/backup-interrupt-worker.mjs", import.meta.url).pathname, destination], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  const lockPath = `${destination}.motion-backup.lock`;
  const ownership = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(ownership.schemaVersion, 2); assert.equal(ownership.pid, child.pid);
  assert.match(ownership.processStartToken, /^\d+$/); assert.match(ownership.nonce, /^[a-f0-9-]{36}$/);
  await utimes(lockPath, new Date(0), new Date(0));
  await assert.rejects(createAtomicBackupFile(destination, bundle), /active writer/);
  child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve));
  await assert.rejects(readFile(destination));
  await createAtomicBackupFile(destination, bundle);
  assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });
  const cleanupDestination = join(root, "cleanup.json");
  const stale = join(root, `.${cleanupDestination.split("/").at(-1)}.motion-backup-stale.tmp`); await writeFile(stale, "partial");
  await utimes(stale, new Date(0), new Date(0));
  const target = join(root, "outside-target"); await writeFile(target, "keep");
  const staleLink = join(root, `.${cleanupDestination.split("/").at(-1)}.motion-backup-link.tmp`); await symlink(target, staleLink);
  await assert.rejects(cleanupStaleBackupFiles(cleanupDestination), /left untouched.*manually/i);
  assert.equal(await readFile(stale, "utf8"), "partial"); assert.equal((await lstat(staleLink)).isSymbolicLink(), true);
  assert.equal(await readFile(target, "utf8"), "keep");
}));

test("dead-owner symlink and missing temporary evidence fail closed untouched", () => withRoot(async root => {
  const interrupt = async name => {
    const destination = join(root, `${name}.json`);
    const child = spawn(process.execPath, [new URL("./fixtures/backup-interrupt-worker.mjs", import.meta.url).pathname, destination], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
    child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve));
    const lockPath = `${destination}.motion-backup.lock`; const lockBytes = await readFile(lockPath);
    const ownership = JSON.parse(lockBytes); return { destination, lockPath, lockBytes, temporary: join(root, ownership.temporaryName) };
  };

  const symlinkCase = await interrupt("symlink-temp");
  const symlinkLockState = await stat(symlinkCase.lockPath);
  await rm(symlinkCase.temporary); const target = join(root, "symlink-target"); await writeFile(target, "target-bytes", { mode: 0o640 });
  await symlink(target, symlinkCase.temporary); const linkState = await lstat(symlinkCase.temporary);
  await assert.rejects(createAtomicBackupFile(symlinkCase.destination, bundle), /symbolic, or mismatched.*left untouched/i);
  assert.deepEqual(await readFile(symlinkCase.lockPath), symlinkCase.lockBytes); assert.equal((await lstat(symlinkCase.temporary)).isSymbolicLink(), true);
  assert.equal((await stat(symlinkCase.lockPath)).mode, symlinkLockState.mode); assert.equal((await stat(symlinkCase.lockPath)).isFile(), true);
  assert.equal((await lstat(symlinkCase.temporary)).mode, linkState.mode); assert.equal(await readFile(target, "utf8"), "target-bytes");

  const missingCase = await interrupt("missing-temp"); const missingLockState = await stat(missingCase.lockPath); await rm(missingCase.temporary);
  const entries = (await readdir(root)).sort();
  await assert.rejects(createAtomicBackupFile(missingCase.destination, bundle), /missing temporary.*left untouched/i);
  assert.deepEqual(await readFile(missingCase.lockPath), missingCase.lockBytes); await assert.rejects(lstat(missingCase.temporary), /ENOENT/);
  assert.equal((await stat(missingCase.lockPath)).mode, missingLockState.mode); assert.equal((await stat(missingCase.lockPath)).isFile(), true);
  assert.deepEqual((await readdir(root)).sort(), entries);
}));

test("foreign-owned recovery evidence fails closed without changing any filesystem evidence", () => withRoot(async root => {
  const testBundle = join(root, "foreign-ownership-backup-file.mjs");
  const replacement = new URL("./fixtures/foreign-ownership-filesystem.mjs", import.meta.url).pathname;
  await build({ entryPoints: [new URL("./fixtures/foreign-ownership-entry.mjs", import.meta.url).pathname], outfile: testBundle,
    bundle: true, platform: "node", format: "esm", target: "node24", plugins: [{ name: "test-only-foreign-ownership", setup(buildApi) {
      buildApi.onResolve({ filter: /backup-filesystem\.mjs$/ }, () => ({ path: replacement }));
    } }] });
  const foreignWriter = await import(`${pathToFileURL(testBundle).href}?${Date.now()}`);
  for (const target of ["lock", "temporary", "both"]) {
    const destination = join(root, `foreign-${target}.json`);
    const neighbour = join(root, `foreign-${target}.neighbour`);
    await writeFile(neighbour, `neighbour-${target}`, { mode: 0o640 }); await chmod(neighbour, 0o640);
    const child = spawn(process.execPath, [new URL("./fixtures/backup-interrupt-worker.mjs", import.meta.url).pathname, destination], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
    child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve));
    const lockPath = `${destination}.motion-backup.lock`;
    const ownership = JSON.parse(await readFile(lockPath, "utf8"));
    const temporary = join(root, ownership.temporaryName);
    const before = { lock: await fileEvidence(lockPath), temporary: await fileEvidence(temporary), neighbour: await fileEvidence(neighbour), entries: (await readdir(root)).sort() };

    foreignWriter.setForeignOwnershipTarget(target);
    await assert.rejects(foreignWriter.createAtomicBackupFile(destination, bundle), /malformed or unverifiable|temporary file is malformed/i);

    assert.deepEqual(await fileEvidence(lockPath), before.lock);
    assert.deepEqual(await fileEvidence(temporary), before.temporary);
    assert.deepEqual(await fileEvidence(neighbour), before.neighbour);
    assert.deepEqual((await readdir(root)).sort(), before.entries);
    await assert.rejects(lstat(destination), /ENOENT/);
  }
}));

test("environment spoofing and obsolete simulation options cannot alter production ownership checks", () => withRoot(async root => {
  const previous = process.env.NODE_TEST_CONTEXT; process.env.NODE_TEST_CONTEXT = "spoofed";
  try {
    const destination = join(root, "no-production-seam.json");
    await createAtomicBackupFile(destination, bundle, { simulateForeignOwnershipForTest: "both" });
    assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = previous;
  }
}));

test("production service bundle contains no backup failure-injection controls", async () => {
  const production = await readFile(new URL("../dist/service-bundle.mjs", import.meta.url), "utf8");
  for (const identifier of ["backup-interrupt-worker", "foreign-ownership-filesystem", "simulateForeignOwnershipForTest", "test-only-foreign-ownership"]) {
    assert.equal(production.includes(identifier), false, identifier);
  }
});
