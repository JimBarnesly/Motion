import assert from "node:assert/strict";
import { link, lstat, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createBackup } from "@motion/backup";
import { invokeWindowsNativeHelper } from "@motion/storage";
import { createAtomicBackupFile, inspectAtomicBackupDestination, readAndVerifyBackupFile, serializeBackup } from "../../backup-file.mjs";
import { assertPrivateAcl, withRoot } from "./fixtures.mjs";

const workspace = { schemaVersion: 1, id: "workspace", name: "Windows backup", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", pages: [], databases: [], attachments: [] };
const backup = name => createBackup({ ...workspace, name }, [], "2026-01-01T00:00:00Z");

test("Windows backup publication flushes exact canonical bytes and uses a private DACL", { timeout: 30_000 }, () => withRoot(async root => {
  const destination = join(root, "workspace.motion-backup.json"); const bundle = backup("Original");
  assert.deepEqual(await inspectAtomicBackupDestination(destination), { exists: false, replacement: false });
  const result = await createAtomicBackupFile(destination, bundle);
  assert.equal(result.byteLength, serializeBackup(bundle).byteLength);
  assert.deepEqual(await readFile(destination), serializeBackup(bundle));
  assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });
  assert.deepEqual(await inspectAtomicBackupDestination(destination), { exists: true, replacement: true });
  assert.equal((await lstat(destination)).nlink, 1);
  assertPrivateAcl(destination);
  assert.equal((await readdir(root)).filter(name => name.endsWith(".tmp")).length, 0);
}));

test("Windows held-handle atomic replacement succeeds after confirmation and cancellation preserves bytes", { timeout: 30_000 }, () => withRoot(async root => {
  const destination = join(root, "replace.json"); const neighbour = join(root, "neighbour.txt");
  await writeFile(neighbour, "preserve");
  await createAtomicBackupFile(destination, backup("Original"));
  const original = await readFile(destination);
  assert.deepEqual(await createAtomicBackupFile(destination, backup("Cancelled"), { confirmReplace: async () => false }),
    { cancelled: true, path: destination });
  assert.deepEqual(await readFile(destination), original);
  let confirmation;
  await createAtomicBackupFile(destination, backup("Replacement"), { confirmReplace: async value => { confirmation = value; return true; } });
  assert.deepEqual(confirmation, { path: destination });
  assert.deepEqual(await readFile(destination), serializeBackup(backup("Replacement")));
  assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });
  assertPrivateAcl(destination);
  assert.equal(await readFile(neighbour, "utf8"), "preserve");
  assert.equal((await lstat(destination)).nlink, 1);
}));

test("Windows replacement reauthenticates file identity and content after the confirmation callback", { timeout: 30_000 }, () => withRoot(async root => {
  const destination = join(root, "changed.json");
  await createAtomicBackupFile(destination, backup("Original"));
  const changed = serializeBackup(backup("Changed outside transaction"));
  await assert.rejects(createAtomicBackupFile(destination, backup("Must not replace"), { confirmReplace: async () => {
    await writeFile(destination, changed); return true;
  } }));
  assert.deepEqual(await readFile(destination), changed);
  const moved = join(root, "moved-original.json");
  await assert.rejects(createAtomicBackupFile(destination, backup("Must not replace redirected name"), { confirmReplace: async () => {
    await rename(destination, moved);
    await createAtomicBackupFile(destination, backup("New identity"));
    return true;
  } }));
  assert.deepEqual(await readFile(moved), changed);
  assert.deepEqual(await readFile(destination), serializeBackup(backup("New identity")));
}));

test("Windows late collisions, invalid verification, and malformed ownership evidence never overwrite targets", { timeout: 30_000 }, () => withRoot(async root => {
  const destination = join(root, "collision.json"); await createAtomicBackupFile(destination, backup("Original"));
  const original = await readFile(destination);
  await assert.rejects(createAtomicBackupFile(destination, backup("No confirmation")), /already exists/);
  await assert.rejects(createAtomicBackupFile(destination, backup("Invalid verification"), {
    confirmReplace: async () => true, verify: async () => ({ valid: false, errors: ["injected integrity failure"] })
  }));
  assert.deepEqual(await readFile(destination), original);
  const invalid = backup("Invalid bundle"); invalid.manifest.files[0].sha256 = "0".repeat(64);
  await assert.rejects(createAtomicBackupFile(join(root, "invalid.json"), invalid));
  await assert.rejects(lstat(join(root, "invalid.json")), { code: "ENOENT" });
  const unknown = join(root, "unknown.json"); const legacy = `${unknown}.motion-backup.lock`;
  await writeFile(legacy, "unowned old lock evidence");
  await assert.rejects(createAtomicBackupFile(unknown, backup("Must not publish")));
  assert.equal(await readFile(legacy, "utf8"), "unowned old lock evidence");
  await assert.rejects(lstat(unknown), { code: "ENOENT" });
}));

test("Windows backup reader and publisher reject hard-links, junction parents, and alternate streams", { timeout: 30_000 }, () => withRoot(async root => {
  const valid = join(root, "valid.json"); await createAtomicBackupFile(valid, backup("Original"));
  const linked = join(root, "alias.json"); await link(valid, linked);
  const before = await readFile(valid);
  assert.equal((await readAndVerifyBackupFile(linked)).valid, false);
  await assert.rejects(createAtomicBackupFile(linked, backup("Rejected"), { confirmReplace: async () => true }));
  assert.deepEqual(await readFile(valid), before);
  const directory = join(root, "actual");
  invokeWindowsNativeHelper({ operation: "private.directory", path: directory, create: true });
  const junction = join(root, "junction"); await symlink(directory, junction, "junction");
  await assert.rejects(createAtomicBackupFile(join(junction, "rejected.json"), backup("Rejected")));
  await assert.rejects(lstat(join(directory, "rejected.json")), { code: "ENOENT" });
  const streamHost = join(root, "stream-host"); await writeFile(streamHost, "preserve");
  await assert.rejects(createAtomicBackupFile(`${streamHost}:backup`, backup("Rejected")));
  assert.equal(await readFile(streamHost, "utf8"), "preserve");
}));

test("Windows no-replace publishing cannot replace an object created after inspection", { timeout: 30_000 }, () => withRoot(async root => {
  const destination = join(root, "native-race.json");
  assert.deepEqual(invokeWindowsNativeHelper({ operation: "backup.inspect", path: destination }), { exists: false });
  await createAtomicBackupFile(destination, backup("Won race"));
  const winner = await readFile(destination);
  assert.throws(() => invokeWindowsNativeHelper({ operation: "backup.save", path: destination,
    contents: serializeBackup(backup("Losing writer")).toString("utf8") }));
  assert.deepEqual(await readFile(destination), winner);
}));
