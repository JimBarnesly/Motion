import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("entrypoint references only local assets", async () => {
  const html = await readFile(resolve(root, "index.html"), "utf8");
  assert.match(html, /\.\/styles\.css/);
  assert.match(html, /\.\/app\.js/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("development server supports an explicit bind host without embedding a remote URL", async () => {
  const source = await readFile(resolve(root, "scripts/serve.mjs"), "utf8");
  assert.match(source, /process\.env\.HOST \?\? "127\.0\.0\.1"/);
  assert.match(source, /\.listen\(port, host/);
  assert.doesNotMatch(source, /http:\/\/\$\{host\}/);
});

test("workspace persistence uses an explicit async native/browser adapter", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const adapter = await readFile(resolve(root, "app-adapter.js"), "utf8");
  assert.match(source, /createMotionUiAdapter/);
  assert.match(adapter, /motion_ui_load/);
  assert.match(adapter, /motion_ui_save/);
  assert.match(adapter, /browser-development/);
  assert.match(adapter, /indexedDB\.open/);
  assert.doesNotMatch(source + adapter, /localStorage/);
  assert.match(adapter, /schemaVersion:\s*2/);
});

test("schema-v2 typed edits use the canonical recoverable confirmation boundary", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const html = await readFile(resolve(root, "index.html"), "utf8");
  const build = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
  assert.match(source, /createEditRecoveryController/);
  assert.match(build, /edit-recovery\.js/);
  assert.match(source, /adapter\.execute\(candidate\.type,candidate\.payload\)/);
  assert.match(source, /function queueCanonicalEdit/);
  assert.match(source, /function requireResolvedEdit/);
  assert.match(source, /window\.addEventListener\("beforeunload"/);
  assert.doesNotMatch(source, /alert\(error instanceof Error \? error\.message/);
  for (const action of ["exporting", "creating a backup", "restoring", "moving content to Trash", "leaving this page"]) assert.match(source, new RegExp(`requireResolvedEdit\\(\\"${action}`));
  assert.match(html, /id="editRecovery"[^>]*role="alert"/);
  assert.match(html, /id="retryEdit"/);
  assert.match(html, /id="discardEdit"/);
});

test("native adapter sends versioned typed IPC envelopes", async () => {
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const workspace = { schemaVersion: 2, workspace: { id: "workspace-1", pages: [], databases: [] }, revision: 3, activePageId: null, expandedPageIds: [] };
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    calls.push({ command, payload });
    if (command === "motion_ui_load") return workspace;
    if (command === "app_dispatch" && payload.request.payload.type === "workspace.list") return [{ id: "workspace-1", revision: 3 }];
    if (command === "app_dispatch" && payload.request.payload.type === "workspace.search") return [{ workspaceId: "workspace-1", entityId: "page-1", title: "Page", snippet: "match" }];
    if (command === "app_dispatch" && payload.request.payload.type === "workspace.export") return { schemaVersion: 1, files: {}, attachments: [] };
    return undefined;
  } } } });
  assert.equal(adapter.kind, "tauri");
  assert.deepEqual(await adapter.load(), workspace);
  await adapter.saveUi({ workspaceId: "workspace-1", activePageId: null, expandedPageIds: [] });
  assert.equal((await adapter.search("match"))[0].entityId, "page-1");
  assert.equal((await adapter.exportWorkspace()).schemaVersion, 1);
  assert.deepEqual(calls, [
    { command: "motion_ui_load", payload: { request: { schemaVersion: 2 } } },
    { command: "motion_ui_save", payload: { request: { document: { workspaceId: "workspace-1", activePageId: null, expandedPageIds: [] }, schemaVersion: 2 } } },
    { command: "app_dispatch", payload: { request: { protocolVersion: 1, lane: "query", payload: { type: "workspace.search", workspaceId: "workspace-1", query: "match", limit: 50 } } } },
    { command: "app_dispatch", payload: { request: { protocolVersion: 1, lane: "query", payload: { type: "workspace.export", workspaceId: "workspace-1" } } } }
  ]);
});

test("search and export use canonical native queries with honest browser fallbacks", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const adapter = await readFile(resolve(root, "app-adapter.js"), "utf8");
  assert.match(adapter, /type: "workspace\.search"/);
  assert.match(adapter, /type: "workspace\.export"/);
  assert.match(source, /adapter\.kind === "tauri"/);
  assert.match(source, /motion-browser-development/);
  assert.match(source, /new Set\(hits\.map/);
});

test("native attachment and verified backup operations use revisioned typed lanes", async () => {
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "app_dispatch" && payload.request.payload.type === "workspace.list") return [{ id: "workspace-1", revision: 7 }];
    if (payload?.request?.payload?.type === "attachment.put") return { revision: 8, workspace: { attachments: [{ id: "attachment-1", fileName: "proof.txt", byteLength: 3, sha256: "a".repeat(64) }] } };
    if (payload?.request?.payload?.type === "backup.create") return { manifest: { files: [] }, files: {} };
    if (payload?.request?.payload?.type === "backup.verify") return { valid: true, errors: [] };
    if (payload?.request?.payload?.type === "backup.preview") return { valid: true, pages: 1, attachments: 1, totalBytes: 3 };
    if (payload?.request?.payload?.type === "backup.restore-new") return { revision: 1, saved: true };
  };
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke } } });
  const bundle = await adapter.createBackup();
  await adapter.putAttachment({ fileName: "proof.txt", mediaType: "text/plain", sha256: "a".repeat(64), bytes: Uint8Array.from([1, 2, 3]) });
  await adapter.verifyBackup(bundle); await adapter.previewBackup(bundle); await adapter.restoreBackup(bundle);
  const requests = calls.filter(call => call.command === "app_dispatch").map(call => call.payload.request);
  assert.ok(requests.some(request => request.lane === "async-command" && request.payload.type === "attachment.put" && request.payload.expectedRevision === 7 && request.payload.bytes.$motionBytes.join(",") === "1,2,3"));
  assert.ok(requests.some(request => request.lane === "async-query" && request.payload.type === "backup.create"));
  assert.ok(requests.some(request => request.lane === "async-query" && request.payload.type === "backup.verify"));
  assert.ok(requests.some(request => request.lane === "async-query" && request.payload.type === "backup.preview"));
  assert.ok(requests.some(request => request.lane === "async-command" && request.payload.type === "backup.restore-new"));
});

test("native files are hashed and browser mode cannot fake attachments or verified backups", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const adapter = await readFile(resolve(root, "app-adapter.js"), "utf8");
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /if\(!confirm\(/);
  assert.match(adapter, /Attachments and verified backups require the native Motion application/);
});

test("hostile restores are closed-shape normalised before rendering", async () => {
  const { normalizeWorkspaceV1 } = await import("../workspace-v1.js");
  const hostile = JSON.parse(await readFile(resolve(root, "test/fixtures/hostile-xss.json"), "utf8"));
  const normalized = normalizeWorkspaceV1(hostile);
  assert.equal(normalized.pages[0].title, '\"><img src=x onerror=alert(1)>');
  assert.equal(normalized.pages[0].blocks[0].text, "<script>alert('xss')</script>");
  assert.equal("unexpectedHtml" in normalized.pages[0], false);
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /migrateLoaded\(normalizeWorkspaceV1\(candidate\)\)/);
  assert.match(source, /escapeHtml\(page\.title/);
  assert.match(source, /escapeHtml\(block\.text/);
  assert.match(source, /<span>\$\{escapeHtml\(label\)\}<\/span>/);
});

test("invalid hierarchy and duplicate IDs are rejected", async () => {
  const { normalizeWorkspaceV1 } = await import("../workspace-v1.js");
  for (const [fixture, pattern] of [["invalid-cycle.json", /hierarchy contains a cycle/], ["duplicate-id.json", /duplicate page ID/]]) {
    const value = JSON.parse(await readFile(resolve(root, `test/fixtures/${fixture}`), "utf8"));
    assert.throws(() => normalizeWorkspaceV1(value), pattern);
  }
});

test("hostile IDs cannot enter HTML attributes", async () => {
  const { normalizeWorkspaceV1 } = await import("../workspace-v1.js");
  assert.throws(() => normalizeWorkspaceV1({ schemaVersion: 1, activePageId: null, pages: [{ id: '\" onclick=alert(1)', parentId: null, order: 0, type: "document", title: "x", blocks: [] }] }), /safe stable ID/);
});

test("workspace backup and restore use a documented version marker", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /motion\.workspace\/2\.0/);
  assert.match(source, /exportWorkspace/);
  assert.match(source, /restoreWorkspace/);
});

test("document editor supports substantial block types and keyboard operations", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  for (const type of ["heading-1", "heading-2", "heading-3", "bulleted-list", "numbered-list", "task", "quote", "code", "divider"]) assert.match(source, new RegExp(type));
  assert.match(source, /event\.key==="Enter"/);
  assert.match(source, /event\.key==="Enter"/);
  assert.match(source, /structuredClone\(block\)/);
  assert.match(source, /history/);
  assert.match(source, /future/);
});

test("links are materialised by stable page ID and unknown blocks are preserved", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /block\.references/);
  assert.match(source, /function refreshReferences\(block\)/);
  assert.match(source, /pageId:/);
  assert.match(source, /unsupported/);
  assert.match(source, /linkIndex/);
});

test("page and block ordering have accessible controls", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /data-move-page/);
  assert.match(source, /data-move-block/);
  assert.match(source, /aria-label="Move/);
});

test("page deletion is reversible trash with stable content", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const normalizer = await readFile(resolve(root, "workspace-v1.js"), "utf8");
  assert.match(source, /async function trash\(page\)/);
  assert.match(source, /target\.deletedAt=stamp/);
  assert.match(source, /async function restore\(page\)/);
  assert.match(source, /delete target\.deletedAt/);
  assert.doesNotMatch(source, /workspace\(\)\.pages\s*=\s*workspace\(\)\.pages\.filter/);
  assert.match(source, /data-restore-page/);
  assert.match(normalizer, /page\.deleted = Boolean\(value\.deleted\)/);
  const { normalizeWorkspaceV1 } = await import("../workspace-v1.js");
  const saved = normalizeWorkspaceV1({ schemaVersion: 1, activePageId: null, pages: [{ id: "page-1", parentId: null, order: 0, type: "document", title: "Keep me", deleted: true, blocks: [{ id: "block-1", type: "paragraph", text: "Still here" }] }] });
  const reloaded = normalizeWorkspaceV1(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.pages[0].deleted, true);
  assert.equal(reloaded.pages[0].id, "page-1");
  assert.equal(reloaded.pages[0].blocks[0].text, "Still here");
});

test("search remains available when every page is in Trash", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const listener = source.slice(source.indexOf('document.addEventListener("input"'), source.indexOf('document.addEventListener("change"'));
  assert.ok(listener.indexOf('target.id==="searchInput"') < listener.indexOf("if(!page)return"),
    "search input must be handled before the no-active-page editor guard");
  assert.match(listener, /renderSearch\(target\.value\)/);
});
