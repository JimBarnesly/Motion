import assert from "node:assert/strict";
import test from "node:test";

import { splitBlockCommands } from "../editor-structure.js";

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
