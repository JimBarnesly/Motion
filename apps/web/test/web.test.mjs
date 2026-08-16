import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyLocalEdit } from "../browser-edit-confirmation.js";
import { decodeBinary } from "../app-adapter.js";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("entrypoint references only local assets", async () => {
  const html = await readFile(resolve(root, "index.html"), "utf8");
  assert.match(html, /\.\/styles\.css/);
  assert.match(html, /\.\/app\.js/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("Web build includes the shared ID security module", async () => {
  const build = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
  assert.match(build, /"id-security\.js"/);
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

test("saved-view selection stays bounded and browser property creation matches native all-view updates", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /entries\.slice\(-255\)/);
  assert.match(source, /for\(const view of database\.views\)\{view\.visiblePropertyIds\.push\(property\.id\);view\.propertyOrder\.push\(property\.id\);\}/);
  assert.doesNotMatch(source, /activeView\(database\)\.visiblePropertyIds\.push\(property\.id\)/);
});

test("column drag and keyboard alternatives persist the same canonical saved-view order", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /draggable="true" data-column-drag=/);
  assert.match(source, /data-column-move=/);
  assert.match(source, /text\/x-motion-column/);
  const updates = source.match(/updateView\(database,\{propertyOrder:order\}\)/g) ?? [];
  assert.equal(updates.length, 2);
});

test("schema-v2 typed edits use the canonical recoverable confirmation boundary", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const html = await readFile(resolve(root, "index.html"), "utf8");
  const build = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
  assert.match(source, /createEditRecoveryController/);
  assert.match(build, /edit-recovery\.js/);
  assert.match(source, /nativeCommands\.execute\(candidate\.type,candidate\.payload\)/);
  assert.match(source, /function queueCanonicalEdit/);
  assert.match(source, /function requireResolvedEdit/);
  assert.match(source, /window\.addEventListener\("beforeunload"/);
  assert.doesNotMatch(source, /alert\(error instanceof Error \? error\.message/);
  for (const action of ["exporting", "creating a backup", "restoring"]) assert.match(source, new RegExp(`runCanonicalOperation\\(\\"${action}`));
  for (const action of ["moving content to Trash", "leaving this page"]) assert.match(source, new RegExp(`requireResolvedEdit\\(\\"${action}`));
  assert.match(html, /id="editRecovery"[^>]*role="alert"/);
  assert.match(html, /id="retryEdit"/);
  assert.match(html, /id="discardEdit"/);
});

test("root creation is single-flight, truthful, rollback-safe, and restores deterministic focus", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const html = await readFile(resolve(root, "index.html"), "utf8");
  assert.match(source, /function findBlockLocation\(blocks,id,parent=null\)/);
  assert.match(source, /location\.blocks\.splice\(location\.index,1\)/);
  assert.match(source, /rootCreationInFlight/);
  assert.match(source, /const previous=structuredClone\(state\)/);
  assert.match(source, /let recovered=previous/);
  assert.match(source, /recovered=migrateLoaded\(await adapter\.load\(\)\)/);
  assert.match(source, /openPage\(created\.id\);renderNavigation\(\)/);
  assert.match(source, /created and saved\./);
  assert.match(source, /creation failed\. No content was added\./);
  assert.match(source, /requestAnimationFrame\(\(\)=>trigger\?\.focus\(\)\)/);
  assert.match(html, /id="addRootDatabase"[^>]*aria-label="New table"/);
});

test("canonical browser edits apply typed indent and outdent operations", () => {
  const first={id:"first",type:"paragraph",text:"Parent",children:[]},second={id:"second",type:"paragraph",text:"Child",children:[]};
  const document={workspace:{pages:[{id:"page",blocks:[first,second]}]}};
  applyLocalEdit(document,{type:"block.indent",payload:{pageId:"page",blockId:"second"}},"2026-08-13T00:00:00.000Z");
  assert.deepEqual(document.workspace.pages[0].blocks.map(block=>block.id),["first"]);
  assert.deepEqual(first.children.map(block=>block.id),["second"]);
  applyLocalEdit(document,{type:"block.outdent",payload:{pageId:"page",blockId:"second"}},"2026-08-13T00:00:01.000Z");
  assert.deepEqual(document.workspace.pages[0].blocks.map(block=>block.id),["first","second"]);
  assert.deepEqual(first.children,[]);

  const leaf={id:"leaf",type:"divider",children:[]},rejected={id:"rejected",type:"paragraph",text:"Remain",children:[]};
  const invalid={workspace:{pages:[{id:"leaf-page",blocks:[leaf,rejected]}]}};
  const before=structuredClone(invalid);
  assert.throws(
    ()=>applyLocalEdit(invalid,{type:"block.indent",payload:{pageId:"leaf-page",blockId:"rejected"}},"2026-08-13T00:00:02.000Z"),
    /Block type divider cannot contain children/
  );
  assert.deepEqual(invalid,before,"rejected browser indentation must be atomic");
});

test("canonical editor exposes non-trapping indent and outdent through typed commands", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /event\.altKey&&event\.key==="]"/);
  assert.match(source, /"block\.indent"/);
  assert.match(source, /event\.altKey&&event\.key==="\["/);
  assert.match(source, /"block\.outdent"/);
  assert.match(source, /aria-keyshortcuts="Alt\+BracketRight Alt\+BracketLeft"/);
  assert.match(source, /event\.key==="Tab"&&!mod&&!event\.altKey/);
  assert.match(source, /findByDataValue\("\[data-delete-block\]","deleteBlock",input\.dataset\.block\)/);
  assert.match(source, /render\(\);findByDataValue\("\[data-block\]","block",block\.id\)\?\.focus\(\);return;/);
  assert.doesNotMatch(source, /render\(\);requestAnimationFrame\(\(\)=>findByDataValue\("\[data-block\]","block",block\.id\)\?\.focus\(\)\);return;/);
  assert.match(source, /style="--indent:\$\{depth\}"/);
});

test("destructive block deletion and workspace replacement require cancellable confirmations", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /if\(button\.dataset\.deleteBlock\)\{if\(!confirm\("Permanently delete this block\? This cannot be undone\."\)\)/);
  assert.match(source, /if\(!confirm\("Replace the current workspace with the selected file\?"\)\)/);
  assert.match(source, /Restore cancelled\./);
  assert.match(source, /\$\("#restoreWorkspace"\)\?\.focus\(\)/);
  assert.match(source, /trashed=await trash\(pageById\(pageId\)\);if\(!trashed\)return;/);
  assert.match(source, /\(\$\("\[data-block\]"\) \?\? \$\("#addBlock"\)\)\?\.focus\(\)/);
});

test("native editor undo and redo use canonical page block replacement", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const build = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
  assert.match(source, /from "\.\/editor-history\.js"/);
  assert.match(build, /"editor-history\.js"/);
  assert.match(source, /confirmEditorHistory\(\{current:state,target/);
  assert.match(source, /nativeCommands\.execute\(type,payload\)/);
  assert.doesNotMatch(source, /Native undo requires typed command support and was not applied/);
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
    { command: "motion_ui_save", payload: { request: { document: { workspaceId: "workspace-1", activePageId: null, expandedPageIds: [], activeViewIds: {} }, schemaVersion: 2 } } },
    { command: "app_dispatch", payload: { request: { protocolVersion: 1, lane: "query", payload: { type: "workspace.search", workspaceId: "workspace-1", query: "match", limit: 50 } } } },
    { command: "app_dispatch", payload: { request: { protocolVersion: 1, lane: "query", payload: { type: "workspace.export", workspaceId: "workspace-1" } } } }
  ]);
});

test("native execute injects authoritative workspace fields and rejects commands outside its contract", async () => {
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    calls.push({ command, payload });
    if (payload?.request?.payload?.type === "workspace.list") return [{ id: "workspace-1", revision: 3 }];
    if (payload?.request?.payload?.type === "page.create") return { workspace: { id: "workspace-1" }, revision: 4, saved: true };
  } } } });
  await adapter.execute("page.create", { title: "Page", workspaceId: "caller-workspace", expectedRevision: 99 });
  const command = calls.find(call => call.payload?.request?.payload?.type === "page.create").payload.request.payload;
  assert.deepEqual(command, { type: "page.create", title: "Page", workspaceId: "workspace-1", expectedRevision: 3 });
  await assert.rejects(adapter.execute("workspace.import-web-v1", {}), /Unsupported native command/);
});

test("native whole-snapshot save fails closed and explicit Web-v1 import uses only its privileged lane", async () => {
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    calls.push({ command, payload });
    if (payload?.request?.lane === "web-v1-import") return { workspace: { id: "imported", pages: [], databases: [] }, revision: 1, activePageId: null, saved: true };
  } } } });
  const document = { schemaVersion: 1, pages: [], activePageId: null };

  await assert.rejects(adapter.save(document), /whole-workspace save is unavailable/);
  const imported = await adapter.importWebV1(document);

  assert.equal(imported.workspace.id, "imported");
  assert.deepEqual(calls, [{ command: "app_dispatch", payload: { request: { protocolVersion: 1, lane: "web-v1-import", payload: { type: "workspace.import-web-v1", document } } } }]);
  assert.equal(calls.some(call => call.command === "motion_ui_save"), false);
});

test("native workspace transitions reject malformed authoritative summaries", async () => {
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (_command, payload) => {
    if (payload?.request?.payload?.type === "workspace.import-web-v1") {
      return { workspace: { id: 123, pages: [], databases: [] }, revision: 1, saved: true };
    }
    throw new Error("Unexpected native call");
  } } } });

  await assert.rejects(
    adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null }),
    /invalid workspace summary/
  );
});

test("authoritative empty selection never falls back to the most recent workspace", async () => {
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    const operation = payload?.request?.payload;
    calls.push(operation?.type ?? command);
    if (command === "motion_ui_load") return { schemaVersion: 2, workspace: null, revision: 0, activePageId: null };
    if (operation?.type === "workspace.list") return [{ id: "workspace-B", revision: 9 }];
    if (operation?.type === "page.rename") return { workspace: { id: "workspace-B", pages: [], databases: [] }, revision: 10, saved: true };
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  await adapter.load();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(adapter.execute("page.rename", { pageId: "page-B", title: "Must not dispatch" }), /Create a workspace/);
  }
  assert.equal(calls.includes("workspace.list"), false);
  assert.equal(calls.includes("page.rename"), false);
});

test("failed-transition selection recovery is single-flight for concurrent commands", async () => {
  let loadCount = 0;
  let releaseRecovery;
  const recovery = new Promise(resolve => { releaseRecovery = resolve; });
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    const operation = payload?.request?.payload;
    calls.push(operation?.type ?? command);
    if (command === "motion_ui_load") {
      loadCount += 1;
      if (loadCount === 1) return { schemaVersion: 2, workspace: { id: "workspace-A", pages: [], databases: [] }, revision: 4 };
      return recovery;
    }
    if (operation?.type === "workspace.import-web-v1") throw new Error("transition failed");
    if (operation?.type === "page.rename") return { workspace: { id: "workspace-A", pages: [], databases: [] }, revision: 5, saved: true };
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  await adapter.load();
  await assert.rejects(adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null }), /transition failed/);
  const first = adapter.execute("page.rename", { pageId: "page-A", title: "First" });
  const second = adapter.execute("page.rename", { pageId: "page-A", title: "Second" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loadCount, 2);
  releaseRecovery({ schemaVersion: 2, workspace: null, revision: 0, activePageId: null });
  await assert.rejects(first, /Create a workspace/);
  await assert.rejects(second, /Create a workspace/);
  assert.equal(calls.includes("page.rename"), false);
});

test("a newer failed transition starts a fresh recovery instead of reusing a stale load", async () => {
  let loadCount = 0;
  let releaseStaleRecovery;
  const staleRecovery = new Promise(resolve => { releaseStaleRecovery = resolve; });
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    const operation = payload?.request?.payload;
    calls.push(operation?.type ?? command);
    if (command === "motion_ui_load") {
      loadCount += 1;
      if (loadCount === 1) return { schemaVersion: 2, workspace: { id: "workspace-A", pages: [], databases: [] }, revision: 4 };
      if (loadCount === 2) return staleRecovery;
      return { schemaVersion: 2, workspace: null, revision: 0, activePageId: null };
    }
    if (operation?.type === "workspace.import-web-v1") throw new Error("transition failed");
    if (operation?.type === "page.rename") return { workspace: { id: "workspace-A", pages: [], databases: [] }, revision: 5, saved: true };
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  await adapter.load();
  await assert.rejects(adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null }), /transition failed/);
  const staleCommand = adapter.execute("page.rename", { pageId: "page-A", title: "Stale" });
  const staleOutcome = staleCommand.then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loadCount, 2);

  await assert.rejects(adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null }), /transition failed/);
  const freshCommand = adapter.execute("page.rename", { pageId: "page-A", title: "Fresh" });
  const freshOutcome = freshCommand.then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loadCount, 3);
  assert.match((await freshOutcome).message, /Create a workspace/);

  releaseStaleRecovery({ schemaVersion: 2, workspace: { id: "workspace-A", pages: [], databases: [] }, revision: 4 });
  assert.match((await staleOutcome).message, /workspace changed/i);
  assert.equal(calls.includes("page.rename"), false);
});

test("failed workspace transitions reload the persisted selection before later commands", async () => {
  const calls = [];
  let loadCount = 0;
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    const operation = payload?.request?.payload;
    calls.push(operation?.type ?? command);
    if (command === "motion_ui_load") {
      loadCount += 1;
      return { schemaVersion: 2, workspace: { id: "workspace-A", pages: [], databases: [] }, revision: 4 };
    }
    if (operation?.type === "workspace.import-web-v1") throw new Error("response lost after transition");
    if (operation?.type === "workspace.list") return [{ id: "workspace-B", revision: 9 }, { id: "workspace-A", revision: 4 }];
    if (operation?.type === "page.rename") return { workspace: { id: "workspace-A", pages: [], databases: [] }, revision: 5, saved: true };
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  await adapter.load();
  await assert.rejects(adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null }), /response lost/);
  await adapter.execute("page.rename", { pageId: "page-A", title: "Recovered" });
  const rename = calls.includes("page.rename");
  assert.equal(rename, true);
  const dispatched = calls.filter(call => call === "workspace.list");
  assert.equal(dispatched.length, 0);
  assert.equal(loadCount, 2);
});

test("native commands cannot start while a workspace transition is in flight", async () => {
  let releaseImport;
  const importResponse = new Promise(resolve => { releaseImport = resolve; });
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    const operation = payload?.request?.payload;
    calls.push(operation?.type ?? command);
    if (command === "motion_ui_load") return { schemaVersion: 2, workspace: { id: "workspace-old", pages: [], databases: [] }, revision: 4 };
    if (operation?.type === "workspace.import-web-v1") return importResponse;
    if (operation?.type === "page.rename") return { workspace: { id: "workspace-old", pages: [], databases: [] }, revision: 5, saved: true };
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  await adapter.load();
  const pendingImport = adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null });
  await assert.rejects(adapter.execute("page.rename", { pageId: "page-old", title: "Must wait" }), /workspace changed while the operation was running/);
  assert.equal(calls.includes("page.rename"), false);
  releaseImport({ workspace: { id: "workspace-new", pages: [], databases: [] }, revision: 1, activePageId: null, saved: true });
  await pendingImport;
});

test("late native command response cannot switch the adapter back after Web-v1 import", async () => {
  let releaseRename;
  const renameResponse = new Promise(resolve => { releaseRename = resolve; });
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    calls.push({ command, payload });
    const operation = payload?.request?.payload;
    if (command === "motion_ui_load") return { schemaVersion: 2, workspace: { id: "workspace-old", pages: [], databases: [] }, revision: 4 };
    if (operation?.type === "page.rename") return renameResponse;
    if (operation?.type === "workspace.import-web-v1") return { workspace: { id: "workspace-new", pages: [], databases: [] }, revision: 1, activePageId: null, saved: true };
    if (operation?.type === "workspace.search") return [];
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  await adapter.load();
  const pendingRename = adapter.execute("page.rename", { pageId: "page-old", title: "Old response" });
  await adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null });
  releaseRename({ workspace: { id: "workspace-old", pages: [], databases: [] }, revision: 5, saved: true });

  await assert.rejects(pendingRename, /workspace changed while the operation was running/);
  await adapter.search("new workspace");
  const search = calls.find(call => call.payload?.request?.payload?.type === "workspace.search").payload.request.payload;
  assert.equal(search.workspaceId, "workspace-new");
});

test("late workspace discovery cannot dispatch an old-workspace command after import", async () => {
  let releaseWorkspaceList;
  const workspaceList = new Promise(resolve => { releaseWorkspaceList = resolve; });
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    const operation = payload?.request?.payload;
    calls.push(operation?.type ?? command);
    if (operation?.type === "workspace.list") return workspaceList;
    if (operation?.type === "workspace.import-web-v1") return { workspace: { id: "workspace-new", pages: [], databases: [] }, revision: 1, activePageId: null, saved: true };
    if (operation?.type === "page.rename") return { workspace: { id: "workspace-old", pages: [], databases: [] }, revision: 5, saved: true };
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  const pendingRename = adapter.execute("page.rename", { pageId: "page-old", title: "Must not dispatch" });
  await adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null });
  releaseWorkspaceList([{ id: "workspace-old", revision: 4 }]);

  await assert.rejects(pendingRename, /workspace changed while the operation was running/);
  assert.equal(calls.includes("page.rename"), false);
});

test("late attachment response cannot reactivate its old workspace after import", async () => {
  let releaseAttachment;
  const attachmentResponse = new Promise(resolve => { releaseAttachment = resolve; });
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    const operation = payload?.request?.payload;
    calls.push(operation);
    if (command === "motion_ui_load") return { schemaVersion: 2, workspace: { id: "workspace-old", pages: [], databases: [] }, revision: 4 };
    if (operation?.type === "attachment.ingest-block") return attachmentResponse;
    if (operation?.type === "workspace.import-web-v1") return { workspace: { id: "workspace-new", pages: [], databases: [] }, revision: 1, activePageId: null, saved: true };
    if (operation?.type === "workspace.search") return [];
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  await adapter.load();
  const pendingAttachment = adapter.ingestAttachmentBlock({ pageId: "page-old", position: { parentBlockId: null, beforeBlockId: null }, fileName: "old.txt", mediaType: "text/plain", sha256: "a".repeat(64), bytes: new Uint8Array([1]) });
  await adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null });
  releaseAttachment({ workspace: { id: "workspace-old", pages: [], databases: [] }, revision: 5, saved: true });

  await assert.rejects(pendingAttachment, /workspace changed while the operation was running/);
  await adapter.search("new workspace");
  assert.equal(calls.find(call => call?.type === "workspace.search").workspaceId, "workspace-new");
});

test("attachment ingestion is wired through the canonical lease and explicit file rendering", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /runCanonical:runCanonicalOperation/);
  assert.match(source, /authority:\(\)=>\(\{workspaceId:workspace\(\)\?\.id,pageId:activePage\(\)\?\.id,revision:state\.revision\}\)/);
  assert.match(source, /block\.type==="file"/);
  assert.match(source, /Attachment unavailable/);
  assert.doesNotMatch(source, /block\.type==="file"[\s\S]{0,500}contenteditable="true"/);
});

test("older concurrent import cannot overwrite the workspace selected by the newer import", async () => {
  const releases = [];
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (_command, payload) => {
    const operation = payload.request.payload;
    calls.push(operation);
    if (operation.type === "workspace.import-web-v1") return new Promise(resolve => releases.push(resolve));
    if (operation.type === "workspace.search") return [];
    throw new Error(`Unexpected native call: ${operation.type}`);
  } } } });

  const older = adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null });
  const newer = adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null });
  releases[1]({ workspace: { id: "workspace-newer", pages: [], databases: [] }, revision: 1, activePageId: null, saved: true });
  await newer;
  releases[0]({ workspace: { id: "workspace-older", pages: [], databases: [] }, revision: 1, activePageId: null, saved: true });

  await assert.rejects(older, /workspace changed while the operation was running/);
  await adapter.search("selected workspace");
  assert.equal(calls.find(call => call.type === "workspace.search").workspaceId, "workspace-newer");
});

test("search results from the prior workspace are rejected after import", async () => {
  let releaseSearch;
  const searchResponse = new Promise(resolve => { releaseSearch = resolve; });
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    const operation = payload?.request?.payload;
    if (command === "motion_ui_load") return { schemaVersion: 2, workspace: { id: "workspace-old", pages: [], databases: [] }, revision: 4 };
    if (operation?.type === "workspace.search") return searchResponse;
    if (operation?.type === "workspace.import-web-v1") return { workspace: { id: "workspace-new", pages: [], databases: [] }, revision: 1, activePageId: null, saved: true };
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  await adapter.load();
  const pendingSearch = adapter.search("old content");
  await adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null });
  releaseSearch([{ workspaceId: "workspace-old", entityId: "secret-old", title: "Old", snippet: "Old" }]);

  await assert.rejects(pendingSearch, /workspace changed while the operation was running/);
});

test("native mutation responses must advance the selected workspace revision", async () => {
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    const operation = payload?.request?.payload;
    if (command === "motion_ui_load") return { schemaVersion: 2, workspace: { id: "workspace-A", pages: [], databases: [] }, revision: 4 };
    if (operation?.type === "page.rename") return { workspace: { id: "workspace-A", pages: [], databases: [] }, revision: 4, saved: true };
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  await adapter.load();
  await assert.rejects(adapter.execute("page.rename", { pageId: "page-A", title: "Stale" }), /non-monotonic workspace revision/);
});

test("workspace transitions and UI selection writes are mutually exclusive", async () => {
  let releaseUiSave;
  let releaseImport;
  const uiSaveResponse = new Promise(resolve => { releaseUiSave = resolve; });
  const importResponse = new Promise(resolve => { releaseImport = resolve; });
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    const operation = payload?.request?.payload;
    calls.push(operation?.type ?? command);
    if (command === "motion_ui_load") return { schemaVersion: 2, workspace: { id: "workspace-A", pages: [], databases: [] }, revision: 4 };
    if (command === "motion_ui_save") return uiSaveResponse;
    if (operation?.type === "workspace.import-web-v1") return importResponse;
    throw new Error(`Unexpected native call: ${operation?.type ?? command}`);
  } } } });

  await adapter.load();
  const pendingUiSave = adapter.saveUi({ workspaceId: "workspace-A", activePageId: null, expandedPageIds: [] });
  await assert.rejects(adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null }), /workspace selection update is running/);
  assert.equal(calls.includes("workspace.import-web-v1"), false);
  releaseUiSave();
  await pendingUiSave;

  const pendingImport = adapter.importWebV1({ schemaVersion: 1, pages: [], activePageId: null });
  await assert.rejects(adapter.saveUi({ workspaceId: "workspace-A", activePageId: null, expandedPageIds: [] }), /workspace changed while the operation was running/);
  assert.equal(calls.filter(call => call === "motion_ui_save").length, 1);
  releaseImport({ workspace: { id: "workspace-B", pages: [], databases: [] }, revision: 1, saved: true });
  await pendingImport;
});

test("native UI-state save rejects canonical snapshots and bounds its exact ephemeral allowlist", async () => {
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => calls.push({ command, payload }) } } });
  await assert.rejects(adapter.saveUi({ workspaceId: "workspace-1", activePageId: null, expandedPageIds: [], pages: [] }), /Invalid UI state request/);
  await assert.rejects(adapter.saveUi({ workspaceId: "workspace-1", activePageId: null, expandedPageIds: Array.from({ length: 257 }, (_, index) => `page-${index}`) }), /Invalid UI state request/);
  await assert.rejects(adapter.saveUi({ workspaceId: "workspace-1", activePageId: null, expandedPageIds: [], activeViewIds: { "bad/id": "view-1" } }), /Invalid UI state request/);
  await assert.rejects(adapter.saveUi({ workspaceId: "workspace-1", activePageId: null, expandedPageIds: [], activeViewIds: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`database-${index}`, `view-${index}`])) }), /Invalid UI state request/);
  assert.deepEqual(calls, []);
});

test("normal native page and block editing source never calls whole-document save or import", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const adapter = await readFile(resolve(root, "app-adapter.js"), "utf8");
  assert.match(source, /block\.update-content/);
  assert.match(source, /block\.transform/);
  assert.match(source, /block\.create/);
  assert.match(source, /block\.delete/);
  assert.match(source, /saveLocal\(document=structuredClone\(state\)\) \{ if \(adapter\.kind !== "browser-development"\) return/);
  const nativeCommit=source.slice(source.indexOf("async function commit"),source.indexOf("async function confirmCanonicalEdit"));
  assert.doesNotMatch(nativeCommit, /adapter\.save/);
  assert.doesNotMatch(source, /adapter\.execute\(["']workspace\.import-web-v1/);
  assert.match(source, /confirmEditorHistory\(\{current:state,target/);
  assert.match(source, /nativeCommands\.execute\(type,payload\)/);
  assert.match(source, /function rebuildLinks\(\) \{ if \(adapter\.kind === "tauri"\) return;/);
  assert.match(source, /nativeCommands\.execute\("workspace\.create"/);
  assert.equal([...source.matchAll(/adapter\.execute\(/g)].length, 1);
  assert.match(source, /createNativeCommandController\(\{execute:\(type,payload\)=>adapter\.execute\(type,payload\)/);
});

test("native adapter declaration exhaustively types the synchronous service surface except the privileged Web-v1 import lane", async () => {
  const declaration = await readFile(resolve(root, "app-adapter.d.ts"), "utf8");
  const source = await readFile(resolve(root, "app-adapter.js"), "utf8");
  const serviceSource = await readFile(resolve(root, "../../packages/app-service/src/index.ts"), "utf8");
  const operations = [
    "workspace.create", "page.create", "page.rename", "page.move", "page.reorder", "page.set-favourite", "page.trash", "page.restore", "page.replace-blocks",
    "block.create", "block.update-content", "block.transform", "block.move", "block.indent", "block.outdent", "block.duplicate", "block.delete", "block.batch",
    "database.create", "database.property-add", "database.property-update", "database.property-reorder", "database.property-delete", "database.record-create", "database.record-update", "database.record-reorder",
    "database.view-create", "database.view-update", "database.view-duplicate", "database.view-reorder", "database.view-delete"
  ];
  const blockOperations = serviceSource.match(/export type BlockOperation =([\s\S]*?)export type BlockCommand/)?.[1];
  const appCommands = serviceSource.match(/export type AppCommand =([\s\S]*?)export type AsyncAppCommand/)?.[1];
  assert.ok(blockOperations && appCommands, "app-service command unions must remain statically discoverable");
  const serviceOperations = new Set([
    ...[...blockOperations.matchAll(/type: "([^"]+)"/g)].map(match => match[1]),
    "block.batch",
    ...[...appCommands.matchAll(/type: "([^"]+)"/g)].map(match => match[1])
  ]);
  assert.equal(serviceOperations.has("workspace.import-web-v1"), true, "the service retains its privileged migration command");
  serviceOperations.delete("workspace.import-web-v1"); // Deliberately desktop-internal: the UI adapter must not expose raw document import.
  assert.deepEqual([...operations].sort(), [...serviceOperations].sort());
  const { NATIVE_EXECUTE_OPERATIONS } = await import("../app-adapter.js");
  assert.deepEqual(NATIVE_EXECUTE_OPERATIONS, operations);
  assert.match(declaration, /NativeBlockOperation/);
  assert.match(declaration, /"block\.batch": \{ commands: readonly NativeBlockOperation\[\] \}/);
  for (const operation of operations) {
    assert.match(declaration, new RegExp(`"${operation.replace(".", "\\.")}"`));
    assert.match(source, new RegExp(`"${operation.replace(".", "\\.")}"`));
  }
  assert.match(declaration, /NativeCommandContractAssertion = AssertTrue/);
  assert.match(declaration, /execute<C extends keyof NativeCommandPayloads>\(type: C, payload: NativeCommandPayloads\[C\]\): Promise<NativeCommandResults\[C\]>/);
  assert.match(declaration, /type MotionUiAdapter = TauriMotionUiAdapter \| BrowserDevelopmentMotionUiAdapter/);
  assert.doesNotMatch(declaration, /BrowserDevelopmentMotionUiAdapter[^}]+execute/s);
});

test("search and export use canonical native queries with honest browser fallbacks", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const adapter = await readFile(resolve(root, "app-adapter.js"), "utf8");
  assert.match(adapter, /type: "workspace\.search"/);
  assert.match(adapter, /type: "workspace\.export"/);
  assert.match(source, /adapter\.kind === "tauri"/);
  assert.match(source, /motion-browser-development/);
  assert.match(source, /buildBrowserSearchHits\(workspace\(\),term,50\)/);
  assert.match(source, /normalizeSearchHits\(raw\?\?\[\],50\)/);
});

test("native attachment and verified backup operations use revisioned typed lanes", async () => {
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "app_dispatch" && payload.request.payload.type === "workspace.list") return [{ id: "workspace-1", revision: 7 }];
    if (payload?.request?.payload?.type === "attachment.ingest-block") return { revision: 8, workspace: { id: "workspace-1", attachments: [{ id: "attachment-1", fileName: "proof.txt", byteLength: 3, sha256: "a".repeat(64) }] } };
    if (payload?.request?.payload?.type === "attachment.read") return { attachment: { id: "attachment-1" }, bytes: { $motionBytes: [1, 2, 3] } };
    if (payload?.request?.payload?.type === "backup.create") return { manifest: { files: [] }, files: {} };
    if (payload?.request?.payload?.type === "backup.verify") return { valid: true, errors: [] };
    if (payload?.request?.payload?.type === "backup.preview") return { valid: true, pages: 1, attachments: 1, totalBytes: 3 };
    if (payload?.request?.payload?.type === "backup.restore-new") return { revision: 1, workspace: { id: "workspace-restored", pages: [], databases: [] }, saved: true };
  };
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke } } });
  const bundle = await adapter.createBackup();
  const attachment = await adapter.readAttachment("attachment-1");
  assert.ok(attachment.bytes instanceof Uint8Array);
  assert.deepEqual([...attachment.bytes], [1, 2, 3]);
  await adapter.ingestAttachmentBlock({ pageId: "page-1", position: { parentBlockId: null, beforeBlockId: null }, fileName: "proof.txt", mediaType: "text/plain", sha256: "a".repeat(64), bytes: Uint8Array.from([1, 2, 3]) });
  await adapter.verifyBackup(bundle); await adapter.previewBackup(bundle); await adapter.restoreBackup(bundle);
  const requests = calls.filter(call => call.command === "app_dispatch").map(call => call.payload.request);
  assert.ok(requests.some(request => request.lane === "async-command" && request.payload.type === "attachment.ingest-block" && request.payload.expectedRevision === 7
    && request.payload.pageId === "page-1" && request.payload.bytes.$motionBytes.join(",") === "1,2,3"));
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
  assert.match(source, /const legacy=normalizeWorkspaceV1\(candidate\)/);
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

test("hostile and oversized Web-v1 IDs cannot enter HTML attributes", async () => {
  const { normalizeWorkspaceV1 } = await import("../workspace-v1.js");
  const candidate = id => ({ schemaVersion: 1, activePageId: null, pages: [{ id, parentId: null, order: 0, type: "document", title: "x", blocks: [] }] });
  for (const hostile of ['\" onclick=alert(1)', " page", "page ", "p".repeat(129)]) assert.throws(() => normalizeWorkspaceV1(candidate(hostile)), /safe stable ID/);
});

test("workspace backup and restore use a documented version marker", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /motion\.workspace\/2\.0/);
  assert.match(source, /exportWorkspace/);
  assert.match(source, /restoreWorkspace/);
});

test("canonical operations are coordinated across their async boundaries", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /createOperationCoordinator/);
  assert.match(source, /runCanonicalOperation\("exporting"/);
  assert.match(source, /runCanonicalOperation\("creating a backup"/);
  assert.match(source, /runCanonicalOperation\("restoring"/);
});

test("different-key edit rejection preserves pending metadata and avoids a full render", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const queue = source.slice(source.indexOf("function queueCanonicalEdit"), source.indexOf("function requireResolvedEdit"));
  assert.match(queue, /if\(editRecovery\.update\([^)]+\)\)\{activeEditMeta=/);
  assert.match(queue, /restoreRejectedEditTarget/);
  assert.doesNotMatch(queue, /\brender\(\)/);
});

test("document editor supports substantial block types and keyboard operations", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  for (const type of ["heading-1", "heading-2", "heading-3", "bulleted-list", "numbered-list", "task", "quote", "code", "divider"]) assert.match(source, new RegExp(type));
  assert.match(source, /event\.key==="Enter"/);
  assert.match(source, /splitBlockCommands\(\{pageId:page\.id,block,offset,/);
  assert.match(source, /candidate:\{type:"block\.batch",payload:\{commands:split\.commands\}\}/);
  assert.match(source, /if\(await flushCanonicalEdit\("focusing the new block"\)\)requestAnimationFrame/);
  assert.match(source, /event\.key==="Backspace"/);
  assert.match(source, /selectionIsCollapsedIn\(input\)/);
  assert.match(source, /mergeAdjacentBlockCommands\(\{pageId:page\.id,previousBlock,currentBlock:block\}\)/);
  assert.match(source, /candidate:\{type:"block\.batch",payload:\{commands:merge\.commands\}\}/);
  assert.match(source, /focusBlockAtOffset\(merge\.focusBlockId,merge\.focusOffset\)/);
  assert.match(source, /structuredClone\(block\)/);
  assert.match(source, /history/);
  assert.match(source, /future/);
});

test("structural keyboard editing flushes canonical text before creating another block", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const keydown = source.slice(
    source.indexOf('document.addEventListener("keydown",async event=>'),
    source.indexOf("async function renderSearch")
  );

  assert.match(source, /async function flushCanonicalEdit[\s\S]*await editRecovery\.commit\(\)/);
  assert.match(keydown, /await flushCanonicalEdit\("continuing"\)/);
  assert.match(keydown, /if\(!await flushCanonicalEdit\("continuing"\)\)return;page=activePage\(\);flat=flattenBlocks\(page\.blocks,\[\]\);at=flat\.findIndex\(candidate=>candidate\.id===input\.dataset\.block\);block=flat\[at\]/);
  assert.ok(
    keydown.indexOf('await flushCanonicalEdit("continuing")') < keydown.indexOf("splitBlockCommands("),
    "the current text must be confirmed before the block is split"
  );
});

test("Markdown shortcuts are persisted as one canonical block batch", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const build = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
  assert.match(source, /markdownShortcutCommand\(\{pageId:page\.id,block:draft\}\)/);
  assert.match(source, /candidate:\{type:shortcut\.type,payload:\{commands:shortcut\.commands\}\}/);
  assert.match(build, /editor-structure\.js/);
});

test("document editor handles multiline paste through one canonical block batch", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const build = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
  assert.match(source, /from "\.\/markdown-paste\.js"/);
  assert.match(source, /addEventListener\("paste"/);
  assert.ok(source.indexOf('event.preventDefault();let commands;try{commands=multilinePasteCommands') > -1);
  assert.match(source, /selectionTextParts\(input\)/);
  assert.match(source, /resolveReferences:referencesForText/);
  assert.match(source, /candidate:\{type:"block\.batch"/);
  assert.match(build, /markdown-paste\.js/);
});

test("links are materialised by stable page ID and unknown blocks are preserved", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /block\.references/);
  assert.match(source, /reconcileTextReferences\(\{previousText:block\.text,previousReferences:block\.references,nextText:draft\.text,pages:workspace\(\)\.pages\}\)/);
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
test("verified backup JSON revives attachment payload byte envelopes", () => {
  const restored = decodeBinary(JSON.parse('{"files":{"attachment":{"$motionBytes":[0,127,255]}}}'));
  assert.deepEqual(restored.files.attachment, Uint8Array.of(0, 127, 255));
});

test("verified backup creation delegates publication to the native safe-save boundary", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(source, /await adapter\.saveBackup\(bundle\)/);
  assert.match(source, /Verified backup saved safely\./);
  assert.match(source, /Verified backup restored\./);
  assert.match(source, /Workspace restored\./);
  assert.doesNotMatch(source, /createVerifiedBackup[^\n]+downloadJson\(bundle/);
});

test("workspace tools remain keyboard-disclosed and database action IDs are unique", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(html, /<details class="workspace-tools">\s*<summary>Workspace tools<\/summary>/);
  const viewToolbar = source.match(/function viewToolbar\(database,view\)\{[^\n]+/)?.[0] ?? "";
  const renderDatabase = source.match(/function renderDatabase\(page,database\)\{[^\n]+/)?.[0] ?? "";
  const databaseMarkup = `${viewToolbar}\n${renderDatabase}`;
  for (const id of ["filterButton", "sortButton", "addProperty", "viewControls"])
    assert.equal(databaseMarkup.match(new RegExp(`id=\\"${id}\\"`, "g"))?.length, 1, `${id} must be unique`);
});
