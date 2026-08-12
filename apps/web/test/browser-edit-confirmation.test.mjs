import assert from "node:assert/strict";
import test from "node:test";

import { confirmBrowserEdit } from "../browser-edit-confirmation.js";

const initial = {
  schemaVersion: 2,
  revision: 3,
  workspace: {
    updatedAt: "old",
    pages: [{ id: "page-1", title: "durable", updatedAt: "old", blocks: [] }],
    databases: []
  }
};

const rename = title => ({ type: "page.rename", payload: { pageId: "page-1", title } });

test("a failed browser mutation cannot leak into a later successful save", async () => {
  let durable = structuredClone(initial);
  let attempts = 0;
  const save = async document => {
    attempts += 1;
    if (attempts === 1) throw new Error("IDB write failed");
    durable = structuredClone(document);
  };

  await assert.rejects(confirmBrowserEdit(initial, rename("failed candidate"), save, () => "failed-at"), /IDB write failed/);
  assert.equal(initial.workspace.pages[0].title, "durable");
  assert.equal(durable.workspace.pages[0].title, "durable");

  const confirmed = await confirmBrowserEdit(initial, rename("successful retry"), save, () => "saved-at");
  assert.equal(confirmed.workspace.pages[0].title, "successful retry");
  assert.equal(durable.workspace.pages[0].title, "successful retry");
  assert.equal(durable.workspace.pages.some(page => page.title === "failed candidate"), false);
  assert.equal(durable.revision, 4);
});

test("browser development compatibility applies the complete atomic block paste batch", async () => {
  let state = structuredClone(initial);
  state.workspace.pages[0].blocks = [
    { id: "old", type: "paragraph", text: "Before", children: [] },
    { id: "after", type: "paragraph", text: "After", children: [] }
  ];
  state = await confirmBrowserEdit(state, { type: "block.batch", payload: { commands: [
    { type: "block.transform", pageId: "page-1", blockId: "old", transform: { type: "heading-1" } },
    { type: "block.update-content", pageId: "page-1", blockId: "old", content: { text: "Pasted", references: [{ pageId: "page-2" }] } },
    { type: "block.create", pageId: "page-1", position: { parentBlockId: null, beforeBlockId: "after" }, block: { id: "new", type: "heading-1", text: "Pasted", children: [] } }
  ] } }, async () => {}, () => "stamp");
  assert.deepEqual(state.workspace.pages[0].blocks, [
    { id: "old", type: "heading-1", text: "Pasted", references: [{ pageId: "page-2" }], children: [] },
    { id: "new", type: "heading-1", text: "Pasted", children: [] },
    { id: "after", type: "paragraph", text: "After", children: [] }
  ]);
});

test("browser development compatibility applies the typed block edit surface", async () => {
  let state = structuredClone(initial);
  state.workspace.pages[0].blocks = [{ id: "block-1", type: "paragraph", text: "before", children: [] }];
  const save = async () => {};
  state = await confirmBrowserEdit(state, { type: "block.update-content", payload: { pageId: "page-1", blockId: "block-1", content: { text: "after", references: [] } } }, save, () => "one");
  state = await confirmBrowserEdit(state, { type: "block.transform", payload: { pageId: "page-1", blockId: "block-1", transform: { type: "task", checked: true } } }, save, () => "two");
  assert.deepEqual(state.workspace.pages[0].blocks[0], { id: "block-1", type: "task", text: "after", children: [], references: [], checked: true });
});
