import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLinkTarget,
  buildLinkTargetChoices,
  findLinkTrigger,
  reconcileLinkReferences
} from "../link-entry.js";

const pages = [
  { id: "source", title: "Source", blocks: [] },
  { id: "page-target", title: "Project notes", blocks: [] },
  { id: "database-page", title: "Projects", blocks: [] },
  { id: "trashed", title: "Old project", deletedAt: "2026-08-12T00:00:00.000Z", blocks: [] }
];
const databases = [{ id: "database-id", pageId: "database-page", name: "Projects" }];

test("double bracket entry offers live pages and databases by stable page identity", () => {
  assert.deepEqual(findLinkTrigger("Review [[pro"), { start: 7, query: "pro" });
  assert.deepEqual(buildLinkTargetChoices({ pages, databases, currentPageId: "source", query: "pro" }), [
    { pageId: "page-target", title: "Project notes", kind: "page" },
    { pageId: "database-page", title: "Projects", kind: "database" }
  ]);
});

test("selecting a database inserts its current title but persists its canonical backing page ID", () => {
  const result = applyLinkTarget({
    text: "Review [[pro after",
    trigger: { start: 7, query: "pro" },
    replaceEnd: 12,
    target: { pageId: "database-page", title: "Projects", kind: "database" },
    references: [{ pageId: "existing" }]
  });

  assert.deepEqual(result, {
    text: "Review [[Projects]] after",
    caret: 19,
    references: [{ pageId: "existing" }, { pageId: "database-page", start: 7, end: 19 }]
  });
});

test("selection shifts later references and preserves repeated links to the same target", () => {
  assert.deepEqual(applyLinkTarget({
    text: "[[pro then [[Projects]]",
    trigger: { start: 0, query: "pro" },
    replaceEnd: 5,
    target: { pageId: "database-page", title: "Projects", kind: "database" },
    references: [{ pageId: "database-page", start: 11, end: 23 }],
    pages
  }).references, [
    { pageId: "database-page", start: 18, end: 30 },
    { pageId: "database-page", start: 0, end: 12 }
  ]);
});

test("stable ranged references survive duplicate titles and disappear with their link text", () => {
  const duplicatePages = [...pages, { id: "other-database-page", title: "Projects", blocks: [] }];
  assert.deepEqual(reconcileLinkReferences({
    previousText: "Review [[Projects]]",
    text: "Today: Review [[Projects]]",
    references: [{ pageId: "database-page", start: 7, end: 19 }],
    pages: duplicatePages
  }), [{ pageId: "database-page", start: 14, end: 26 }]);
  assert.deepEqual(reconcileLinkReferences({
    previousText: "Review [[Projects]]",
    text: "Review complete",
    references: [{ pageId: "database-page", start: 7, end: 19 }],
    pages: duplicatePages
  }), []);
});

test("legacy stable references survive unrelated edits after target rename", () => {
  assert.deepEqual(reconcileLinkReferences({
    previousText: "See [[Old title]]",
    text: "Note: See [[Old title]]",
    references: [{ pageId: "database-page" }],
    pages
  }), [{ pageId: "database-page" }]);
});

test("the Web editor exposes a keyboard-operable stable link chooser", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");

  assert.match(source, /from "\.\/link-entry\.js"/);
  assert.match(source, /function renderLinkPicker/);
  assert.match(source, /function selectLinkTarget/);
  assert.match(source, /button\.dataset\.linkTarget/);
  assert.match(source, /event\.key==="ArrowDown"/);
  assert.match(source, /event\.key==="Enter"/);
  assert.match(source, /references:result\.references/);
  assert.match(html, /id="linkPicker"[^>]+role="listbox"/);
  assert.match(styles, /\.link-picker/);
  assert.match(build, /"link-entry\.js"/);
});
