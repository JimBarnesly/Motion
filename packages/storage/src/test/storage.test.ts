import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore } from "../index.js";

test("SQLite workspace storage survives restart and rejects stale revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-storage-"));
  const path = join(root, "motion.sqlite3");
  try {
    const first = new SqliteWorkspaceStore(path);
    assert.equal(first.save("ws-1", 2, { title: "Offline" }, 0), 1);
    assert.throws(() => first.save("ws-1", 2, { title: "Stale" }, 0), /Revision conflict/);
    first.close();
    const reopened = new SqliteWorkspaceStore(path);
    assert.deepEqual(reopened.load("ws-1")?.document, { title: "Offline" });
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attachment storage is content-addressed, deduplicated, and verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-attachments-"));
  try {
    const store = new ContentAddressedAttachmentStore(root);
    const bytes = new TextEncoder().encode("owned locally");
    const first = await store.put(bytes);
    const second = await store.put(bytes);
    assert.equal(first.path, second.path);
    assert.deepEqual(Buffer.from(await store.get(first.sha256)), Buffer.from(bytes));
    assert.deepEqual(await readFile(first.path), Buffer.from(bytes));
    await assert.rejects(store.get("../../workspace.json"), /64 lowercase hexadecimal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attachment staging recovery promotes referenced content and removes abandoned staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-attachment-recovery-"));
  try {
    const store = new ContentAddressedAttachmentStore(root);
    const referenced = await store.stage(new TextEncoder().encode("metadata committed"));
    const abandoned = await store.stage(new TextEncoder().encode("metadata rolled back"));
    const report = await store.recover([referenced.sha256]);
    assert.deepEqual(report.promoted, [referenced.sha256]);
    assert.equal(report.removedStaging.some(name => name.startsWith(abandoned.sha256)), true);
    assert.deepEqual(report.missingReferenced, []);
    assert.deepEqual(Buffer.from(await store.get(referenced.sha256)), Buffer.from("metadata committed"));
    assert.deepEqual(await readdir(join(root, ".staging")), []);

    const orphan = await store.put(new TextEncoder().encode("unreferenced final blob"));
    const audit = await store.recover([referenced.sha256, "f".repeat(64)]);
    assert.deepEqual(audit.missingReferenced, ["f".repeat(64)]);
    assert.equal(audit.unreferencedBlobs.includes(orphan.sha256), true);
    assert.deepEqual(Buffer.from(await store.get(orphan.sha256)), Buffer.from("unreferenced final blob"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace write and FTS update roll back together", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-uow-"));
  const store = new SqliteWorkspaceStore(join(root, "motion.sqlite3"));
  try {
    store.save("ws", 1, { id: "page", title: "Original", text: "durable" }, 0);
    assert.throws(() => store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 1,
      document: { id: "page", title: "Broken", text: "vanish" }, expectedRevision: 1,
      afterWorkspaceWrite: () => { throw new Error("injected failure"); } }), /injected failure/);
    assert.equal(store.load("ws")?.revision, 1);
    assert.equal(store.search("durable").length, 1);
    assert.equal(store.search("vanish").length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("FTS survives restart and follows rename and deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-fts-"));
  const path = join(root, "motion.sqlite3");
  try {
    const first = new SqliteWorkspaceStore(path);
    first.save("ws", 1, { pages: [{ id: "p1", title: "Alpha", text: "needle" }] }, 0);
    first.close();
    const reopened = new SqliteWorkspaceStore(path);
    assert.equal(reopened.search("needle", "ws")[0]?.entityId, "p1");
    reopened.save("ws", 1, { pages: [{ id: "p1", title: "Beta", text: "replacement" }] }, 1);
    assert.equal(reopened.search("Alpha").length, 0);
    assert.equal(reopened.search("Beta").length, 1);
    reopened.remove("ws");
    assert.equal(reopened.search("Beta").length, 0);
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("hostile FTS syntax is tokenized and migrations are idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-migrations-"));
  const path = join(root, "motion.sqlite3");
  try {
    const first = new SqliteWorkspaceStore(path);
    first.save("ws", 1, { id: "p", title: "Quoted", text: "safe query" }, 0);
    assert.doesNotThrow(() => first.search('" OR * NEAR() - { }'));
    first.close();
    const second = new SqliteWorkspaceStore(path);
    const migrations = second.database.prepare("SELECT version FROM motion_migrations ORDER BY version").all() as { version: number }[];
    assert.deepEqual(migrations.map(({ version }) => version), [1, 2]);
    assert.throws(() => second.save("ws", 1, { id: "p", title: "stale" }, 0), /Revision conflict/);
    second.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
