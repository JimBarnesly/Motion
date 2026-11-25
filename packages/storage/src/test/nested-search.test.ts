import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspace, WorkspaceDocument, type Workspace } from "@motion/core";
import { SqliteWorkspaceStore, type SearchHit, type WorkspaceChangeSet } from "../index.js";

function fixture(workspaceId = "nested-search-workspace"): Workspace {
  const timestamp = "2026-11-25T00:00:00.000Z";
  const workspace = { ...createWorkspace("Unrelated workspace"), id: workspaceId, createdAt: timestamp, updatedAt: timestamp };
  workspace.pages = [
    { id: "page-one", parentId: null, title: "Unrelated first title", createdAt: timestamp, updatedAt: timestamp, blocks: [
      { id: "root-toggle", type: "toggle", text: "rootcanary", children: [
        { id: "child-callout", type: "callout", text: "childcanary", children: [
          { id: "grandchild-paragraph", type: "paragraph", text: "grandchildcanary", children: [] }
        ] }
      ], unknownData: { note: { id: "opaque-note", text: "opaquecanary", children: [
        { id: "opaque-child", text: "opaquechildcanary", children: [] }
      ] }, blocks: [
        { id: "opaque-block-root", text: "opaqueblockrootcanary", children: [
          { id: "opaque-block-child", text: "opaqueblockchildcanary", children: [] }
        ] }
      ] } }
    ] },
    { id: "page-two", parentId: null, title: "Unrelated second title", createdAt: timestamp, updatedAt: timestamp, blocks: [
      { id: "stable-toggle", type: "toggle", text: "stableheadercanary", children: [
        { id: "stable-child", type: "paragraph", text: "untouchedcanary", children: [] }
      ] }
    ] }
  ];
  // Validate the exact stored shape; these queries match Block.text, never a title or command content object.
  return new WorkspaceDocument(workspace).data;
}

const targets = (hits: readonly SearchHit[]) => hits.map(({ entityId, entityType, ownerEntityId }) => ({ entityId, entityType, ownerEntityId }));
function expectBlock(store: SqliteWorkspaceStore, workspaceId: string, query: string, entityId: string, ownerEntityId = "page-one") {
  const hits = store.search(query, workspaceId);
  assert.deepEqual(targets(hits), [{ entityId, entityType: "block", ownerEntityId }]);
  assert.ok(hits[0]!.snippet.includes(query), "the hit must contain the unique block-text token");
}
const canonicalRows = (store: SqliteWorkspaceStore) => store.database.prepare(
  "SELECT workspace_id, schema_version, revision, document_json, updated_at FROM workspaces ORDER BY workspace_id"
).all();
const indexRows = (store: SqliteWorkspaceStore) => store.database.prepare(
  "SELECT rowid, * FROM workspace_search ORDER BY rowid"
).all();
const jobRows = (store: SqliteWorkspaceStore) => store.database.prepare(
  "SELECT * FROM reindex_jobs ORDER BY job_id"
).all();

test("canonical three-level block text retains the page owner and block target, while opaque children stay generic", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-nested-search-"));
  const store = new SqliteWorkspaceStore(join(root, "motion.sqlite3"));
  try {
    const workspace = fixture();
    store.save(workspace.id, workspace.schemaVersion, workspace, 0);
    expectBlock(store, workspace.id, "rootcanary", "root-toggle");
    expectBlock(store, workspace.id, "childcanary", "child-callout");
    expectBlock(store, workspace.id, "grandchildcanary", "grandchild-paragraph");
    expectBlock(store, workspace.id, "untouchedcanary", "stable-child", "page-two");
    assert.deepEqual(targets(store.search("opaquecanary", workspace.id)), [
      { entityId: "opaque-note", entityType: "entity", ownerEntityId: "page-one" }
    ]);
    assert.deepEqual(targets(store.search("opaquechildcanary", workspace.id)), [
      { entityId: "opaque-child", entityType: "entity", ownerEntityId: "page-one" }
    ]);
    assert.equal(store.search("opaqueblockchildcanary", workspace.id)[0]?.entityType, "entity",
      "a blocks key inside unknownData must not grant canonical ancestry to its children");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("opening a completed legacy index repairs nested targets once without changing canonical bytes or migration history", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-nested-search-repair-"));
  const path = join(root, "motion.sqlite3");
  let store = new SqliteWorkspaceStore(path);
  try {
    const first = fixture(), second = fixture("second-workspace");
    store.save(first.id, first.schemaVersion, first, 0);
    store.save(first.id, first.schemaVersion, first, 1);
    store.save(second.id, second.schemaVersion, second, 0);
    // Reproduce the released v5 state: completed jobs plus correctly indexed text with the old wrong target type.
    store.database.exec("DELETE FROM motion_migrations WHERE version > 5");
    store.database.exec("UPDATE workspace_search SET entity_type='entity' WHERE entity_id IN ('child-callout','grandchild-paragraph','stable-child')");
    store.database.exec("UPDATE reindex_jobs SET status='complete', completed_at='2026-11-24T00:00:00.000Z'");
    const before = canonicalRows(store);
    const oldMigrations = store.database.prepare("SELECT * FROM motion_migrations ORDER BY version").all();
    assert.equal(oldMigrations.length, 5);
    const historicalJob = store.database.prepare("SELECT * FROM reindex_jobs WHERE workspace_id=? AND workspace_revision=1").get(first.id);
    assert.equal(store.search("grandchildcanary", first.id)[0]?.entityType, "entity");
    store.close();

    store = new SqliteWorkspaceStore(path);
    for (const workspace of [first, second]) {
      expectBlock(store, workspace.id, "childcanary", "child-callout");
      expectBlock(store, workspace.id, "grandchildcanary", "grandchild-paragraph");
      expectBlock(store, workspace.id, "untouchedcanary", "stable-child", "page-two");
    }
    assert.deepEqual(canonicalRows(store), before, "JSON bytes, stored schema, revision and timestamp must remain exact");
    assert.deepEqual(store.database.prepare("SELECT * FROM motion_migrations WHERE version<=5 ORDER BY version").all(), oldMigrations);
    assert.deepEqual(store.database.prepare("SELECT * FROM reindex_jobs WHERE workspace_id=? AND workspace_revision=1").get(first.id), historicalJob);
    assert.equal((store.database.prepare("SELECT COUNT(*) count FROM reindex_jobs WHERE status='pending'").get() as { count: number }).count, 0);
    const repairedIndex = indexRows(store), repairedJobs = jobRows(store);
    const repairedMigrations = store.database.prepare("SELECT * FROM motion_migrations ORDER BY version").all();
    assert.equal(repairedMigrations.length, 6);
    store.close();

    store = new SqliteWorkspaceStore(path);
    assert.deepEqual(canonicalRows(store), before);
    assert.deepEqual(indexRows(store), repairedIndex, "a second open must not rebuild index rows");
    assert.deepEqual(jobRows(store), repairedJobs, "a second open must not reschedule completed repair work");
    assert.deepEqual(store.database.prepare("SELECT * FROM motion_migrations ORDER BY version").all(), repairedMigrations);
    expectBlock(store, first.id, "grandchildcanary", "grandchild-paragraph");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("nested text edits reindex only their owning page and roll back canonical data with search on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-nested-search-incremental-"));
  const path = join(root, "motion.sqlite3");
  let store = new SqliteWorkspaceStore(path);
  try {
    const workspace = fixture();
    store.save(workspace.id, workspace.schemaVersion, workspace, 0);
    const untouchedRows = () => store.database.prepare(
      "SELECT rowid, * FROM workspace_search WHERE workspace_id=? AND scope_type='page' AND scope_id='page-two' ORDER BY rowid"
    ).all(workspace.id);
    const beforeUntouched = untouchedRows();
    const changed = new WorkspaceDocument(workspace);
    changed.updateBlockContent("page-one", "grandchild-paragraph", { text: "replacementcanary" });
    const changeSet: WorkspaceChangeSet = { kind: "incremental", pages: ["page-one"], databases: [], attachments: [],
      linkSourcePageIds: ["page-one"], fts: [{ scope: "page", id: "page-one" }] };
    const write = { workspaceId: workspace.id, schemaVersion: workspace.schemaVersion, document: changed.data,
      expectedRevision: 1, changeSet };
    const before = canonicalRows(store), beforeIndex = indexRows(store);
    assert.throws(() => store.saveUnitOfWork({ ...write, beforeCommit: () => { throw new Error("injected nested reindex failure"); } }), /injected nested reindex failure/);
    assert.deepEqual(canonicalRows(store), before);
    assert.deepEqual(indexRows(store), beforeIndex);
    assert.equal(store.search("replacementcanary", workspace.id).length, 0);

    assert.equal(store.saveUnitOfWork(write), 2);
    assert.equal(store.search("grandchildcanary", workspace.id).length, 0);
    expectBlock(store, workspace.id, "replacementcanary", "grandchild-paragraph");
    expectBlock(store, workspace.id, "childcanary", "child-callout");
    expectBlock(store, workspace.id, "untouchedcanary", "stable-child", "page-two");
    assert.deepEqual(untouchedRows(), beforeUntouched);
    assert.deepEqual({ mode: store.lastWriteStats?.mode, pages: store.lastWriteStats?.pages, ftsScopes: store.lastWriteStats?.ftsScopes },
      { mode: "incremental", pages: 1, ftsScopes: 1 });
    assert.deepEqual(store.load(workspace.id)?.document, changed.data);
    store.close();
    store = new SqliteWorkspaceStore(path);
    expectBlock(store, workspace.id, "replacementcanary", "grandchild-paragraph");
    assert.equal(store.load(workspace.id)?.revision, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
