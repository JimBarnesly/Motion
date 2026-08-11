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
