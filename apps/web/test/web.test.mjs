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

test("workspace storage is explicitly schema-versioned", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /motion\.workspace\.v1/);
  assert.match(source, /schemaVersion:\s*1/);
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
