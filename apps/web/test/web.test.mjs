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

test("workspace persistence uses an explicit async native/browser adapter", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const adapter = await readFile(resolve(root, "app-adapter.js"), "utf8");
  assert.match(source, /createMotionUiAdapter/);
  assert.match(adapter, /motion_ui_load/);
  assert.match(adapter, /motion_ui_save/);
  assert.match(adapter, /browser-development/);
  assert.match(adapter, /indexedDB\.open/);
  assert.doesNotMatch(source + adapter, /localStorage/);
  assert.match(adapter, /schemaVersion:\s*1/);
});

test("native adapter sends versioned typed IPC envelopes", async () => {
  const calls = [];
  const { createMotionUiAdapter } = await import("../app-adapter.js");
  const workspace = { schemaVersion: 1, pages: [], activePageId: null };
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, payload) => {
    calls.push({ command, payload });
    return command === "motion_ui_load" ? workspace : undefined;
  } } } });
  assert.equal(adapter.kind, "tauri");
  assert.deepEqual(await adapter.load(), workspace);
  await adapter.save(workspace);
  assert.deepEqual(calls, [
    { command: "motion_ui_load", payload: { schemaVersion: 1 } },
    { command: "motion_ui_save", payload: { document: workspace, schemaVersion: 1 } }
  ]);
});

test("workspace backup and restore use a documented version marker", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /motion\.workspace\/1\.0/);
  assert.match(source, /exportWorkspace/);
  assert.match(source, /restoreWorkspace/);
});

test("document editor supports substantial block types and keyboard operations", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  for (const type of ["heading1", "heading2", "heading3", "bullet", "number", "task", "toggle", "quote", "code", "divider"]) assert.match(source, new RegExp(`\\b${type}\\b`));
  assert.match(source, /event\.key === "Enter"/);
  assert.match(source, /event\.key === "Tab"/);
  assert.match(source, /structuredClone\(block\)/);
  assert.match(source, /function undo\(\)/);
  assert.match(source, /function redo\(\)/);
});

test("links are materialised by stable page ID and unknown blocks are preserved", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /block\.links/);
  assert.match(source, /pageId:/);
  assert.match(source, /known \? block\.type : "unknown"/);
  assert.match(source, /broken-link/);
});

test("page and block ordering have accessible controls", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /data-move-page/);
  assert.match(source, /data-move-block/);
  assert.match(source, /aria-label="Move/);
});
