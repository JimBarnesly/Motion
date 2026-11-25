import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readAndVerifyBackupFile } from "../../backup-file.mjs";
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
    const backup = await request(first, "async-query", { type: "backup.create", workspaceId });
    assert.deepEqual(await request(first, "native-backup-inspect", { destination }), { exists: false, replacement: false });
    const saved = await request(first, "native-backup-save", { destination, replaceConfirmed: false, bundle: backup });
    assert.equal(saved.path, destination);
    assert.ok(saved.byteLength > 0);
    // Exercise the exact native replacement path used by the desktop dialog.
    const replacement = await request(first, "native-backup-save", { destination, replaceConfirmed: true, bundle: backup });
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
