import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { link, lstat, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import test from "node:test";
import { createBackup } from "@motion/backup";
import { invokeWindowsNativeHelper } from "@motion/storage";
import { createAtomicBackupFile, inspectAtomicBackupDestination, readAndVerifyBackupFile, serializeBackup } from "../../backup-file.mjs";
import { assertPrivateAcl, withRoot } from "./fixtures.mjs";

const workspace = { schemaVersion: 1, id: "workspace", name: "Windows backup", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", pages: [], databases: [], attachments: [] };
const backup = name => createBackup({ ...workspace, name }, [], "2026-01-01T00:00:00Z");

function prepareNativeWriter() {
  // Both real helper processes wait for EOF before parsing a request. The test
  // can start them together without adding timing hooks to production code.
  const child = spawn(process.env.MOTION_NATIVE_HELPER, ["--motion-native-helper"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 30_000, killSignal: "SIGKILL"
  });
  const ready = once(child, "spawn"); const closed = once(child, "close");
  let output = "";
  child.stdout.setEncoding("utf8").on("data", chunk => {
    if (output.length + chunk.length > 32_768) { child.kill("SIGKILL"); return; }
    output += chunk;
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  return {
    ready,
    async save(request) {
      child.stdin.end(JSON.stringify({ protocol: 1, operation: "backup.save", ...request }));
      const [code, signal] = await closed;
      assert.equal(signal, null, "Native backup writer must finish within its bounded timeout");
      const reply = JSON.parse(output);
      assert.equal(reply.protocol, 1);
      assert.equal(code, reply.ok ? 0 : 1);
      return reply;
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  };
}

test("Windows backup publication flushes exact canonical bytes and uses a private DACL", { timeout: 30_000 }, () => withRoot(async root => {
  const destination = join(root, "workspace.motion-backup.json"); const bundle = backup("Original");
  assert.deepEqual(await inspectAtomicBackupDestination(destination), { exists: false, replacement: false });
  const result = await createAtomicBackupFile(destination, bundle);
  assert.equal(result.byteLength, serializeBackup(bundle).byteLength);
  assert.deepEqual(await readFile(destination), serializeBackup(bundle));
  assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });
  const { replacementIdentity, ...inspection } = await inspectAtomicBackupDestination(destination);
  assert.deepEqual(inspection, { exists: true, replacement: true });
  assert.match(replacementIdentity, /^[a-f0-9]{64}$/);
  assert.equal((await lstat(destination)).nlink, 1);
  assertPrivateAcl(destination);
  assert.equal((await readdir(root)).filter(name => name.endsWith(".tmp")).length, 0);
}));

test("Windows confirmed atomic replacement succeeds and cancellation preserves bytes", { timeout: 30_000 }, () => withRoot(async root => {
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
    // Identical bytes in a different file must still fail the retained identity
    // check, rather than passing through a content-only comparison.
    await createAtomicBackupFile(destination, backup("Changed outside transaction"));
    return true;
  } }));
  assert.deepEqual(await readFile(moved), changed);
  assert.deepEqual(await readFile(destination), changed);
}));

test("Windows concurrent Motion replacements publish one complete winner and readers observe only complete payloads", { timeout: 45_000 }, () => withRoot(async root => {
  const destination = join(root, "concurrent.json");
  await createAtomicBackupFile(destination, backup("Original"));
  const original = await readFile(destination);
  const inspected = invokeWindowsNativeHelper({ operation: "backup.inspect", path: destination });
  assert.equal(inspected.exists, true);
  const payloads = ["A", "B"].map(letter => serializeBackup(createBackup({ ...workspace, name: `Writer ${letter}`,
    pages: [{ id: "page-1", title: "Writing sample", parentId: null,
      blocks: [{ id: "block-1", type: "paragraph", text: letter.repeat(256 * 1024) }] }]
  }, [], "2026-01-01T00:00:00Z")));
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const allowed = new Set([original, ...payloads].map(digest));
  const writers = payloads.map(() => prepareNativeWriter());
  let finished = false; let samples = 0; let observations;
  try {
    await Promise.all(writers.map(writer => writer.ready));
    // Both requests carry the exact same previously confirmed identity. The
    // native per-destination lease serializes Motion writers; the later writer
    // must reject its stale identity if the first has already completed.
    const replies = Promise.all(writers.map((writer, index) => writer.save({ path: destination,
      contents: payloads[index].toString("utf8"), expectedIdentity: inspected.identity })))
      .finally(() => { finished = true; });
    observations = (async () => {
      do {
        assert.ok(allowed.has(digest(await readFile(destination))),
          "A reader observed truncated or mixed backup bytes during replacement");
        samples += 1;
        await yieldTurn();
      } while (!finished);
    })();
    const [outcomes] = await Promise.all([replies, observations]);
    const winners = outcomes.flatMap((reply, index) => reply.ok ? [index] : []);
    assert.equal(winners.length, 1, "Only one replacement of the confirmed identity may succeed");
    const winner = winners[0]; const loser = outcomes[1 - winner];
    assert.ok(["EBUSY", "INVALID_INPUT", "IDENTITY_CHANGED"].includes(loser.error.code), JSON.stringify(loser));
    assert.equal(outcomes[winner].result.byteLength, payloads[winner].byteLength);
    assert.equal(digest(await readFile(destination)), digest(payloads[winner]));
    assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });
    assert.ok(samples > 0);
    assert.equal((await lstat(destination)).nlink, 1);
    assert.equal((await readdir(root)).filter(name => name.endsWith(".tmp")).length, 0);
  } finally {
    finished = true;
    await Promise.all(writers.map(writer => writer.stop()));
    await observations?.catch(() => {});
  }
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
