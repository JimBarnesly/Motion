import assert from "node:assert/strict";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBackup } from "@motion/backup";
import { createAtomicBackupFile, readAndVerifyBackupFile, serializeBackup } from "../../backup-file.mjs";
import { assertPrivateAcl, start, withRoot } from "./fixtures.mjs";

const bundle = process.env.MOTION_TEST_SERVICE_BUNDLE
  ?? fileURLToPath(new URL("../../dist/service-bundle.mjs", import.meta.url));

function startService(root) {
  const service = start(bundle, [root], { MOTION_SERVICE_START_GATE: "1" });
  service.send("MOTION_SERVICE_START");
  return service;
}

async function request(service, lane, payload) {
  service.send({ lane, payload });
  const reply = await service.next();
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}

test("Windows bundled service saves, closes pinned WAL/SHM, reopens, searches, and restores a native backup", { timeout: 90_000 }, () => withRoot(async parent => {
  const root = join(parent, "notebook data");
  const destination = join(parent, "verified.motion-backup.json");
  let first = startService(root); let second;
  try {
    const webV1 = { schemaVersion: 1, activePageId: "page-1", pages: [{
      id: "page-1", parentId: null, order: 0, type: "document", title: "Windows notebook",
      blocks: [{ id: "block-1", type: "paragraph", text: "Initial notebook" }]
    }] };
    assert.equal((await request(first, "web-v1-import", { type: "workspace.import-web-v1", document: webV1 })).saved, true);
    const loaded = await request(first, "ui-load", { schemaVersion: 2 });
    assert.equal(loaded.workspace.pages[0].blocks[0].text, "Initial notebook");
    const workspaceId = loaded.workspace.id;
    const edited = await request(first, "command", { type: "block.update-content", workspaceId,
      expectedRevision: loaded.revision, pageId: "page-1", blockId: "block-1", content: { text: "Persisted after Windows restart" } });
    assert.equal(edited.saved, true);
    await request(first, "ui-save", { schemaVersion: 2, document: { workspaceId, activePageId: "page-1", expandedPageIds: ["page-1"], activeViewIds: {} } });
    // Repeated saves must replace the existing private state through the same
    // supported native path, including when CI runs with an elevated token.
    await request(first, "ui-save", { schemaVersion: 2, document: { workspaceId, activePageId: "page-1", expandedPageIds: [], activeViewIds: {} } });
    assert.deepEqual((await request(first, "ui-load", { schemaVersion: 2 })).expandedPageIds, []);
    await request(first, "ui-save", { schemaVersion: 2, document: { workspaceId, activePageId: "page-1", expandedPageIds: ["page-1"], activeViewIds: {} } });
    assert.deepEqual((await request(first, "ui-load", { schemaVersion: 2 })).expandedPageIds, ["page-1"]);
    const backup = await request(first, "async-query", { type: "backup.create", workspaceId });
    assert.deepEqual(await request(first, "native-backup-inspect", { destination }), { exists: false, replacement: false });
    const saved = await request(first, "native-backup-save", { destination, replaceConfirmed: false, bundle: backup });
    assert.equal(saved.path, destination);
    assert.ok(saved.byteLength > 0);
    // Exercise the exact native replacement path used by the desktop dialog.
    const inspected = await request(first, "native-backup-inspect", { destination });
    assert.match(inspected.replacementIdentity, /^[a-f0-9]{64}$/);
    const replacement = await request(first, "native-backup-save", { destination, replaceConfirmed: true,
      expectedIdentity: inspected.replacementIdentity, bundle: backup });
    assert.equal(replacement.path, destination);
    await first.finish(); first = null;

    for (const name of ["motion.sqlite3", "motion.sqlite3-wal", "motion.sqlite3-shm", "ui-state.json"]) {
      assert.equal((await lstat(join(root, name))).isFile(), true);
      assertPrivateAcl(join(root, name));
    }
    assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });
    assert.ok((await readFile(join(root, "motion.sqlite3"))).byteLength > 0);

    second = startService(root);
    const reopened = await request(second, "ui-load", { schemaVersion: 2 });
    assert.equal(reopened.workspace.id, workspaceId);
    assert.equal(reopened.workspace.pages[0].blocks[0].text, "Persisted after Windows restart");
    assert.equal(reopened.activePageId, "page-1");
    assert.deepEqual(reopened.expandedPageIds, ["page-1"]);
    const search = await request(second, "query", { type: "workspace.search", workspaceId, query: "Persisted" });
    assert.ok(search.some(hit => hit.entityId === "block-1" || hit.ownerEntityId === "page-1"), JSON.stringify(search));
    const restored = await request(second, "async-command", { type: "backup.restore-new", bundle: backup, newWorkspaceId: "windows-restored" });
    assert.equal(restored.workspace.id, "windows-restored");
    const selected = await request(second, "ui-load", { schemaVersion: 2 });
    assert.equal(selected.workspace.id, "windows-restored");
    assert.equal(selected.workspace.pages[0].blocks[0].text, "Persisted after Windows restart");
    await second.finish(); second = null;
  } finally { await first?.stop(); await second?.stop(); }
}));

test("Windows native dialog inspection remains bound to the confirmed file identity across separate service requests", { timeout: 60_000 }, () => withRoot(async parent => {
  const service = startService(join(parent, "dialog state"));
  const destination = join(parent, "dialog-selected.json");
  const externalBundle = createBackup({ schemaVersion: 1, id: "external-workspace", name: "Changed while the dialog was open",
    pages: [], databases: [], attachments: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  }, [], "2026-01-01T00:00:00Z");
  const changed = serializeBackup(externalBundle);
  const rejectedSave = async (payload, code) => {
    service.send({ lane: "native-backup-save", payload });
    const reply = await service.next();
    assert.equal(reply.ok, false, "A stale dialog inspection must never authorize a fresh snapshot");
    assert.equal(reply.error.code, code);
  };
  try {
    const created = await request(service, "command", { type: "workspace.create", name: "Dialog backup" });
    const bundle = await request(service, "async-query", { type: "backup.create", workspaceId: created.workspace.id });
    await request(service, "native-backup-save", { destination, replaceConfirmed: false, bundle });
    const first = await request(service, "native-backup-inspect", { destination });
    assert.match(first.replacementIdentity, /^[a-f0-9]{64}$/);
    await rejectedSave({ destination, replaceConfirmed: true, bundle }, "INVALID_INPUT");
    await rejectedSave({ destination, replaceConfirmed: false, expectedIdentity: first.replacementIdentity, bundle }, "INVALID_INPUT");

    // The native host displays its Yes/No dialog between these two requests.
    // A fresh canonical backup appearing during that interval is not approved.
    await writeFile(destination, changed);
    await rejectedSave({ destination, replaceConfirmed: true, expectedIdentity: first.replacementIdentity, bundle }, "STORAGE_FAILURE");
    assert.deepEqual(await readFile(destination), changed);

    const second = await request(service, "native-backup-inspect", { destination });
    const moved = join(parent, "preserved-dialog-target.json");
    await rename(destination, moved);
    await createAtomicBackupFile(destination, externalBundle);
    await rejectedSave({ destination, replaceConfirmed: true, expectedIdentity: second.replacementIdentity, bundle }, "STORAGE_FAILURE");
    assert.deepEqual(await readFile(moved), changed);
    assert.deepEqual(await readFile(destination), changed, "Same bytes in a different object must not inherit approval");

    const current = await request(service, "native-backup-inspect", { destination });
    await request(service, "native-backup-save", { destination, replaceConfirmed: true,
      expectedIdentity: current.replacementIdentity, bundle });
    assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });

    const late = join(parent, "dialog-late-collision.json");
    assert.deepEqual(await request(service, "native-backup-inspect", { destination: late }), { exists: false, replacement: false });
    await createAtomicBackupFile(late, externalBundle);
    await rejectedSave({ destination: late, replaceConfirmed: false, bundle }, "STORAGE_FAILURE");
    assert.deepEqual(await readFile(late), changed);
    await service.finish();
  } finally { await service.stop(); }
}));

test("Windows bundled service rejects a second writer before a queued mutation", { timeout: 45_000 }, () => withRoot(async parent => {
  const root = join(parent, "single writer"); const first = startService(root); let contender;
  try {
    const workspace = await request(first, "command", { type: "workspace.create", name: "Original writer" });
    contender = startService(root);
    contender.send({ lane: "command", payload: { type: "workspace.create", name: "Must not exist" } });
    assert.notEqual((await contender.exited)[0], 0);
    const summaries = await request(first, "query", { type: "workspace.list" });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, workspace.workspace.id);
    await first.finish();
  } finally { await contender?.stop(); await first.stop(); }
}));
