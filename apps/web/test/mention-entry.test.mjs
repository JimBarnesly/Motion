import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { activeMentionQuery, applyMentionSelection } from "../mention-entry.js";

test("typing an at-sign followed by text exposes a mention query", () => {
  assert.deepEqual(activeMentionQuery("Discuss @Tar", 12), {
    start: 8,
    end: 12,
    query: "Tar"
  });
  assert.equal(activeMentionQuery("mail@example.test", 17), null);
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
  assert.match(html, /id="mentionChooser"[^>]+role="listbox"/);
  assert.match(build, /"mention-entry\.js"/);
});
