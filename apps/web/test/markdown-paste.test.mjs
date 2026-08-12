import assert from "node:assert/strict";
import test from "node:test";

import { markdownBlocksFromPlainText, multilinePasteCommands } from "../markdown-paste.js";

test("multiline Markdown paste creates canonical blocks for supported structures and stable mentions", () => {
  const ids = ["heading", "task", "quote", "divider", "code", "paragraph"];
  const blocks = markdownBlocksFromPlainText(
    "# Release notes\n- [x] Ship [[Linux build]]\n> Offline first\n---\n```js\nconst ready = true;\n```\nFinal paragraph",
    () => ids.shift(),
    text => text.includes("[[Linux build]]") ? [{ pageId: "page-linux" }] : []
  );

  assert.deepEqual(blocks, [
    { id: "heading", type: "heading-1", text: "Release notes", children: [] },
    { id: "task", type: "task", text: "Ship [[Linux build]]", checked: true, references: [{ pageId: "page-linux" }], children: [] },
    { id: "quote", type: "quote", text: "Offline first", children: [] },
    { id: "divider", type: "divider", text: "", children: [] },
    { id: "code", type: "code", text: "const ready = true;", language: "js", children: [] },
    { id: "paragraph", type: "paragraph", text: "Final paragraph", children: [] }
  ]);
});

test("multiline paste preserves the active block identity and selection-surrounding text", () => {
  const blocks = [
    { id: "first", type: "paragraph", text: "Before", children: [] },
    { id: "after", type: "paragraph", text: "After", children: [] }
  ];
  const ids = ["parsed-first", "task"];

  assert.deepEqual(multilinePasteCommands({
    pageId: "page-1",
    blocks,
    activeBlockId: "first",
    text: "# Pasted\n- [ ] Verify",
    prefix: "Before ",
    suffix: " after",
    createId: () => ids.shift()
  }), [
    { type: "block.transform", pageId: "page-1", blockId: "first", transform: { type: "heading-1" } },
    { type: "block.update-content", pageId: "page-1", blockId: "first", content: { text: "Before Pasted", references: [] } },
    { type: "block.create", pageId: "page-1", position: { parentBlockId: null, beforeBlockId: "after" }, block: { id: "task", type: "task", text: "Verify after", checked: false, children: [] } }
  ]);

  assert.throws(() => multilinePasteCommands({
    pageId: "page-1",
    blocks,
    activeBlockId: "first",
    text: Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join("\n"), prefix: "", suffix: "",
    createId: () => "unused"
  }), /9,999 blocks/);

  const boundedIds = Array.from({ length: 9_999 }, (_, index) => `block-${index}`);
  assert.equal(multilinePasteCommands({
    pageId: "page-1",
    blocks,
    activeBlockId: "first",
    text: Array.from({ length: 9_999 }, () => "line").join("\n"), prefix: "", suffix: "",
    createId: () => boundedIds.shift()
  }).length, 10_000);

  assert.throws(() => multilinePasteCommands({
    pageId: "page-1", blocks, activeBlockId: "first",
    text: `${"a".repeat(10_000_001)}\nend`, prefix: "", suffix: "", createId: () => "unused"
  }), /10,000,000 characters/);
});

test("multiline paste preserves a renamed stable mention outside the selection", () => {
  const blocks = [{
    id: "first", type: "paragraph", text: "[[Old title]] x", children: [],
    references: [{ pageId: "page-target" }]
  }];
  const ids = ["parsed-first", "second"];

  const commands = multilinePasteCommands({
    pageId: "page-1", blocks, activeBlockId: "first", text: "one\ntwo",
    prefix: "[[Old title]] ", suffix: "", createId: () => ids.shift(),
    resolveReferences: () => []
  });

  assert.deepEqual(commands[1].content.references, [{ pageId: "page-target" }]);
});

test("multiline paste keeps a renamed stable suffix mention on the created suffix block", () => {
  const blocks = [{
    id: "first", type: "paragraph", text: "x [[Old title]]", children: [],
    references: [{ pageId: "page-target" }]
  }];
  const ids = ["parsed-first", "second"];

  const commands = multilinePasteCommands({
    pageId: "page-1", blocks, activeBlockId: "first", text: "one\ntwo",
    prefix: "", suffix: " [[Old title]]", createId: () => ids.shift(),
    resolveReferences: () => []
  });

  assert.deepEqual(commands[1].content.references, []);
  assert.deepEqual(commands.at(-1).block.references, [{ pageId: "page-target" }]);
});

test("multiline paste keeps a renamed stable suffix mention after a trailing divider", () => {
  const blocks = [{
    id: "first", type: "paragraph", text: "x [[Old title]]", children: [],
    references: [{ pageId: "page-target" }]
  }];
  const ids = ["parsed-first", "divider", "suffix"];

  const commands = multilinePasteCommands({
    pageId: "page-1", blocks, activeBlockId: "first", text: "one\n---",
    prefix: "", suffix: " [[Old title]]", createId: () => ids.shift(),
    resolveReferences: () => []
  });

  assert.deepEqual(commands.at(-1).block, {
    id: "suffix", type: "paragraph", text: " [[Old title]]", children: [],
    references: [{ pageId: "page-target" }]
  });
  assert.equal(commands.at(-2).block.references, undefined);
});

test("multiline paste explicitly removes a stable mention replaced by the selection", () => {
  const blocks = [{
    id: "first", type: "paragraph", text: "[[Target]] x", children: [],
    references: [{ pageId: "page-target" }]
  }];
  const ids = ["parsed-first", "second"];

  const commands = multilinePasteCommands({
    pageId: "page-1", blocks, activeBlockId: "first", text: "one\ntwo",
    prefix: "", suffix: " x", createId: () => ids.shift(),
    resolveReferences: () => []
  });

  assert.deepEqual(commands[1].content.references, []);
  assert.equal(commands.at(-1).block.references, undefined);
});

test("multiline paste resolves stable mentions after surrounding text is composed", () => {
  const blocks = [{ id: "first", type: "paragraph", text: "Before", children: [] }];
  const ids = ["parsed-first", "second"];

  const commands = multilinePasteCommands({
    pageId: "page-1", blocks, activeBlockId: "first", text: "First\nSecond",
    prefix: "", suffix: " [[Target]]", createId: () => ids.shift(),
    resolveReferences: text => text.includes("[[Target]]") ? [{ pageId: "page-target" }] : []
  });

  assert.deepEqual(commands.at(-1).block.references, [{ pageId: "page-target" }]);
});

test("a leading divider preserves visible prefix text and existing child blocks", () => {
  const blocks = [{ id: "first", type: "paragraph", text: "Before", children: [
    { id: "child", type: "paragraph", text: "Nested", children: [] }
  ] }];
  const ids = ["divider", "next"];

  assert.deepEqual(multilinePasteCommands({
    pageId: "page-1", blocks, activeBlockId: "first", text: "---\nNext",
    prefix: "Before", suffix: "", createId: () => ids.shift()
  }), [
    { type: "block.update-content", pageId: "page-1", blockId: "first", content: { text: "Before", references: [] } },
    { type: "block.create", pageId: "page-1", position: { parentBlockId: null, beforeBlockId: null }, block: { id: "divider", type: "divider", text: "", children: [] } },
    { type: "block.create", pageId: "page-1", position: { parentBlockId: null, beforeBlockId: null }, block: { id: "next", type: "paragraph", text: "Next", children: [] } }
  ]);
});
