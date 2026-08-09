import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const appPath = resolve(import.meta.dirname, "../app.js");

test("table-row deletion requires confirmation and creates an undo checkpoint", async () => {
  const source = await readFile(appPath, "utf8");
  const handler = source.match(/if \(el\.dataset\.deleteRow[\s\S]*?\n/)?.[0] ?? "";

  assert.match(handler, /confirm\("Permanently delete this table row\? This cannot be undone\."\)/);
  assert.match(handler, /checkpoint\(\)/);
  assert.match(handler, /page\.rows = page\.rows\.filter/);
});
