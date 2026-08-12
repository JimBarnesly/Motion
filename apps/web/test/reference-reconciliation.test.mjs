import test from "node:test";
import assert from "node:assert/strict";
import { reconcileTextReferences } from "../reference-reconciliation.js";

const pages = [{ id: "target-1", title: "Target" }];

test("removing a visible mention removes its stable reference", () => {
  const references = reconcileTextReferences({
    previousText: "See [[Target]]",
    previousReferences: [{ pageId: "target-1" }],
    nextText: "plain text",
    pages
  });

  assert.deepEqual(references, []);
});

test("inserting a mention before a renamed stable mention preserves both targets", () => {
  const references = reconcileTextReferences({
    previousText: "See [[Old title]]",
    previousReferences: [{ pageId: "renamed-target" }],
    nextText: "See [[Target]] and [[Old title]]",
    pages
  });

  assert.deepEqual(references, [{ pageId: "target-1" }, { pageId: "renamed-target" }]);
});

test("deleting the first duplicate mention preserves the surviving occurrence target", () => {
  const references = reconcileTextReferences({
    previousText: "[[Same]] x [[Same]]",
    previousReferences: [{ pageId: "first-target" }, { pageId: "second-target" }],
    nextText: "x [[Same]]",
    pages: []
  });

  assert.deepEqual(references, [{ pageId: "second-target" }]);
});

test("legacy stale reference arrays are not assigned to visible mentions by index", () => {
  const references = reconcileTextReferences({
    previousText: "[[Target]]",
    previousReferences: [{ pageId: "stale-target" }, { pageId: "target-1" }],
    nextText: "[[Target]]!",
    pages
  });

  assert.deepEqual(references, [{ pageId: "target-1" }]);
});

test("a visible title match overrides an equal-length stale reference", () => {
  const references = reconcileTextReferences({
    previousText: "[[Target]]",
    previousReferences: [{ pageId: "wrong-target" }],
    nextText: "[[Target]]!",
    pages: [...pages, { id: "wrong-target", title: "Other" }]
  });

  assert.deepEqual(references, [{ pageId: "target-1" }]);
});
