import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { activeSlashQuery, applySlashCommand, slashCommandChoices } from "../slash-entry.js";

const COMMANDS = [
  { type: "paragraph", label: "Text", keywords: ["plain"] },
  { type: "heading-1", label: "Heading 1", keywords: ["h1", "title"] },
  { type: "bulleted-list", label: "Bulleted list", keywords: ["bullet", "unordered"] },
  { type: "task", label: "To-do list", keywords: ["todo", "checkbox"] }
];

test("slash queries are active only at a word boundary immediately before the caret", () => {
  assert.deepEqual(activeSlashQuery("/hea", 4), { start: 0, end: 4, query: "hea" });
  assert.deepEqual(activeSlashQuery("Write /todo", 11), { start: 6, end: 11, query: "todo" });
  assert.equal(activeSlashQuery("https://motion.local", 20), null);
  assert.equal(activeSlashQuery("/heading/", 9), null);
});

test("slash choices match labels and keywords while preserving declared order", () => {
  assert.deepEqual(slashCommandChoices("", COMMANDS).map(item => item.type), COMMANDS.map(item => item.type));
  assert.deepEqual(slashCommandChoices("h1", COMMANDS).map(item => item.type), ["heading-1"]);
  assert.deepEqual(slashCommandChoices("todo", COMMANDS).map(item => item.type), ["task"]);
  assert.deepEqual(slashCommandChoices("list", COMMANDS).map(item => item.type), ["bulleted-list", "task"]);
});

test("a slash selection atomically removes the query, preserves later references and transforms the block", () => {
  const result = applySlashCommand({
    pageId: "page-1",
    block: { id: "block-1", text: "/h1 then [[Target]]", references: [{ pageId: "target", start: 9, end: 19 }] },
    slash: { start: 0, end: 3, query: "h1" },
    type: "heading-1"
  });
  assert.equal(result.text, " then [[Target]]");
  assert.deepEqual(result.references, [{ pageId: "target", start: 6, end: 16 }]);
  assert.deepEqual(result.commands, [
    { type: "block.transform", pageId: "page-1", blockId: "block-1", transform: { type: "heading-1" } },
    { type: "block.update-content", pageId: "page-1", blockId: "block-1", content: { text: " then [[Target]]", references: [{ pageId: "target", start: 6, end: 16 }] } }
  ]);
});

test("the Web editor wires an accessible slash chooser through one canonical block batch", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(source, /activeSlashQuery/);
  assert.match(source, /applySlashCommand/);
  assert.match(source, /candidate:\{type:"block\.batch",payload:\{commands:selected\.commands\}\}/);
  assert.match(source, /dataset\.slashType/);
  assert.match(source, /ArrowDown.*activeSlash/s);
  assert.match(html, /id="slashChooser"[^>]*role="listbox"[^>]*aria-label="Block types"/);
});
