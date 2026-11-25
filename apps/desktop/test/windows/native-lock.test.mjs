import assert from "node:assert/strict";
import { link, lstat, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { invokeWindowsNativeHelper } from "@motion/storage";
import { assertPrivateAcl, start, waitForProcessExit, withRoot } from "./fixtures.mjs";

const worker = fileURLToPath(new URL("../fixtures/native-service-lock-worker.mjs", import.meta.url));
const leaseName = ".motion-service.owner-v2";
const owner = root => start(worker, [root, join(root, "mutations.log")], { MOTION_TEST_EXPOSE_GUARDIAN_PID: "1" });

test("Windows native handles enforce one writer and private root/database ACLs", { timeout: 45_000 }, () => withRoot(async parent => {
  const root = join(parent, "private data");
  const first = owner(root);
  let second;
  try {
    const acquired = await first.next();
    assert.equal(acquired.type, "acquired");
    assert.ok(Number.isSafeInteger(acquired.guardianPid));
    assertPrivateAcl(root);
    for (const name of [leaseName, "motion.sqlite3", "motion.sqlite3-wal", "motion.sqlite3-shm"]) {
      // Lease itself is exclusively open. Its ACL is checked by the native guard;
      // the database pins deliberately allow compatible read-only inspectors.
      if (name !== leaseName) assertPrivateAcl(join(root, name));
    }
    second = owner(root);
    assert.equal((await second.next()).code, "MOTION_DATA_ROOT_BUSY");
    await assert.rejects(readFile(join(root, "mutations.log")), { code: "ENOENT" });
    first.send("mutate");
    assert.deepEqual(await first.next(), { type: "mutated" });
    assert.equal(await readFile(join(root, "mutations.log"), "utf8"), "revision\n");
  } finally { await second?.stop(); await first.stop(); }
}));

test("Windows ownership survives attempted root, lease, and database pathname displacement", { timeout: 30_000 }, () => withRoot(async parent => {
  const root = join(parent, "data"); const first = owner(root); let second;
  try {
    assert.equal((await first.next()).type, "acquired");
    await assert.rejects(rename(root, join(parent, "displaced")));
    await assert.rejects(rename(join(root, leaseName), join(root, "displaced.lease")));
    await assert.rejects(rename(join(root, "motion.sqlite3"), join(root, "displaced.sqlite3")));
    await assert.rejects(writeFile(join(root, leaseName), "forged"));
    second = owner(root);
    assert.equal((await second.next()).code, "MOTION_DATA_ROOT_BUSY");
    first.send("mutate");
    assert.equal((await first.next()).type, "mutated");
  } finally { await second?.stop(); await first.stop(); }
}));

test("Windows owner termination releases its kernel lease without PID-file recovery", { timeout: 30_000 }, () => withRoot(async parent => {
  const root = join(parent, "data"); const first = owner(root); let successor;
  try {
    const acquired = await first.next();
    assert.equal(acquired.type, "acquired");
    first.child.kill("SIGKILL"); await first.closed;
    await waitForProcessExit(acquired.guardianPid);
    assert.equal((await lstat(join(root, leaseName))).size, 0, "The released kernel marker remains non-authoritative empty evidence");
    successor = owner(root);
    assert.equal((await successor.next()).type, "acquired");
    successor.send("mutate"); assert.equal((await successor.next()).type, "mutated");
  } finally { await successor?.stop(); await first.stop(); }
}));

test("killing the Windows guardian terminates an idle owner and releases its lease", { timeout: 30_000 }, () => withRoot(async parent => {
  const root = join(parent, "data"); const first = owner(root); let successor;
  try {
    const acquired = await first.next();
    assert.equal(acquired.type, "acquired");
    process.kill(acquired.guardianPid, "SIGKILL");
    assert.equal((await first.exited)[0], 74);
    await assert.rejects(readFile(join(root, "mutations.log")), { code: "ENOENT" });
    successor = owner(root); assert.equal((await successor.next()).type, "acquired");
  } finally { await successor?.stop(); await first.stop(); }
}));

test("Windows lease remains owned when the guardian dies while Node is synchronously blocked", { timeout: 45_000 }, () => withRoot(async parent => {
  const root = join(parent, "blocked-owner"); const first = owner(root); let contender; let successor;
  try {
    const acquired = await first.next();
    assert.equal(acquired.type, "acquired");
    first.send("block");
    assert.deepEqual(await first.next(), { type: "blocked" });
    process.kill(acquired.guardianPid, "SIGKILL");
    await waitForProcessExit(acquired.guardianPid);
    assert.equal(first.child.exitCode, null, "The parent must still be unable to handle the guardian exit event");
    contender = owner(root);
    assert.equal((await contender.next()).code, "MOTION_DATA_ROOT_BUSY",
      "Kernel ownership must outlive the guardian until the blocked Node process terminates");
    assert.equal(first.child.exitCode, null);
    await assert.rejects(rename(root, join(parent, "displaced-blocked-root")));
    await assert.rejects(rename(join(root, "motion.sqlite3"), join(root, "displaced-blocked.sqlite3")));
    first.child.kill("SIGKILL"); await first.closed;
    successor = owner(root);
    assert.equal((await successor.next()).type, "acquired");
  } finally { await successor?.stop(); await contender?.stop(); await first.stop(); }
}));

test("Windows junction roots, malformed leases, and hard-linked leases are rejected unchanged", { timeout: 45_000 }, () => withRoot(async parent => {
  const target = join(parent, "target");
  invokeWindowsNativeHelper({ operation: "private.directory", path: target, create: true });
  const junction = join(parent, "junction"); await symlink(target, junction, "junction");
  const linked = owner(junction);
  try { assert.equal((await linked.next()).code, "MOTION_DATA_ROOT_BUSY"); }
  finally { await linked.stop(); }
  await assert.rejects(lstat(join(target, "motion.sqlite3")), { code: "ENOENT" });
  for (const kind of ["malformed", "hard-link"]) {
    const root = join(parent, kind);
    // Establish genuine native ownership first, so this test rejects malformed
    // bytes/link counts rather than an elevated Node-created file's wrong owner.
    const initial = owner(root);
    try {
      assert.equal((await initial.next()).type, "acquired");
      initial.send("release"); assert.deepEqual(await initial.next(), { type: "released" });
    } finally { await initial.stop(); }
    for (const name of ["motion.sqlite3", "motion.sqlite3-wal", "motion.sqlite3-shm"]) await rm(join(root, name));
    const marker = join(root, leaseName); const bytes = kind === "malformed" ? "unowned evidence" : "";
    await writeFile(marker, bytes);
    if (kind === "hard-link") await link(marker, join(parent, "lease-alias"));
    const before = await readFile(marker); const bad = owner(root);
    try { assert.equal((await bad.next()).code, "MOTION_DATA_ROOT_BUSY"); }
    finally { await bad.stop(); }
    assert.deepEqual(await readFile(marker), before);
    await assert.rejects(lstat(join(root, "motion.sqlite3")), { code: "ENOENT" });
  }
}));
