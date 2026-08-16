import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("confirmed page-title edits preserve the live input instead of replacing it", () => {
  const handler = source.match(/if\(target\.id==="pageTitle"\)\{[\s\S]*?return;\}/)?.[0];
  assert.ok(handler, "page-title input handler must exist");
  assert.doesNotMatch(handler, /rerender:true/, "a successful keystroke must not replace the focused title input");
  assert.match(source, /function refreshPageTitlePresentation\(pageId\)/);
  assert.match(source, /if\(meta\?\.target\?\.kind==="page-title"\)refreshPageTitlePresentation\(meta\.target\.pageId\)/);
});

test("slow title typing remains covered by browser acceptance", async () => {
  const e2e = await readFile(new URL("../../../e2e/page-title-edit.spec.ts", import.meta.url), "utf8");
  assert.match(e2e, /Database title/);
  assert.match(e2e, /pressSequentially\("Todo"/);
  assert.match(e2e, /toHaveValue\("Todo"\)/);
});
