import assert from "node:assert/strict";
import test from "node:test";

import { confirmEditorHistory, editorHistoryCommand, editorHistoryUnchanged } from "../editor-history.js";

const documentWith = (blocks, activePageId = "page-1") => ({
  schemaVersion: 2,
  revision: 7,
  activePageId,
  workspace: {
    id: "workspace-1",
    pages: [
      { id: "page-1", title: "Draft", blocks },
      { id: "page-2", title: "Other", blocks: [] }
    ]
  }
});

test("editor undo restores the active page blocks through one canonical command", () => {
  const current = documentWith([{ id: "block-1", type: "heading-1", text: "New", children: [] }]);
  const prior = documentWith([{ id: "block-1", type: "paragraph", text: "Old", children: [] }]);

  assert.deepEqual(editorHistoryCommand(current, prior), {
    type: "page.replace-blocks",
    payload: {
      pageId: "page-1",
      blocks: [{ id: "block-1", type: "paragraph", text: "Old", children: [] }]
    }
  });
});

test("editor history refuses snapshots for another active page", () => {
  const current = documentWith([], "page-1");
  const prior = documentWith([], "page-2");

  assert.throws(() => editorHistoryCommand(current, prior), /same active page/);
});

test("editor history refuses to silently undo non-editor page changes", () => {
  const current = documentWith([]);
  const prior = structuredClone(current);
  prior.workspace.pages[0].title = "Earlier title";

  assert.throws(() => editorHistoryCommand(current, prior), /only block changes/);
});

test("editor history permits canonical link index changes derived from block edits", () => {
  const current = documentWith([{ id: "block-1", type: "paragraph", text: "[[Target]]", references: [{ pageId: "page-2" }], children: [] }]);
  current.workspace.linkIndex = [{ sourcePageId: "page-1", sourceBlockId: "block-1", targetPageId: "page-2" }];
  const prior = documentWith([{ id: "block-1", type: "paragraph", text: "Before", children: [] }]);
  prior.workspace.linkIndex = [];

  assert.equal(editorHistoryCommand(current, prior).type, "page.replace-blocks");
});

test("confirmed editor history captures the inverse before canonical state changes", async () => {
  const current = documentWith([{ id: "block-1", type: "paragraph", text: "New", children: [] }]);
  const prior = documentWith([{ id: "block-1", type: "paragraph", text: "Old", children: [] }]);

  const inverse = await confirmEditorHistory({ current, target: prior, execute: async () => {
    current.workspace.pages[0].blocks[0].text = "Old";
    current.revision += 1;
  } });

  assert.equal(JSON.parse(inverse).workspace.pages[0].blocks[0].text, "New");
  assert.equal(current.workspace.pages[0].blocks[0].text, "Old");
});

test("failed editor history does not return an inverse snapshot", async () => {
  const current = documentWith([{ id: "block-1", type: "paragraph", text: "New", children: [] }]);
  const prior = documentWith([{ id: "block-1", type: "paragraph", text: "Old", children: [] }]);

  await assert.rejects(confirmEditorHistory({ current, target: prior, execute: async () => {
    throw new Error("save failed");
  } }), /save failed/);
});

test("focus-only history checkpoints do not consume undo even after a native revision changes", () => {
  const current = documentWith([{ id: "parent", type: "paragraph", text: "Parent", children: [
    { id: "child", type: "paragraph", text: "Nested text", children: [] }
  ] }]);
  const checkpoint = structuredClone(current);
  current.revision += 1;
  current.workspace.updatedAt = "new timestamp";
  current.workspace.pages[0].updatedAt = "new timestamp";
  current.workspace.linkIndex = [];

  assert.equal(editorHistoryUnchanged(current, checkpoint), true);
  const changedText = structuredClone(checkpoint);
  changedText.workspace.pages[0].blocks[0].children[0].text = "Earlier nested text";
  assert.equal(editorHistoryUnchanged(current, changedText), false);
  const changedTitle = structuredClone(checkpoint);
  changedTitle.workspace.pages[0].title = "Earlier title";
  assert.equal(editorHistoryUnchanged(current, changedTitle), false);
  const changedPayload = structuredClone(checkpoint);
  changedPayload.workspace.pages[0].blocks[0].children[0].unknownData = { extension: true };
  assert.equal(editorHistoryUnchanged(current, changedPayload), false);
});
