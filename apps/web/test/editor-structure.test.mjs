import assert from "node:assert/strict";
import test from "node:test";

import { mergeAdjacentBlockCommands, splitBlockCommands } from "../editor-structure.js";

test("Enter splits a paragraph at the caret without losing either text fragment", () => {
  assert.deepEqual(splitBlockCommands({
    pageId: "page-1",
    block: { id: "block-1", type: "paragraph", text: "BeforeAfter", children: [] },
    offset: 6,
    beforeBlockId: "block-2",
    createId: () => "new-block"
  }), {
    commands: [
      { type: "block.update-content", pageId: "page-1", blockId: "block-1", content: { text: "Before", references: [] } },
      { type: "block.create", pageId: "page-1", position: { parentBlockId: null, beforeBlockId: "block-2" }, block: { id: "new-block", type: "paragraph", text: "After", children: [] } }
    ],
    focusBlockId: "new-block"
  });
});

test("Enter preserves stable mentions on the side of the split containing them", () => {
  const block = {
    id: "block-1", type: "paragraph", text: "See [[Alpha]] then [[Beta]]", children: [],
    references: [
      { pageId: "page-alpha", start: 4, end: 13 },
      { pageId: "page-beta", start: 19, end: 27 }
    ]
  };

  const { commands } = splitBlockCommands({
    pageId: "page-1", block, offset: 14, createId: () => "new-block"
  });

  assert.deepEqual(commands[0].content.references, [{ pageId: "page-alpha", start: 4, end: 13 }]);
  assert.deepEqual(commands[1].block.references, [{ pageId: "page-beta", start: 5, end: 13 }]);
});

test("Enter preserves positionless stable mention identities after target rename", () => {
  const { commands } = splitBlockCommands({
    pageId: "page-1",
    block: {
      id: "block-1", type: "paragraph", text: "[[Old Alpha]] and [[Old Beta]]", children: [],
      references: [{ pageId: "page-alpha" }, { pageId: "page-beta" }]
    },
    offset: 18,
    createId: () => "new-block"
  });

  assert.deepEqual(commands[0].content.references, [{ pageId: "page-alpha" }]);
  assert.deepEqual(commands[1].block.references, [{ pageId: "page-beta" }]);
});

test("Enter creates a valid task continuation", () => {
  const { commands } = splitBlockCommands({
    pageId: "page-1",
    block: { id: "task-1", type: "task", text: "Do thisnext", checked: true, children: [] },
    offset: 7,
    createId: () => "task-2"
  });

  assert.deepEqual(commands[1].block, {
    id: "task-2", type: "task", text: "next", checked: false, children: []
  });
});

test("Enter exits an empty Markdown list without creating another empty block", () => {
  for (const type of ["bulleted-list", "numbered-list", "task"]) {
    assert.deepEqual(splitBlockCommands({
      pageId: "page-1",
      block: { id: "item-1", type, text: "", ...(type === "task" ? { checked: false } : {}), children: [] },
      offset: 0,
      beforeBlockId: "block-2",
      createId: () => "unused"
    }), {
      commands: [
        { type: "block.transform", pageId: "page-1", blockId: "item-1", transform: { type: "paragraph" } }
      ],
      focusBlockId: "item-1",
      focusOffset: 0
    });
  }
});

test("Backspace at the start merges adjacent text blocks and preserves stable mentions", () => {
  assert.deepEqual(mergeAdjacentBlockCommands({
    pageId: "page-1",
    previousBlock: {
      id: "block-1", type: "paragraph", text: "See [[Alpha]] ", children: [],
      references: [{ pageId: "page-alpha", start: 4, end: 13 }]
    },
    currentBlock: {
      id: "block-2", type: "paragraph", text: "and [[Beta]]", children: [],
      references: [{ pageId: "page-beta", start: 4, end: 12 }]
    }
  }), {
    commands: [
      {
        type: "block.update-content", pageId: "page-1", blockId: "block-1",
        content: {
          text: "See [[Alpha]] and [[Beta]]",
          references: [
            { pageId: "page-alpha", start: 4, end: 13 },
            { pageId: "page-beta", start: 18, end: 26 }
          ]
        }
      },
      { type: "block.delete", pageId: "page-1", blockId: "block-2" }
    ],
    focusBlockId: "block-1",
    focusOffset: 14
  });
});

test("Backspace refuses to merge structured blocks that cannot be combined losslessly", () => {
  assert.equal(mergeAdjacentBlockCommands({
    pageId: "page-1",
    previousBlock: { id: "block-1", type: "paragraph", text: "Before", children: [] },
    currentBlock: { id: "block-2", type: "future-callout", text: "After", unknownData: { tone: "blue" }, children: [] }
  }), null);
});

test("Backspace refuses to merge known blocks carrying opaque extension data", () => {
  assert.equal(mergeAdjacentBlockCommands({
    pageId: "page-1",
    previousBlock: { id: "block-1", type: "paragraph", text: "Before", children: [] },
    currentBlock: { id: "block-2", type: "paragraph", text: "After", unknownData: { plugin: { stable: true } }, children: [] }
  }), null);
});
