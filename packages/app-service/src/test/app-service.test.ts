import assert from "node:assert/strict";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore } from "@motion/storage";
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
