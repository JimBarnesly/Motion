import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const appPath = resolve(import.meta.dirname, "../app.js");

test("table records use confirmed, undo-checkpointed trash instead of permanent row deletion", async () => {
  const source = await readFile(appPath, "utf8");
  const rowRenderer = source.match(/const rows=items[\s\S]*?\$\("#content"\)/)?.[0] ?? "";
  const handler = source.match(/if\(button\.dataset\.trashPage&&confirm\("Move this page to Trash\?"\)\)[^\n]*/)?.[0] ?? "";
  const trash = source.match(/async function trash\(page\)[\s\S]*?\n/)?.[0] ?? "";

  assert.match(rowRenderer, /data-trash-page="\$\{record\.id\}"/);
  assert.match(handler, /confirm\("Move this page to Trash\?"\)/);
  assert.match(trash, /checkpoint\(\)/);
  assert.match(trash, /"page\.trash"/);
});
