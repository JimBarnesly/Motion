import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore } from "@motion/storage";
import { assertWorkspaceValue, migrateWebWorkspaceV1 } from "@motion/core";
import { createBackup, type WorkspaceSnapshot } from "@motion/backup";
import { MotionAppError, MotionAppService, toAppError } from "../index.js";

const databasePath = (name: string) => join(tmpdir(), `motion-app-service-${name}-${crypto.randomUUID()}.sqlite`);
const removeDatabase = async (path: string) => Promise.all([path, `${path}-wal`, `${path}-shm`].map(file => rm(file, { force: true })));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("private database path failures map to stable storage errors without internals", () => {
  const privatePath = `/private/workspace-${crypto.randomUUID()}.sqlite`;
  const mapped = toAppError(new Error(`Private file path has an unexpected type: ${privatePath}`));
  assert.equal(mapped.code, "STORAGE_FAILURE");
  assert.equal(mapped.message, "Local database operation failed");
  assert.equal(mapped.message.includes(privatePath), false);
  assert.equal(mapped.details, undefined);
});

test("mutation change sets use comparator-free deterministic ordering", async () => {
  const path = databasePath("comparator-free-change-set"); const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
  try {
    const created = service.execute({ type: "workspace.create", name: "Ordering" });
    let mutationSortCalls = 0; const originalSort = Array.prototype.sort;
    Array.prototype.sort = function(this: unknown[], compareFn?: (left: unknown, right: unknown) => number) {
      if (new Error().stack?.includes("MutationChangeSet.build")) mutationSortCalls++;
      return originalSort.call(this, compareFn);
    } as typeof Array.prototype.sort;
    try { service.execute({ type: "page.create", workspaceId: created.workspace.id, expectedRevision: created.revision, title: "Page" }); }
    finally { Array.prototype.sort = originalSort; }
    assert.equal(mutationSortCalls, 0);
  } finally { store.close(); await removeDatabase(path); }
});
const integrityHash = async (database: string, attachmentRoot: string): Promise<string> => {
  const digest = createHash("sha256");
  for (const file of [database, `${database}-wal`, `${database}-shm`]) {
    try { digest.update(file); digest.update(await readFile(file)); } catch { digest.update(`${file}:missing`); }
  }
  let entries: string[] = [];
  try { entries = (await readdir(attachmentRoot, { recursive: true })) as string[]; } catch { /* absent attachment root */ }
  for (const entry of entries.sort()) {
    const full = join(attachmentRoot, entry); const metadata = await stat(full);
    digest.update(entry); digest.update(String(metadata.mode & 0o777));
    if (metadata.isFile()) digest.update(await readFile(full));
  }
  return digest.digest("hex");
};

const runRestartWorker = async (args: readonly string[]) => {
  const worker = new URL("./fixtures/restart-worker.js", import.meta.url);
  const networkGuard = new URL("../../../../scripts/deny-network.cjs", import.meta.url);
  const child = spawn(process.execPath, [worker.pathname, ...args], {
    env: {
      ...process.env,
      MOTION_E2E_NETWORK_GUARD: "required",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${networkGuard.pathname}`].filter(Boolean).join(" ")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, `restart worker failed:\n${stderr}`);
  return JSON.parse(stdout) as Record<string, unknown>;
};

test("canonical vertical slice works offline across separate process launches", async () => {
  const path = databasePath("offline-restart-e2e");
  try {
    const created = await runRestartWorker(["create", path]);
    assert.equal(created.networkGuard, true);
    assert.equal(created.title, "Offline field notes");
    assert.equal(created.body, "Pump inspection completed without a network.");

    const reopened = await runRestartWorker(["reopen", path, String(created.workspaceId), String(created.pageId)]);
    assert.equal(reopened.networkGuard, true);
    assert.equal(reopened.title, created.title);
    assert.equal(reopened.body, created.body);
    assert.equal(reopened.searchMatched, true);
    assert.equal(reopened.exportMatched, true);
  } finally { await removeDatabase(path); }
});

test("committed vertical slice survives restart and supports search, backlinks, trash, restore and export", async () => {
  const path = databasePath("vertical");
  try {
    let store = new SqliteWorkspaceStore(path);
    let service = new MotionAppService(store);
    const created = service.execute({ type: "workspace.create", name: "Local notes" });
    assert.equal(created.saved, true);
    const workspaceId = created.workspace.id;
    let state = service.execute({ type: "page.create", workspaceId, expectedRevision: created.revision, title: "Home" });
    const homeId = state.workspace.pages[0]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Tasks", parentId: homeId });
    const tasksId = state.workspace.pages.find(page => page.title === "Tasks")!.id;
    state = service.execute({ type: "page.replace-blocks", workspaceId, expectedRevision: state.revision, pageId: homeId, blocks: [
      { id: "home-link", type: "paragraph", text: "Plan alpha in [[Tasks]]", children: [], references: [{ pageId: tasksId }] }
    ] });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: tasksId }).length, 1);
    assert.equal(service.query({ type: "workspace.search", workspaceId, query: "alpha" })[0]?.entityId, "home-link");

    store.close();
    store = new SqliteWorkspaceStore(path); service = new MotionAppService(store);
    const restarted = service.query({ type: "workspace.get", workspaceId });
    assert.equal(restarted.revision, state.revision);
    assert.equal(restarted.workspace.pages.find(page => page.id === tasksId)?.parentId, homeId);

    const trashed = service.execute({ type: "page.trash", workspaceId, expectedRevision: restarted.revision, pageId: tasksId });
    assert.ok(trashed.workspace.pages.find(page => page.id === tasksId)?.deletedAt);
    const restored = service.execute({ type: "page.restore", workspaceId, expectedRevision: trashed.revision, pageId: tasksId });
    assert.equal(restored.workspace.pages.find(page => page.id === tasksId)?.deletedAt, undefined);
    const exported = service.query({ type: "workspace.export", workspaceId });
    assert.ok(exported.files["workspace.json"]?.includes("Local notes"));
    store.close();
  } finally { await removeDatabase(path); }
});

test("stable duplicate-title backlink identity survives rename, move, trash, restore, restart and rebuild", async () => {
  const path = databasePath("stable-link-lifecycle");
  try {
    let store = new SqliteWorkspaceStore(path); let service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Stable links" }); const workspaceId = state.workspace.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Source" }); const sourceId = state.workspace.pages[0]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Project" }); const firstId = state.workspace.pages[1]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Project" }); const selectedId = state.workspace.pages[2]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Folder" }); const folderId = state.workspace.pages[3]!.id;
    state = service.execute({ type: "page.replace-blocks", workspaceId, expectedRevision: state.revision, pageId: sourceId, blocks: [
      { id: "selected-link", type: "paragraph", text: "See [[Project]]", children: [], references: [{ pageId: selectedId, start: 4, end: 15 }] }
    ] });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: firstId }).length, 0);
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: selectedId }).length, 1);

    state = service.execute({ type: "page.rename", workspaceId, expectedRevision: state.revision, pageId: selectedId, title: "Renamed" });
    state = service.execute({ type: "page.move", workspaceId, expectedRevision: state.revision, pageId: selectedId, parentId: folderId });
    state = service.execute({ type: "page.trash", workspaceId, expectedRevision: state.revision, pageId: selectedId });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: selectedId }).length, 1);
    state = service.execute({ type: "page.restore", workspaceId, expectedRevision: state.revision, pageId: selectedId });
    store.close(); store = new SqliteWorkspaceStore(path); service = new MotionAppService(store);
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: selectedId }).length, 1);
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: firstId }).length, 0);

    store.database.prepare("DELETE FROM workspace_links WHERE workspace_id=?").run(workspaceId);
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: selectedId }).length, 0,
      "backlink query must read the materialized table rather than scan canonical page blocks");
    store.database.prepare("UPDATE reindex_jobs SET status='pending', completed_at=NULL WHERE workspace_id=? AND workspace_revision=?").run(workspaceId, state.revision);
    assert.equal(store.runPendingReindexJobs(), 1);
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: selectedId }).length, 1);
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: firstId }).length, 0);
    store.close();
  } finally { await removeDatabase(path); }
});

test("legacy title backlinks follow unique and ambiguous title changes transactionally", async () => {
  const path = databasePath("legacy-title-link-uniqueness");
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Legacy title links" }); const workspaceId = state.workspace.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Source" }); const sourceId = state.workspace.pages[0]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Unique" }); const firstId = state.workspace.pages[1]!.id;
    state = service.execute({ type: "page.replace-blocks", workspaceId, expectedRevision: state.revision, pageId: sourceId,
      blocks: [{ id: "legacy-link", type: "paragraph", text: "See [[Unique]]", children: [] }] });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: firstId }).length, 1);

    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Unique" }); const duplicateId = state.workspace.pages[2]!.id;
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: firstId }).length, 0,
      "creating an ambiguity must remove the formerly unique backlink");
    assert.deepEqual(store.lastWriteStats, { mode: "incremental", pages: 1, databases: 0, attachments: 0,
      linkSources: 2, linksInserted: 0, ftsScopes: 1, ftsInserted: 1 });

    state = service.execute({ type: "page.rename", workspaceId, expectedRevision: state.revision, pageId: duplicateId, title: "Other" });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: firstId }).length, 1,
      "renaming the duplicate away must restore the unique backlink without INTERNAL_ERROR");

    state = service.execute({ type: "page.rename", workspaceId, expectedRevision: state.revision, pageId: firstId, title: "Renamed" });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: firstId }).length, 0,
      "renaming the unique target away must remove the persisted backlink");
    assert.equal(service.query({ type: "workspace.get", workspaceId }).workspace.linkIndex.length, 0);
    store.close();
  } finally { await removeDatabase(path); }
});

test("title changes rewrite only affected legacy link sources and leave canonical references stable", async () => {
  const path = databasePath("bounded-title-link-reindex");
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Bounded title links" }); const workspaceId = state.workspace.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Legacy source" }); const legacySourceId = state.workspace.pages[0]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Canonical source" }); const canonicalSourceId = state.workspace.pages[1]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Unrelated" }); const unrelatedId = state.workspace.pages[2]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Target" }); const targetId = state.workspace.pages[3]!.id;
    state = service.execute({ type: "page.replace-blocks", workspaceId, expectedRevision: state.revision, pageId: legacySourceId,
      blocks: [{ id: "legacy", type: "paragraph", text: "[[Target]]", children: [] }] });
    state = service.execute({ type: "page.replace-blocks", workspaceId, expectedRevision: state.revision, pageId: canonicalSourceId,
      blocks: [{ id: "canonical", type: "paragraph", text: "[[Target]]", children: [], references: [{ pageId: targetId, start: 0, end: 10 }] }] });

    state = service.execute({ type: "page.rename", workspaceId, expectedRevision: state.revision, pageId: targetId, title: "Renamed" });
    assert.deepEqual(service.query({ type: "page.backlinks", workspaceId, pageId: targetId }).map(link => link.sourcePageId), [canonicalSourceId]);
    assert.deepEqual(store.lastWriteStats, { mode: "incremental", pages: 1, databases: 0, attachments: 0,
      linkSources: 1, linksInserted: 0, ftsScopes: 1, ftsInserted: 1 });
    assert.equal(state.workspace.pages.find(page => page.id === unrelatedId)?.title, "Unrelated");
    store.close();
  } finally { await removeDatabase(path); }
});

test("record title changes update legacy backlinks with the same unique-title semantics", async () => {
  const path = databasePath("record-title-link-uniqueness");
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Record title links" }); const workspaceId = state.workspace.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Source" }); const sourceId = state.workspace.pages[0]!.id;
    state = service.execute({ type: "database.create", workspaceId, expectedRevision: state.revision, title: "Table" }); const databaseId = state.workspace.databases[0]!.id;
    state = service.execute({ type: "database.record-create", workspaceId, expectedRevision: state.revision, databaseId, title: "Record", values: {} });
    const recordId = state.workspace.pages.find(page => page.collectionId === databaseId)!.id;
    state = service.execute({ type: "page.replace-blocks", workspaceId, expectedRevision: state.revision, pageId: sourceId,
      blocks: [{ id: "record-legacy", type: "paragraph", text: "[[Record]]", children: [] }] });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: recordId }).length, 1);

    state = service.execute({ type: "database.record-create", workspaceId, expectedRevision: state.revision, databaseId, title: "Record", values: {} });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: recordId }).length, 0);
    const duplicateId = state.workspace.pages.filter(page => page.collectionId === databaseId && page.id !== recordId)[0]!.id;
    state = service.execute({ type: "database.record-update", workspaceId, expectedRevision: state.revision, pageId: duplicateId, title: "Other", values: {} });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: recordId }).length, 1);
    store.close();
  } finally { await removeDatabase(path); }
});

test("fine-grained block commands preserve structure and indexes across restart", async () => {
  const path = databasePath("block-commands");
  try {
    let store = new SqliteWorkspaceStore(path); let service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Blocks" }); const workspaceId = state.workspace.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Source" }); const sourceId = state.workspace.pages[0]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Target" }); const targetId = state.workspace.pages[1]!.id;
    state = service.execute({ type: "block.create", workspaceId, expectedRevision: state.revision, pageId: sourceId,
      position: { parentBlockId: null, beforeBlockId: null }, block: { id: "parent", type: "future-toggle", text: "Parent", children: [], unknownData: { plugin: { stable: true } } } });
    state = service.execute({ type: "block.create", workspaceId, expectedRevision: state.revision, pageId: sourceId,
      position: { parentBlockId: "parent", beforeBlockId: null }, block: { id: "child", type: "paragraph", text: "old", children: [] } });
    state = service.execute({ type: "block.update-content", workspaceId, expectedRevision: state.revision, pageId: sourceId, blockId: "child",
      content: { text: "indexed needle", references: [{ pageId: sourceId }] } });
    state = service.execute({ type: "block.transform", workspaceId, expectedRevision: state.revision, pageId: sourceId, blockId: "parent",
      transform: { type: "toggle" } });
    assert.deepEqual(state.workspace.pages[0]!.blocks[0]!.unknownData, { plugin: { stable: true } });
    state = service.execute({ type: "block.move", workspaceId, expectedRevision: state.revision, pageId: sourceId, blockId: "child",
      target: { pageId: targetId, parentBlockId: null, beforeBlockId: null } });
    assert.deepEqual(store.lastWriteStats, { mode: "incremental", pages: 2, databases: 0, attachments: 0,
      linkSources: 2, linksInserted: 1, ftsScopes: 2, ftsInserted: 7 });
    state = service.execute({ type: "block.create", workspaceId, expectedRevision: state.revision, pageId: targetId,
      position: { parentBlockId: null, beforeBlockId: null }, block: { id: "second", type: "paragraph", text: "Second", children: [] } });
    state = service.execute({ type: "block.indent", workspaceId, expectedRevision: state.revision, pageId: targetId, blockId: "second" });
    state = service.execute({ type: "block.outdent", workspaceId, expectedRevision: state.revision, pageId: targetId, blockId: "second" });
    state = service.execute({ type: "block.duplicate", workspaceId, expectedRevision: state.revision, pageId: targetId, blockId: "second", newBlockId: "second-copy" });
    state = service.execute({ type: "block.delete", workspaceId, expectedRevision: state.revision, pageId: targetId, blockId: "second-copy" });
    const backlink = service.query({ type: "page.backlinks", workspaceId, pageId: sourceId })[0];
    assert.deepEqual({ blockId: backlink?.blockId, sourcePageId: backlink?.sourcePageId }, { blockId: "child", sourcePageId: targetId });
    const searchHit = service.query({ type: "workspace.search", workspaceId, query: "needle" })[0];
    assert.deepEqual({ entityId: searchHit?.entityId, ownerEntityId: searchHit?.ownerEntityId }, { entityId: "child", ownerEntityId: targetId });
    store.close(); store = new SqliteWorkspaceStore(path); service = new MotionAppService(store);
    const reopened = service.query({ type: "workspace.get", workspaceId });
    assert.deepEqual(reopened.workspace.pages.find(page => page.id === targetId)?.blocks.map(block => block.id), ["child", "second"]);
    assert.equal(reopened.revision, state.revision); store.close();
  } finally { await removeDatabase(path); }
});

test("block.batch commits once and malformed batches roll back document, revision, links and FTS", async () => {
  const path = databasePath("block-batch");
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Batch" }); const workspaceId = state.workspace.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "One" }); const one = state.workspace.pages[0]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Two" }); const two = state.workspace.pages[1]!.id;
    const beforeRevision = state.revision;
    state = service.execute({ type: "block.batch", workspaceId, expectedRevision: state.revision, commands: [
      { type: "block.create", pageId: one, position: { parentBlockId: null, beforeBlockId: null }, block: { id: "batched", type: "paragraph", text: "atomic token", children: [] } },
      { type: "block.update-content", pageId: one, blockId: "batched", content: { text: "atomic linked token", references: [{ pageId: two }] } }
    ] });
    assert.equal(state.revision, beforeRevision + 1);
    assert.deepEqual(store.lastWriteStats, { mode: "incremental", pages: 1, databases: 0, attachments: 0,
      linkSources: 1, linksInserted: 1, ftsScopes: 1, ftsInserted: 3 });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: two }).length, 1);
    const before = structuredClone(store.load(workspaceId));
    assert.throws(() => service.execute({ type: "block.batch", workspaceId, expectedRevision: state.revision, commands: [
      { type: "block.create", pageId: one, position: { parentBlockId: null, beforeBlockId: null }, block: { id: "must-rollback", type: "paragraph", text: "rollback canary", children: [] } },
      { type: "block.move", pageId: one, blockId: "missing", target: { pageId: two, parentBlockId: null, beforeBlockId: null } }
    ] }), (error: unknown) => error instanceof MotionAppError && error.code === "NOT_FOUND");
    assert.deepEqual(store.load(workspaceId), before);
    assert.equal(service.query({ type: "workspace.search", workspaceId, query: "rollback canary" }).length, 0);
    assert.throws(() => service.execute({ type: "block.delete", workspaceId, expectedRevision: state.revision - 1, pageId: one, blockId: "batched" }),
      (error: unknown) => error instanceof MotionAppError && error.code === "REVISION_CONFLICT");
    assert.deepEqual(store.load(workspaceId), before);
    assert.throws(() => service.execute({ type: "block.batch", workspaceId, expectedRevision: state.revision, commands: [
      { type: "block.delete", pageId: one, blockId: "batched", unexpected: true }
    ] } as any), (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    assert.deepEqual(store.load(workspaceId), before); store.close();
  } finally { await removeDatabase(path); }
});

test("block command validation rejects typed-field mismatches, unsafe values and bounded payload attacks", async () => {
  const path = databasePath("block-input-validation");
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Validation" }); const workspaceId = state.workspace.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Page" }); const pageId = state.workspace.pages[0]!.id;
    const before = structuredClone(store.load(workspaceId));
    const create = (block: any) => service.execute({ type: "block.create", workspaceId, expectedRevision: state.revision, pageId, position: { parentBlockId: null, beforeBlockId: null }, block });
    for (const block of [
      { id: "task", type: "task", text: "", children: [] },
      { id: "paragraph", type: "paragraph", text: "", children: [], checked: false },
      { id: "image", type: "image", text: "", children: [] },
      { id: "mention", type: "page-mention", text: "", children: [] },
      { id: "date", type: "date-mention", text: "", children: [], date: "not-a-date" },
      { id: "bookmark", type: "bookmark", text: "", children: [], url: "file:///private/secret" },
      { id: "undefined", type: "code", text: "", children: [], language: undefined }
    ]) assert.throws(() => create(block), (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    const deep: any = { id: "depth-0", type: "toggle", text: "", children: [] }; let cursor = deep;
    for (let depth = 1; depth < 70; depth++) { const child = { id: `depth-${depth}`, type: "toggle", text: "", children: [] }; cursor.children = [child]; cursor = child; }
    assert.throws(() => create(deep), (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    const references = Array.from({ length: 100_001 }, () => ({ pageId }));
    assert.throws(() => create({ id: "refs", type: "paragraph", text: "", children: [], references }), (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    const tooWide = { id: "wide-root", type: "future-wide", text: "", children: new Array(1_000_000), unknownData: { preserved: true } };
    assert.throws(() => create(tooWide), (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    assert.throws(() => create({ id: "future", type: "future-widget", text: "", children: [], pageId: "unsafe page id", unknownData: { preserved: true } }),
      (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    assert.throws(() => create({ id: "future-long-id", type: "future-widget", text: "", children: [], pageId: "p".repeat(161), unknownData: { preserved: true } }),
      (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    assert.throws(() => service.execute(null as any), (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    assert.deepEqual(store.load(workspaceId), before);
    state = create({ id: "transform-target", type: "paragraph", text: "", children: [] });
    assert.throws(() => service.execute({ type: "block.transform", workspaceId, expectedRevision: state.revision, pageId, blockId: "transform-target", transform: { type: "task" } }), (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    state = service.execute({ type: "block.transform", workspaceId, expectedRevision: state.revision, pageId, blockId: "transform-target", transform: { type: "task", checked: true } });
    assert.equal(state.workspace.pages[0]?.blocks[0]?.checked, true);
    assert.throws(() => service.execute({ type: "block.transform", workspaceId, expectedRevision: state.revision, pageId, blockId: "transform-target", transform: { type: "paragraph", checked: false } }), (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    store.close();
  } finally { await removeDatabase(path); }
});

test("revision conflict writes neither document nor search index", async () => {
  const path = databasePath("conflict");
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    const created = service.execute({ type: "workspace.create", name: "Conflict test" });
    const page = service.execute({ type: "page.create", workspaceId: created.workspace.id, expectedRevision: created.revision, title: "Original" });
    assert.throws(() => service.execute({ type: "page.rename", workspaceId: created.workspace.id, expectedRevision: created.revision, pageId: page.workspace.pages[0]!.id, title: "Must not save" }),
      (error: unknown) => error instanceof MotionAppError && error.code === "REVISION_CONFLICT");
    const after = service.query({ type: "workspace.get", workspaceId: created.workspace.id });
    assert.equal(after.revision, page.revision);
    assert.equal(after.workspace.pages[0]?.title, "Original");
    assert.equal(service.query({ type: "workspace.search", workspaceId: created.workspace.id, query: "Must" }).length, 0);
    store.close();
  } finally { await removeDatabase(path); }
});

test("web v1 import is deterministic and preserves unsupported blocks", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../../../fixtures/web-workspace-v1.json", import.meta.url), "utf8"));
  const paths = [databasePath("import-a"), databasePath("import-b")];
  try {
    const outputs = paths.map(path => {
      const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
      const imported = service.execute({ type: "workspace.import-web-v1", document: fixture, workspaceId: "imported-web-v1", migratedAt: "1970-01-01T00:00:00.000Z" });
      const output = service.query({ type: "workspace.export", workspaceId: imported.workspace.id }).files["workspace.json"];
      assert.equal(imported.activePageId, "page-home");
      assert.equal(imported.workspace.pages[0]?.blocks[1]?.type, "unsupported");
      store.close(); return output;
    });
    assert.equal(outputs[0], outputs[1]);
  } finally { await Promise.all(paths.map(removeDatabase)); }
});

test("service restores boundary and migrated derived IDs into bounded canonical namespaces", async () => {
  const path = databasePath("bounded-restore-ids");
  try {
    const legacyId = "m".repeat(128);
    const migrated = migrateWebWorkspaceV1({ schemaVersion: 1, activePageId: legacyId, pages: [{ id: legacyId, parentId: null, order: 0,
      type: "database", title: "Boundary table", columns: [{ id: "property", name: "Value", type: "text" }],
      rows: [{ id: "row", values: { property: "external text" } }] }] }, { workspaceId: "source", migratedAt: "2026-08-11T00:00:00.000Z" });
    const maximumId = "p".repeat(160);
    migrated.workspace.pages.push({ id: maximumId, parentId: null, title: maximumId, blocks: [], createdAt: migrated.workspace.createdAt, updatedAt: migrated.workspace.updatedAt });
    migrated.workspace.pages[0]!.createdBy = maximumId;
    migrated.workspace.pages[0]!.updatedBy = legacyId;
    migrated.workspace.pages[0]!.permissions = { ownerId: maximumId };
    assert.equal(migrated.workspace.databases[0]!.id.length, 137);
    assert.equal(migrated.workspace.databases[0]!.views[0]!.id.length, 139);
    assertWorkspaceValue(migrated.workspace);
    const bundle = createBackup(migrated.workspace as unknown as WorkspaceSnapshot, [], "2026-08-11T00:00:00.000Z");
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    const firstNamespace = "n".repeat(160);
    const first = await service.executeAsync({ type: "backup.restore-new", bundle, newWorkspaceId: firstNamespace });
    const second = await service.executeAsync({ type: "backup.restore-new", bundle, newWorkspaceId: "second-namespace" });
    assertWorkspaceValue(first.workspace); assertWorkspaceValue(second.workspace);
    const ids = [first.workspace.id, ...first.workspace.pages.map(page => page.id), ...first.workspace.databases.flatMap(database => [
      database.id, ...database.properties.map(property => property.id), ...database.rows.map(row => row.id), ...database.views.map(view => view.id)
    ])];
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(id => id.length <= 160));
    assert.notEqual(first.workspace.pages.find(page => page.title === maximumId)!.id, second.workspace.pages.find(page => page.title === maximumId)!.id);
    assert.equal(first.workspace.pages[0]!.createdBy, maximumId);
    assert.equal(first.workspace.pages[0]!.updatedBy, legacyId);
    assert.deepEqual(first.workspace.pages[0]!.permissions, { ownerId: maximumId });
    assert.equal(first.workspace.databases[0]!.rows[0]!.values[first.workspace.databases[0]!.properties[0]!.id], "external text");
    for (const hostile of ["bad/id", "x".repeat(161)]) {
      await assert.rejects(service.executeAsync({ type: "backup.restore-new", bundle, newWorkspaceId: hostile }), (error: unknown) => error instanceof MotionAppError && error.code === "VALIDATION_FAILED");
      assert.equal(store.load(hostile), undefined);
    }
    store.close();
  } finally { await removeDatabase(path); }
});

test("native table-row search survives restart and a clean authenticated restore", async () => {
  const sourcePath = databasePath("row-search-source"); const targetPath = databasePath("row-search-target");
  try {
    const document = { schemaVersion: 1, activePageId: "table-page", pages: [{ id: "table-page", parentId: null, order: 0,
      type: "database", title: "Commissioning register", columns: [{ id: "reading", name: "Reading", type: "text" }],
      rows: [{ id: "stable-row", values: { reading: "Flow <10 & stable\nsecond line" } }] }] };
    let source = new SqliteWorkspaceStore(sourcePath); let service = new MotionAppService(source);
    const imported = service.execute({ type: "workspace.import-web-v1", document, workspaceId: "row-search-source", migratedAt: "2026-08-06T00:00:00.000Z" });
    source.close();
    source = new SqliteWorkspaceStore(sourcePath); service = new MotionAppService(source);
    assert.deepEqual(service.query({ type: "workspace.search", workspaceId: imported.workspace.id, query: "stable second" }).map(hit =>
      ({ entityId: hit.entityId, entityType: hit.entityType, ownerEntityId: hit.ownerEntityId })),
      [{ entityId: "stable-row", entityType: "row", ownerEntityId: "table-page" }]);
    const bundle = await service.queryAsync({ type: "backup.create", workspaceId: imported.workspace.id, createdAt: "2026-08-06T00:00:00.000Z" });
    source.close();

    let target = new SqliteWorkspaceStore(targetPath); let restoredService = new MotionAppService(target);
    await restoredService.executeAsync({ type: "backup.restore-new", bundle, newWorkspaceId: "row-search-restored" });
    target.close();
    target = new SqliteWorkspaceStore(targetPath); restoredService = new MotionAppService(target);
    const hit = restoredService.query({ type: "workspace.search", workspaceId: "row-search-restored", query: "stable second" })[0];
    assert.deepEqual({ entityId: hit?.entityId, entityType: hit?.entityType, ownerEntityId: hit?.ownerEntityId },
      { entityId: "row-search-restored:stable-row", entityType: "row", ownerEntityId: "row-search-restored:table-page" });
    assert.match(hit?.snippet ?? "", /\[stable\].*\[second\]/s);
    target.close();
  } finally { await Promise.all([removeDatabase(sourcePath), removeDatabase(targetPath)]); }
});

test("attachment block is published only after durable ingestion and survives restart plus full backup restore", async () => {
  const sourcePath = databasePath("attachment-block-source");
  const targetPath = databasePath("attachment-block-target");
  const sourceFiles = `${sourcePath}.attachments`; const targetFiles = `${targetPath}.attachments`;
  class FailingPromotionStore extends ContentAddressedAttachmentStore {
    failNext = false;
    override async promote(staged: import("@motion/storage").StagedAttachment) {
      if (this.failNext) { this.failNext = false; throw new Error("injected ingestion failure"); }
      return super.promote(staged);
    }
  }
  class FailingWorkspaceStore extends SqliteWorkspaceStore {
    failNext = false;
    override saveUnitOfWork(write: import("@motion/storage").WorkspaceWrite): number {
      if (this.failNext) { this.failNext = false; throw new Error("injected database failure"); }
      return super.saveUnitOfWork(write);
    }
  }
  try {
    const failingStore = new FailingWorkspaceStore(sourcePath);
    let store: SqliteWorkspaceStore = failingStore;
    const attachments = new FailingPromotionStore(sourceFiles);
    let service = new MotionAppService(store, attachments);
    let state = service.execute({ type: "workspace.create", name: "Attachment blocks" });
    state = service.execute({ type: "page.create", workspaceId: state.workspace.id, expectedRevision: state.revision, title: "Evidence" });
    const workspaceId = state.workspace.id; const pageId = state.workspace.pages[0]!.id;
    const bytes = new TextEncoder().encode("durable block payload");
    const command = (overrides: Record<string, unknown> = {}) => ({ type: "attachment.ingest-block", workspaceId, expectedRevision: state.revision,
      pageId, position: { parentBlockId: null, beforeBlockId: null }, attachmentId: "attachment-proof", blockId: "block-proof",
      fileName: "proof.txt", mediaType: "text/plain", sha256: hash(bytes), bytes, ...overrides } as any);

    attachments.failNext = true;
    await assert.rejects(service.executeAsync(command()), (error: unknown) => error instanceof MotionAppError && error.code === "STORAGE_FAILURE" && /before publication/i.test(error.message));
    let canonical = service.query({ type: "workspace.get", workspaceId }).workspace;
    assert.deepEqual({ attachments: canonical.attachments.length, blocks: canonical.pages[0]!.blocks.length }, { attachments: 0, blocks: 0 });

    await assert.rejects(service.executeAsync(command({ sha256: "0".repeat(64) })), (error: unknown) => error instanceof MotionAppError && error.code === "VALIDATION_FAILED");
    canonical = service.query({ type: "workspace.get", workspaceId }).workspace;
    assert.deepEqual({ attachments: canonical.attachments.length, blocks: canonical.pages[0]!.blocks.length }, { attachments: 0, blocks: 0 });

    failingStore.failNext = true;
    await assert.rejects(service.executeAsync(command()), (error: unknown) => error instanceof MotionAppError && error.code === "STORAGE_FAILURE" && /no attachment or block/i.test(error.message));
    canonical = service.query({ type: "workspace.get", workspaceId }).workspace;
    assert.deepEqual({ attachments: canonical.attachments.length, blocks: canonical.pages[0]!.blocks.length }, { attachments: 0, blocks: 0 });
    assert.deepEqual((await attachments.recover([])).unreferencedBlobs, [hash(bytes)],
      "failed SQLite publication must retain a final blob rather than race a concurrent metadata commit");

    const invalidBytes = new TextEncoder().encode("invalid-position-payload");
    await assert.rejects(service.executeAsync(command({ attachmentId: "invalid-position-attachment", blockId: "invalid-position-block",
      position: { parentBlockId: null, beforeBlockId: "missing-sibling" }, bytes: invalidBytes, sha256: hash(invalidBytes) })),
    (error: unknown) => error instanceof MotionAppError && error.code === "NOT_FOUND");
    assert.deepEqual((await attachments.recover([])).unreferencedBlobs, [hash(bytes)], "invalid position must fail before promotion and must not create another final blob");

    await assert.rejects(service.executeAsync(command({ unsupported: "capability" })),
      (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT" && /shape/i.test(error.message));

    const oversized = new Uint8Array(3 * 1024 * 1024 + 1);
    await assert.rejects(service.executeAsync(command({ bytes: oversized, sha256: hash(oversized) })),
      (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT" && /3 MiB/i.test(error.message));

    const ingested = await service.executeAsync(command());
    assert.equal(ingested.workspace.pages[0]!.blocks[0]!.attachmentId, "attachment-proof");
    await assert.rejects(service.executeAsync(command({ attachmentId: "stale-attachment", blockId: "stale-block" })), (error: unknown) => error instanceof MotionAppError && error.code === "REVISION_CONFLICT");
    canonical = service.query({ type: "workspace.get", workspaceId }).workspace;
    assert.deepEqual(canonical.attachments.map(item => item.id), ["attachment-proof"]);
    assert.deepEqual(canonical.pages[0]!.blocks.map(block => block.id), ["block-proof"]);

    failingStore.failNext = true;
    await assert.rejects(service.executeAsync(command({ expectedRevision: ingested.revision, attachmentId: "dedup-failure", blockId: "dedup-failure-block" })),
      (error: unknown) => error instanceof MotionAppError && error.code === "STORAGE_FAILURE");
    assert.deepEqual((await attachments.recover([hash(bytes)])).unreferencedBlobs, [], "failed deduplicated publication must preserve referenced content");
    assert.deepEqual(new Uint8Array(await attachments.get(hash(bytes))), bytes);

    store.close();
    store = new SqliteWorkspaceStore(sourcePath); service = new MotionAppService(store, new ContentAddressedAttachmentStore(sourceFiles));
    assert.deepEqual((await service.queryAsync({ type: "attachment.read", workspaceId, attachmentId: "attachment-proof" })).bytes, bytes);
    const bundle = await service.queryAsync({ type: "backup.create", workspaceId, createdAt: "2026-08-12T00:00:00.000Z" });
    assert.deepEqual(await service.queryAsync({ type: "backup.verify", bundle }), { valid: true, errors: [] });
    const attachmentPayload = bundle.manifest.files.find(file => file.path !== "workspace.json")!;
    assert.deepEqual(bundle.files[attachmentPayload.path], bytes);
    store.close();

    const target = new SqliteWorkspaceStore(targetPath); const restoredService = new MotionAppService(target, new ContentAddressedAttachmentStore(targetFiles));
    const restored = await restoredService.executeAsync({ type: "backup.restore-new", bundle, newWorkspaceId: "restored-attachment-block" });
    const restoredAttachment = restored.workspace.attachments[0]!; const restoredBlock = restored.workspace.pages[0]!.blocks[0]!;
    assert.equal(restoredBlock.attachmentId, restoredAttachment.id);
    assert.deepEqual((await restoredService.queryAsync({ type: "attachment.read", workspaceId: restored.workspace.id, attachmentId: restoredAttachment.id })).bytes, bytes);
    target.close();
  } finally {
    await Promise.all([removeDatabase(sourcePath), removeDatabase(targetPath), rm(sourceFiles, { recursive: true, force: true }), rm(targetFiles, { recursive: true, force: true })]);
  }
});

test("failed ingestion compensation cannot delete content concurrently committed by another service", async () => {
  const path = databasePath("attachment-compensation-race"); const files = `${path}.attachments`;
  let storeA: SqliteWorkspaceStore | undefined; let storeB: SqliteWorkspaceStore | undefined;
  try {
    const setupStore = new SqliteWorkspaceStore(path); const setup = new MotionAppService(setupStore, new ContentAddressedAttachmentStore(files));
    let state = setup.execute({ type: "workspace.create", name: "Compensation race" });
    state = setup.execute({ type: "page.create", workspaceId: state.workspace.id, expectedRevision: state.revision, title: "Evidence" });
    setupStore.close();
    const workspaceId = state.workspace.id; const pageId = state.workspace.pages[0]!.id; const expectedRevision = state.revision;
    const bytes = new TextEncoder().encode("shared concurrent payload"); const sha256 = hash(bytes);
    let releaseB!: () => void; const beginB = new Promise<void>(resolve => { releaseB = resolve; });
    let bDone!: Promise<unknown>;
    class FailingWorkspaceStore extends SqliteWorkspaceStore {
      failed = false;
      override saveUnitOfWork(write: import("@motion/storage").WorkspaceWrite): number {
        if (!this.failed) { this.failed = true; throw new Error("injected database failure"); }
        return super.saveUnitOfWork(write);
      }
      override list() { const rows = super.list(); if (this.failed) releaseB(); return rows; }
    }
    storeA = new FailingWorkspaceStore(path); storeB = new SqliteWorkspaceStore(path);
    const attachmentsA = new ContentAddressedAttachmentStore(files);
    (attachmentsA as any).removeNewlyCreated = async (stored: { path: string; newlyCreated: boolean }) => {
      releaseB(); await bDone; if (stored.newlyCreated) await rm(stored.path, { force: true });
    };
    const serviceA = new MotionAppService(storeA, attachmentsA);
    const serviceB = new MotionAppService(storeB, new ContentAddressedAttachmentStore(files));
    const command = (attachmentId: string, blockId: string) => ({ type: "attachment.ingest-block", workspaceId, expectedRevision,
      pageId, position: { parentBlockId: null, beforeBlockId: null }, attachmentId, blockId,
      fileName: "shared.txt", mediaType: "text/plain", sha256, bytes } as const);
    bDone = (async () => { await beginB; return serviceB.executeAsync(command("b-attachment", "b-block")); })();
    const aResult = assert.rejects(serviceA.executeAsync(command("a-attachment", "a-block")),
      (error: unknown) => error instanceof MotionAppError && error.code === "STORAGE_FAILURE");
    await aResult; releaseB();
    await bDone;
    assert.deepEqual((await serviceB.queryAsync({ type: "attachment.read", workspaceId, attachmentId: "b-attachment" })).bytes, bytes);
  } finally {
    storeA?.close(); storeB?.close();
    await Promise.all([removeDatabase(path), rm(files, { recursive: true, force: true })]);
  }
});

test("attachments and canonical backup survive restart and restore without trusting archived paths", async () => {
  const sourcePath = databasePath("backup-source");
  const targetPath = databasePath("backup-target");
  const sourceFiles = `${sourcePath}.attachments`; const targetFiles = `${targetPath}.attachments`;
  try {
    let store = new SqliteWorkspaceStore(sourcePath);
    let service = new MotionAppService(store, new ContentAddressedAttachmentStore(sourceFiles));
    const created = service.execute({ type: "workspace.create", name: "Backup source" });
    const bytes = new TextEncoder().encode("durable attachment");
    const attached = await service.executeAsync({ type: "attachment.put", workspaceId: created.workspace.id, expectedRevision: created.revision, id: "file-1", fileName: "notes.txt", mediaType: "text/plain", sha256: hash(bytes), bytes });
    store.close();
    store = new SqliteWorkspaceStore(sourcePath); service = new MotionAppService(store, new ContentAddressedAttachmentStore(sourceFiles));
    assert.deepEqual((await service.queryAsync({ type: "attachment.read", workspaceId: created.workspace.id, attachmentId: "file-1" })).bytes, bytes);
    const bundle = await service.queryAsync({ type: "backup.create", workspaceId: created.workspace.id, createdAt: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(await service.queryAsync({ type: "backup.verify", bundle }), { valid: true, errors: [] });
    assert.equal((await service.queryAsync({ type: "backup.preview", bundle })).attachments, 1);
    store.close();

    const target = new SqliteWorkspaceStore(targetPath);
    const targetService = new MotionAppService(target, new ContentAddressedAttachmentStore(targetFiles));
    const restored = await targetService.executeAsync({ type: "backup.restore-new", bundle, newWorkspaceId: "restored-workspace" });
    assert.equal(restored.workspace.name, attached.workspace.name);
    const restoredAttachment = restored.workspace.attachments[0]!;
    assert.ok(restoredAttachment.path.startsWith(targetFiles));
    assert.equal(restoredAttachment.path.includes("untrusted/archive"), false);
    target.close();
    const reopenedStore = new SqliteWorkspaceStore(targetPath);
    const reopened = new MotionAppService(reopenedStore, new ContentAddressedAttachmentStore(targetFiles));
    assert.deepEqual((await reopened.queryAsync({ type: "attachment.read", workspaceId: "restored-workspace", attachmentId: restoredAttachment.id })).bytes, bytes);
    const semantic = reopened.query({ type: "workspace.get", workspaceId: "restored-workspace" }).workspace;
    assert.equal(semantic.pages.length, attached.workspace.pages.length);
    assert.equal(semantic.attachments[0]?.sha256, attached.workspace.attachments[0]?.sha256);
    reopenedStore.close();
  } finally {
    await Promise.all([removeDatabase(sourcePath), removeDatabase(targetPath), rm(sourceFiles, { recursive: true, force: true }), rm(targetFiles, { recursive: true, force: true })]);
  }
});

test("attachment validation, revision conflict and corrupt restore write no metadata", async () => {
  const path = databasePath("attachment-failures"); const files = `${path}.attachments`;
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store, new ContentAddressedAttachmentStore(files));
    const created = service.execute({ type: "workspace.create", name: "Failures" });
    const bytes = new Uint8Array([1, 2, 3]);
    const oversizedPut = new Uint8Array(3 * 1024 * 1024 + 1);
    await assert.rejects(service.executeAsync({ type: "attachment.put", workspaceId: created.workspace.id, expectedRevision: created.revision,
      fileName: "oversized.bin", mediaType: "application/octet-stream", sha256: hash(oversizedPut), bytes: oversizedPut }),
      (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT" && /3 MiB/i.test(error.message));
    await assert.rejects(service.executeAsync({ type: "attachment.put", workspaceId: created.workspace.id, expectedRevision: created.revision,
      fileName: "x", mediaType: "application/octet-stream", sha256: hash(bytes), bytes, unsupported: true } as any),
      (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT" && /shape/i.test(error.message));
    await assert.rejects(service.executeAsync({ type: "attachment.put", workspaceId: created.workspace.id, expectedRevision: created.revision, fileName: "x", mediaType: "application/octet-stream", sha256: "missing", bytes }), (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    await assert.rejects(service.executeAsync({ type: "attachment.put", workspaceId: created.workspace.id, expectedRevision: created.revision, fileName: "x", mediaType: "application/octet-stream", sha256: "0".repeat(64), bytes }), (error: unknown) => error instanceof MotionAppError && error.code === "VALIDATION_FAILED");
    const first = await service.executeAsync({ type: "attachment.put", workspaceId: created.workspace.id, expectedRevision: created.revision, fileName: "x", mediaType: "application/octet-stream", sha256: hash(bytes), bytes });
    await assert.rejects(service.executeAsync({ type: "attachment.put", workspaceId: created.workspace.id, expectedRevision: created.revision, fileName: "stale", mediaType: "application/octet-stream", sha256: hash(bytes), bytes }), (error: unknown) => error instanceof MotionAppError && error.code === "REVISION_CONFLICT" && /staged content was discarded/.test(error.message));
    assert.equal(service.query({ type: "workspace.get", workspaceId: created.workspace.id }).workspace.attachments.length, 1);
    const bundle = await service.queryAsync({ type: "backup.create", workspaceId: created.workspace.id });
    const originalBefore = structuredClone(store.load(created.workspace.id));
    const withWorkspace = (mutate: (value: any) => void) => {
      const value = JSON.parse(new TextDecoder().decode(bundle.files["workspace.json"]!)); mutate(value);
      const payload = new TextEncoder().encode(JSON.stringify(value));
      return { manifest: { ...bundle.manifest, files: bundle.manifest.files.map(file => file.path === "workspace.json" ? { ...file, byteLength: payload.byteLength, sha256: hash(payload) } : file) }, files: { ...bundle.files, "workspace.json": payload } };
    };
    const withManifestPath = (unsafePath: string) => { const payload = bundle.files["workspace.json"]!; return { manifest: { ...bundle.manifest, files: bundle.manifest.files.map(file => file.path === "workspace.json" ? { ...file, path: unsafePath } : file) }, files: { ...bundle.files, [unsafePath]: payload } }; };
    const hostileInputs = [
      { name: "corrupt", bundle: { manifest: bundle.manifest, files: { ...bundle.files, "workspace.json": new Uint8Array([0]) } } },
      { name: "truncated", bundle: (() => { const payload = new TextEncoder().encode("{\"schemaVersion\":"); return { manifest: { ...bundle.manifest, files: bundle.manifest.files.map(file => file.path === "workspace.json" ? { ...file, byteLength: payload.byteLength, sha256: hash(payload) } : file) }, files: { ...bundle.files, "workspace.json": payload } }; })() },
      ...["../workspace.json", "%2e%2e/workspace.json", "attachments\\..\\workspace.json", "/private/escape/workspace.json", "C:\\private\\escape.json", "\\\\server\\share\\escape.json"].map((unsafePath, index) => ({ name: `path-${index}`, bundle: withManifestPath(unsafePath) })),
      { name: "link-like", bundle: { manifest: { ...bundle.manifest, files: bundle.manifest.files.map(file => file.path === "workspace.json" ? { ...file, linkTarget: "../private" } : file) }, files: bundle.files } },
      { name: "duplicate-id", bundle: withWorkspace(value => { value.pages.push({ ...value.pages[0], title: "TOP_SECRET_CANARY" }); }) },
      { name: "schema-corruption", bundle: withWorkspace(value => { value.schemaVersion = 999; value.name = "TOP_SECRET_CANARY"; }) },
      { name: "oversized-metadata", bundle: { manifest: { ...bundle.manifest, createdAt: "x".repeat(4097) }, files: bundle.files } }
    ];
    for (const input of hostileInputs) {
      const beforeHash = await integrityHash(path, files);
      await assert.rejects(service.executeAsync({ type: "backup.restore-new", bundle: input.bundle as any, newWorkspaceId: `must-not-exist-${input.name}` }), (error: unknown) => error instanceof MotionAppError && error.code === "VALIDATION_FAILED" && /invalid, oversized, or unsafe/i.test(error.message) && !error.message.includes("TOP_SECRET_CANARY"));
      assert.equal(store.load(`must-not-exist-${input.name}`), undefined);
      assert.deepEqual(store.load(created.workspace.id), originalBefore, `${input.name} modified the live workspace`);
      assert.equal(await integrityHash(path, files), beforeHash, `${input.name} changed database or attachment bytes`);
    }
    assert.equal(first.revision, created.revision + 1);
    store.close();
  } finally { await Promise.all([removeDatabase(path), rm(files, { recursive: true, force: true })]); }
});

test("restore rejects a 3 MiB plus one attachment before any destination mutation", async () => {
  const path = databasePath("restore-oversized-attachment"); const files = `${path}.attachments`;
  try {
    const store = new SqliteWorkspaceStore(path); const attachments = new ContentAddressedAttachmentStore(files);
    const service = new MotionAppService(store, attachments);
    await attachments.recover([]);
    const existing = service.execute({ type: "workspace.create", name: "Destination remains unchanged" });
    const payload = new Uint8Array(3 * 1024 * 1024 + 1); payload[payload.length - 1] = 1;
    const sha256 = hash(payload); const source = structuredClone(existing.workspace) as any;
    source.id = "oversized-source"; source.name = "Oversized source"; source.attachments = [{
      id: "oversized-attachment", fileName: "oversized.bin", mediaType: "application/octet-stream",
      byteLength: payload.byteLength, sha256, path: "/untrusted/oversized.bin", createdAt: source.createdAt
    }];
    const workspacePayload = new TextEncoder().encode(JSON.stringify(source));
    const attachmentPath = "attachments/oversized-attachment/oversized.bin";
    const bundle = { manifest: { format: "motion-workspace-backup" as const, schemaVersion: 1 as const,
      createdAt: "2026-08-12T00:00:00.000Z", workspaceId: source.id, workspaceSchemaVersion: source.schemaVersion,
      files: [
        { path: "workspace.json", byteLength: workspacePayload.byteLength, sha256: hash(workspacePayload), mediaType: "application/json" },
        { path: attachmentPath, byteLength: payload.byteLength, sha256, mediaType: "application/octet-stream" }
      ] }, files: { "workspace.json": workspacePayload, [attachmentPath]: payload } };
    const beforeWorkspace = structuredClone(store.load(existing.workspace.id));
    const beforeHash = await integrityHash(path, files);

    assert.deepEqual(await service.queryAsync({ type: "backup.verify", bundle }), {
      valid: false, errors: ["Backup attachment exceeds per-file size limit"]
    });
    await assert.rejects(service.executeAsync({ type: "backup.restore-new", bundle, newWorkspaceId: "oversized-destination" }),
      (error: unknown) => error instanceof MotionAppError && error.code === "VALIDATION_FAILED"
        && /invalid, oversized, or unsafe/i.test(error.message) && !error.message.includes("oversized-attachment"));
    assert.equal(store.load("oversized-destination"), undefined, "restore created destination metadata");
    assert.deepEqual(store.load(existing.workspace.id), beforeWorkspace, "restore changed existing workspace or UI state");
    assert.equal(await integrityHash(path, files), beforeHash, "restore created staging/final blobs or changed destination bytes");
    assert.deepEqual(await readdir(`${files}/.staging`), [], "restore left staged attachment content");
    store.close();
  } finally { await Promise.all([removeDatabase(path), rm(files, { recursive: true, force: true })]); }
});

test("read and backup creation reject a preexisting oversized final attachment blob", async () => {
  const path = databasePath("oversized-final-read"); const files = `${path}.attachments`;
  try {
    const store = new SqliteWorkspaceStore(path); const attachments = new ContentAddressedAttachmentStore(files);
    const service = new MotionAppService(store, attachments);
    const created = service.execute({ type: "workspace.create", name: "Oversized final" });
    const payload = new Uint8Array(3 * 1024 * 1024 + 1); payload[payload.length - 1] = 1;
    const sha256 = hash(payload); const document = structuredClone(created.workspace) as any;
    document.attachments = [{ id: "private-attachment-id", fileName: "private-name.bin", mediaType: "application/octet-stream",
      byteLength: 1, sha256, path: attachments.pathFor(sha256), createdAt: document.createdAt }];
    store.save(document.id, document.schemaVersion, document, created.revision);
    await mkdir(join(files, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
    await writeFile(attachments.pathFor(sha256), payload, { mode: 0o600 });

    for (const query of [
      { type: "attachment.read", workspaceId: document.id, attachmentId: "private-attachment-id" },
      { type: "backup.create", workspaceId: document.id }
    ] as const) await assert.rejects(service.queryAsync(query as any), error => error instanceof MotionAppError
      && error.code === "STORAGE_FAILURE" && !error.message.includes(sha256)
      && !error.message.includes("private-attachment-id") && !error.message.includes("private-name.bin"));
    assert.equal((await readFile(attachments.pathFor(sha256))).byteLength, payload.byteLength);
    store.close();
  } finally { await Promise.all([removeDatabase(path), rm(files, { recursive: true, force: true })]); }
});

test("restore database interruption discards staging and preserves the original store", async () => {
  const path = databasePath("restore-db-interruption"); const files = `${path}.attachments`;
  class InterruptedStore extends SqliteWorkspaceStore {
    override saveUnitOfWork(write: import("@motion/storage").WorkspaceWrite): number {
      if (write.workspaceId === "interrupted-restore") throw new Error("injected restore database interruption");
      return super.saveUnitOfWork(write);
    }
  }
  try {
    const store = new InterruptedStore(path); const service = new MotionAppService(store, new ContentAddressedAttachmentStore(files));
    const original = service.execute({ type: "workspace.create", name: "Original remains" });
    const bytes = new TextEncoder().encode("restore payload");
    const attached = await service.executeAsync({ type: "attachment.put", workspaceId: original.workspace.id, expectedRevision: original.revision, fileName: "restore.txt", mediaType: "text/plain", sha256: hash(bytes), bytes });
    const bundle = await service.queryAsync({ type: "backup.create", workspaceId: original.workspace.id });
    const before = structuredClone(store.load(original.workspace.id));
    const bytesBefore = await integrityHash(path, files);
    await assert.rejects(service.executeAsync({ type: "backup.restore-new", bundle, newWorkspaceId: "interrupted-restore" }), /staged content was discarded/i);
    assert.equal(store.load("interrupted-restore"), undefined);
    assert.deepEqual(store.load(original.workspace.id), before);
    assert.equal(await integrityHash(path, files), bytesBefore, "interrupted import changed database or attachment bytes");
    const staging = await readdir(`${files}/.staging`);
    assert.deepEqual(staging, []);
    assert.equal(attached.workspace.attachments.length, 1);
    store.close();
  } finally { await Promise.all([removeDatabase(path), rm(files, { recursive: true, force: true })]); }
});

test("interrupted restore promotion is recovered without changing the original workspace", async () => {
  const path = databasePath("restore-promotion-interruption"); const files = `${path}.attachments`;
  class FailingPromotionStore extends ContentAddressedAttachmentStore {
    fail = false;
    override async promote(staged: import("@motion/storage").StagedAttachment) { if (this.fail) { this.fail = false; throw new Error("injected restore promotion interruption"); } return super.promote(staged); }
  }
  try {
    const store = new SqliteWorkspaceStore(path); const attachments = new FailingPromotionStore(files); const service = new MotionAppService(store, attachments);
    const original = service.execute({ type: "workspace.create", name: "Original" });
    const bytes = new TextEncoder().encode("recoverable restore payload");
    const attached = await service.executeAsync({ type: "attachment.put", workspaceId: original.workspace.id, expectedRevision: original.revision, fileName: "recover.txt", mediaType: "text/plain", sha256: hash(bytes), bytes });
    const bundle = await service.queryAsync({ type: "backup.create", workspaceId: original.workspace.id });
    const originalBefore = structuredClone(store.load(original.workspace.id));
    attachments.fail = true;
    await assert.rejects(service.executeAsync({ type: "backup.restore-new", bundle, newWorkspaceId: "recoverable-restore" }), /metadata commit.*retry content promotion/i);
    assert.deepEqual(store.load(original.workspace.id), originalBefore);
    assert.ok(store.load("recoverable-restore"), "restore metadata was not committed atomically");
    const restoredId = (store.load("recoverable-restore")!.document as import("@motion/core").Workspace).attachments[0]!.id;
    const restored = await service.queryAsync({ type: "attachment.read", workspaceId: "recoverable-restore", attachmentId: restoredId });
    assert.deepEqual(restored.bytes, bytes);
    const rootMode = (await stat(files)).mode & 0o777;
    const bucketMode = (await stat(`${files}/${hash(bytes).slice(0, 2)}`)).mode & 0o777;
    const fileMode = (await stat(`${files}/${hash(bytes).slice(0, 2)}/${hash(bytes)}`)).mode & 0o777;
    assert.deepEqual({ rootMode, bucketMode, fileMode }, { rootMode: 0o700, bucketMode: 0o700, fileMode: 0o600 });
    store.close();
  } finally { await Promise.all([removeDatabase(path), rm(files, { recursive: true, force: true })]); }
});

test("attachment promotion failure is recovered from committed metadata on the next operation", async () => {
  const path = databasePath("attachment-promotion-recovery"); const files = `${path}.attachments`;
  class FailingPromotionStore extends ContentAddressedAttachmentStore {
    failNextPromotion = true;
    override async promote(staged: import("@motion/storage").StagedAttachment) {
      if (this.failNextPromotion) { this.failNextPromotion = false; throw new Error("injected promotion failure"); }
      return super.promote(staged);
    }
  }
  try {
    const store = new SqliteWorkspaceStore(path); const attachments = new FailingPromotionStore(files);
    const service = new MotionAppService(store, attachments);
    const created = service.execute({ type: "workspace.create", name: "Recovery" });
    const bytes = new TextEncoder().encode("recover after metadata commit");
    await assert.rejects(service.executeAsync({ type: "attachment.put", workspaceId: created.workspace.id,
      expectedRevision: created.revision, id: "recover-me", fileName: "recover.txt", mediaType: "text/plain",
      sha256: hash(bytes), bytes }), (error: unknown) => error instanceof MotionAppError && error.code === "STORAGE_FAILURE"
        && error.details?.metadataCommitted === true && /retry content promotion/.test(error.message));
    assert.equal(service.query({ type: "workspace.get", workspaceId: created.workspace.id }).workspace.attachments[0]?.id, "recover-me");
    const recovered = await service.queryAsync({ type: "attachment.read", workspaceId: created.workspace.id, attachmentId: "recover-me" });
    assert.deepEqual(recovered.bytes, bytes);
    store.close();
  } finally { await Promise.all([removeDatabase(path), rm(files, { recursive: true, force: true })]); }
});

test("page hierarchy and typed record commands persist through SQLite restart", async () => {
  const path = databasePath("pages-tables");
  try {
    let store = new SqliteWorkspaceStore(path); let service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Daily workspace" });
    const workspaceId = state.workspace.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "House" });
    const houseId = state.workspace.pages.find(page => page.title === "House")!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Notes", parentId: houseId });
    const notesId = state.workspace.pages.find(page => page.title === "Notes")!.id;
    state = service.execute({ type: "page.set-favourite", workspaceId, expectedRevision: state.revision, pageId: notesId, favourite: true });
    state = service.execute({ type: "database.create", workspaceId, expectedRevision: state.revision, title: "Jobs", parentId: houseId });
    const database = state.workspace.databases[0]!;
    state = service.execute({ type: "database.property-add", workspaceId, expectedRevision: state.revision, databaseId: database.id,
      property: { name: "Status", type: "status", options: [{ id: "todo", name: "To do" }, { id: "doing", name: "In progress" }] } });
    const statusId = state.workspace.databases[0]!.properties.find(property => property.name === "Status")!.id;
    state = service.execute({ type: "database.property-add", workspaceId, expectedRevision: state.revision, databaseId: database.id,
      property: { name: "Cost", type: "number" } });
    const costId = state.workspace.databases[0]!.properties.find(property => property.name === "Cost")!.id;
    state = service.execute({ type: "database.record-create", workspaceId, expectedRevision: state.revision, databaseId: database.id,
      title: "Replace heat pump", values: { [statusId]: "doing", [costId]: 4200 } });
    const record = state.workspace.pages.find(page => page.title === "Replace heat pump")!;
    state = service.execute({ type: "page.replace-blocks", workspaceId, expectedRevision: state.revision, pageId: record.id,
      blocks: [{ id: "quote-note", type: "paragraph", text: "Need three supplier quotes.", children: [] }] });
    const view = state.workspace.databases[0]!.views[0]!;
    state = service.execute({ type: "database.view-update", workspaceId, expectedRevision: state.revision, databaseId: database.id, viewId: view.id,
      patch: { columnWidths: { [database.properties[0]!.id]: 360, [statusId]: 160, [costId]: 120 },
        propertyOrder: [database.properties[0]!.id, statusId, costId], visiblePropertyIds: [database.properties[0]!.id, statusId, costId],
        filters: { kind: "condition", propertyId: statusId, operator: "not-equals", value: "todo" },
        sorts: [{ propertyId: statusId, direction: "asc" }, { propertyId: costId, direction: "desc" }] } });
    state = service.execute({ type: "page.reorder", workspaceId, expectedRevision: state.revision, pageId: state.workspace.databases[0]!.pageId, beforePageId: notesId });
    store.close();

    store = new SqliteWorkspaceStore(path); service = new MotionAppService(store);
    const reopened = service.query({ type: "workspace.get", workspaceId }).workspace;
    const reopenedDatabase = reopened.databases[0]!;
    assert.deepEqual(reopened.pages.filter(page => page.parentId === houseId).map(page => page.title), ["Jobs", "Notes"]);
    assert.equal(reopened.pages.find(page => page.id === notesId)?.favourite, true);
    assert.equal(reopened.pages.find(page => page.id === record.id)?.properties?.[costId], 4200);
    assert.equal(reopened.pages.find(page => page.id === record.id)?.blocks[0]?.text, "Need three supplier quotes.");
    assert.deepEqual(reopenedDatabase.views[0]!.sorts?.map(sort => sort.propertyId), [statusId, costId]);
    assert.equal(reopenedDatabase.views[0]!.filters?.kind, "condition");
    assert.equal(reopenedDatabase.recordPageIds?.[0], record.id);
    store.close();
  } finally { await removeDatabase(path); }
});

test("record commands reject cross-collection properties without saving a revision", async () => {
  const path = databasePath("record-property-scope");
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Scoped records" }); const workspaceId = state.workspace.id;
    state = service.execute({ type: "database.create", workspaceId, expectedRevision: state.revision, title: "First" });
    state = service.execute({ type: "database.create", workspaceId, expectedRevision: state.revision, title: "Second" });
    const [first, second] = state.workspace.databases;
    state = service.execute({ type: "database.property-add", workspaceId, expectedRevision: state.revision, databaseId: first!.id, property: { name: "First value", type: "number" } });
    const firstPropertyId = state.workspace.databases.find(database => database.id === first!.id)!.properties.find(property => property.name === "First value")!.id;
    state = service.execute({ type: "database.property-add", workspaceId, expectedRevision: state.revision, databaseId: second!.id, property: { name: "Second value", type: "number" } });
    const secondPropertyId = state.workspace.databases.find(database => database.id === second!.id)!.properties.find(property => property.name === "Second value")!.id;

    const beforeCreate = structuredClone(store.load(workspaceId));
    assert.throws(() => service.execute({ type: "database.record-create", workspaceId, expectedRevision: state.revision, databaseId: first!.id, title: "Injected", values: { [secondPropertyId]: 2 } }),
      (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    assert.deepEqual(store.load(workspaceId), beforeCreate);

    state = service.execute({ type: "database.record-create", workspaceId, expectedRevision: state.revision, databaseId: first!.id, title: "Valid", values: { [firstPropertyId]: 1 } });
    const record = state.workspace.pages.find(page => page.title === "Valid")!;
    state = service.execute({ type: "database.record-update", workspaceId, expectedRevision: state.revision, pageId: record.id, values: { [firstPropertyId]: 3 } });
    assert.deepEqual({ pages: store.lastWriteStats?.pages, databases: store.lastWriteStats?.databases, ftsScopes: store.lastWriteStats?.ftsScopes },
      { pages: 1, databases: 1, ftsScopes: 2 });
    assert.equal(state.workspace.pages.find(page => page.id === record.id)?.properties?.[firstPropertyId], 3);
    const beforeUpdate = structuredClone(store.load(workspaceId));
    assert.throws(() => service.execute({ type: "database.record-update", workspaceId, expectedRevision: state.revision, pageId: record.id, title: "Must roll back", values: { [secondPropertyId]: 4 } }),
      (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    assert.deepEqual(store.load(workspaceId), beforeUpdate);
    store.close();
  } finally { await removeDatabase(path); }
});

test("record update rejects non-record targets without saving a revision", async () => {
  const path = databasePath("record-target-membership");
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Record targets" }); const workspaceId = state.workspace.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Ordinary page" });
    const page = state.workspace.pages[0]!; const before = structuredClone(store.load(workspaceId));
    assert.throws(() => service.execute({ type: "database.record-update", workspaceId, expectedRevision: state.revision, pageId: page.id, title: "Must not change", values: {} }),
      (error: unknown) => error instanceof MotionAppError && error.code === "INVALID_INPUT");
    assert.deepEqual(store.load(workspaceId), before);
    store.close();
  } finally { await removeDatabase(path); }
});

test("corrupt unindexed record workspaces fail validation without another save", async () => {
  const path = databasePath("corrupt-record-membership");
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    let state = service.execute({ type: "workspace.create", name: "Corrupt membership" }); const workspaceId = state.workspace.id;
    state = service.execute({ type: "database.create", workspaceId, expectedRevision: state.revision, title: "Records" });
    state = service.execute({ type: "database.record-create", workspaceId, expectedRevision: state.revision, databaseId: state.workspace.databases[0]!.id, title: "Invisible", values: {} });
    const corrupt = structuredClone(state.workspace); corrupt.databases[0]!.recordPageIds = [];
    const corruptRevision = store.saveUnitOfWork({ workspaceId, schemaVersion: corrupt.schemaVersion, document: corrupt, expectedRevision: state.revision });
    const before = structuredClone(store.load(workspaceId));
    assert.throws(() => service.execute({ type: "database.record-update", workspaceId, expectedRevision: corruptRevision, pageId: corrupt.pages.at(-1)!.id, title: "Must not save", values: {} }),
      (error: unknown) => error instanceof MotionAppError && error.code === "VALIDATION_FAILED");
    assert.deepEqual(store.load(workspaceId), before);
    store.close();
  } finally { await removeDatabase(path); }
});
