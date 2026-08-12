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

test("selected at-mentions create a stable page reference", () => {
  const references = reconcileTextReferences({
    previousText: "",
    previousReferences: [],
    nextText: "Discuss @[Target]",
    pages
  });

  assert.deepEqual(references, [{ pageId: "target-1" }]);
});

test("escaped mention delimiters preserve the selected stable page reference", () => {
  const references = reconcileTextReferences({
    previousText: "Discuss @[A\\]B]",
    previousReferences: [{ pageId: "selected-bracket", start: 8, end: 15 }],
    nextText: "Discuss @[A\\]B]!",
    pages: [{ id: "selected-bracket", title: "A]B" }]
  });

  assert.deepEqual(references, [{ pageId: "selected-bracket" }]);
});

test("ranged selected mentions remain stable beside positionless legacy references", () => {
  const references = reconcileTextReferences({
    previousText: "Legacy @[Same]",
    previousReferences: [
      { pageId: "legacy-positionless" },
      { pageId: "selected", start: 7, end: 14 }
    ],
    nextText: "Legacy @[Same]!",
    pages: [
      { id: "first", title: "Same" },
      { id: "selected", title: "Same" }
    ]
  });

  assert.deepEqual(references, [{ pageId: "selected" }]);
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
