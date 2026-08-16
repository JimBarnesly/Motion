import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { activeMentionQuery, applyMentionSelection, missingWikiPageTitle } from "../mention-entry.js";

test("typing an at-sign followed by text exposes a mention query", () => {
  assert.deepEqual(activeMentionQuery("Discuss @Tar", 12), {
    start: 8,
    end: 12,
    query: "Tar"
  });
  assert.equal(activeMentionQuery("mail@example.test", 17), null);
});

test("typing an open wiki link exposes a stable page selection query", () => {
  assert.deepEqual(activeMentionQuery("Discuss [[Tar", 13), {
    start: 8,
    end: 13,
    query: "Tar",
    kind: "wiki"
  });
});

test("wiki creation offers the exact bounded non-empty title only when no live exact match exists", () => {
  const mention = { start: 8, end: 21, query: "second page", kind: "wiki" };
  assert.equal(missingWikiPageTitle({ mention, pages: [{ id: "other", title: "Second page" }] }), "second page");
  assert.equal(missingWikiPageTitle({ mention, pages: [{ id: "exact", title: "second page" }] }), null);
  assert.equal(missingWikiPageTitle({ mention: { ...mention, query: "   " }, pages: [] }), null);
  assert.equal(missingWikiPageTitle({ mention: { ...mention, query: "x".repeat(200) }, pages: [] }), "x".repeat(200));
  assert.equal(missingWikiPageTitle({ mention: { ...mention, query: "x".repeat(201) }, pages: [] }), null);
  assert.equal(missingWikiPageTitle({ mention: { start: 0, end: 4, query: "new" }, pages: [] }), null);
});

test("wiki selection records the selected stable ID even when titles are duplicated", () => {
  assert.deepEqual(applyMentionSelection({
    text: "Discuss [[Tar",
    mention: { start: 8, end: 13, query: "Tar", kind: "wiki" },
    page: { id: "selected-duplicate", title: "Target" }
  }), {
    text: "Discuss [[Target]]",
    references: [{ pageId: "selected-duplicate", start: 8, end: 18 }]
  });
});

test("mention selection preserves the selected stable ID for duplicate and delimiter-bearing titles", () => {
  const mention = { start: 8, end: 12, query: "Tar" };
  assert.deepEqual(applyMentionSelection({ text: "Discuss @Tar", mention, page: { id: "selected", title: "Target" } }), {
    text: "Discuss @[Target]",
    references: [{ pageId: "selected", start: 8, end: 17 }]
  });
  assert.deepEqual(applyMentionSelection({ text: "Discuss @Tar", mention, page: { id: "selected-bracket", title: "A]B" } }), {
    text: "Discuss @[A\\]B]",
    references: [{ pageId: "selected-bracket", start: 8, end: 15 }]
  });
});

test("mention selection preserves unrelated ranged and positionless stable references", () => {
  const result = applyMentionSelection({
    text: "[[Before]] @Tar [[After]]",
    mention: { start: 11, end: 15, query: "Tar" },
    page: { id: "selected", title: "Target" },
    previousReferences: [
      { pageId: "before", start: 0, end: 10 },
      { pageId: "legacy-positionless" },
      { pageId: "after", start: 16, end: 25 }
    ]
  });

  assert.deepEqual(result.references, [
    { pageId: "before", start: 0, end: 10 },
    { pageId: "legacy-positionless" },
    { pageId: "after", start: 21, end: 30 },
    { pageId: "selected", start: 11, end: 20 }
  ]);
});

test("the editor exposes an accessible at-mention chooser and persists the selected stable identity", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");

  assert.match(source, /activeMentionQuery\(input\.textContent,caretOffset\(input\)\)/);
  assert.match(source, /renderMentionChooser\(target\)/);
  assert.match(source, /applyMentionSelection\(\{text:input\.textContent,mention,page,previousReferences:block\.references\}\)/);
  assert.match(source, /selected\.references/);
  assert.match(source, /button\.dataset\.mentionPage=page\.id/);
  assert.match(source, /missingWikiPageTitle\(\{mention:activeMention,pages:visiblePages\(\)\}\)/);
  assert.match(source, /button\.dataset\.createMentionPage=creationTitle/);
  assert.match(source, /Create page “\$\{creationTitle\}”/);
  assert.match(source, /async function createMentionPage\(title\)[^{]*\{[^}]*visiblePages\(\)\.find\(page=>page\.title===title\)[^}]*selectMentionPage\(exact\)/);
  assert.match(source, /runCanonicalOperation\("creating linked page"/);
  assert.match(source, /commit\("page\.create",\{title,parentId:null\}/);
  assert.match(source, /event\.key==="ArrowDown"&&activeMention/);
  assert.match(source, /Type '\/' for commands or \[\[Page name\]\] to link or create/);
  assert.match(html, /id="mentionChooser"[^>]+role="listbox"/);
  assert.match(build, /"mention-entry\.js"/);
});
