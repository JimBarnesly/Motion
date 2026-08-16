import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyBrowserRecordOrder, manualRecordOrderEnabled, moveRecordInManualOrder } from "../record-order.js";

const fixture = () => ({
  pages: [
    { id: "first", collectionId: "tasks", title: "First" },
    { id: "hidden", collectionId: "tasks", title: "Hidden", deletedAt: "2026-08-16T00:00:00.000Z" },
    { id: "second", collectionId: "tasks", title: "Second" },
    { id: "third", collectionId: "tasks", title: "Third" },
    { id: "foreign", collectionId: "other", title: "Foreign" }
  ],
  databases: [{ id: "tasks", recordPageIds: ["first", "hidden", "second", "third"] }]
});

test("browser record reorder matches canonical live-record validation and preserves hidden slots", () => {
  const workspace = fixture();
  applyBrowserRecordOrder(workspace, "tasks", ["third", "first", "second"]);
  assert.deepEqual(workspace.databases[0].recordPageIds, ["third", "hidden", "first", "second"]);
  assert.deepEqual(workspace.pages.map(page => [page.id, page.title]), fixture().pages.map(page => [page.id, page.title]));
  for (const invalid of [["third", "first"], ["third", "first", "first"], ["third", "first", "foreign"], ["third", "first", "missing"]]) {
    const before = structuredClone(workspace);
    assert.throws(() => applyBrowserRecordOrder(workspace, "tasks", invalid), /live record|collection|exactly once/i);
    assert.deepEqual(workspace, before);
  }
});

test("pointer and keyboard moves derive the same complete manual order", () => {
  const order = ["first", "second", "third"];
  assert.deepEqual(moveRecordInManualOrder(order, "third", "first"), ["third", "first", "second"]);
  assert.deepEqual(moveRecordInManualOrder(order, "second", "third"), ["first", "second", "third"]);
  assert.deepEqual(moveRecordInManualOrder(order, "first", null), ["second", "third", "first"]);
  assert.throws(() => moveRecordInManualOrder(order, "missing", "first"), /record/i);
});

test("filtered and sorted views cannot mutate an order their presentation hides", () => {
  assert.equal(manualRecordOrderEnabled({}), true);
  assert.equal(manualRecordOrderEnabled({ filters: { kind: "condition" } }), false);
  assert.equal(manualRecordOrderEnabled({ sorts: [{ propertyId: "title", direction: "asc" }] }), false);
});

test("table and list expose labelled keyboard and pointer reorder controls through one canonical command seam", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\/record-order\.js"/);
  assert.match(source, /data-record-drag/);
  assert.match(source, /aria-label="Move \$\{escapeHtml\(record\.title\|\|"Untitled"\)\} record earlier"/);
  assert.match(source, /aria-label="Move \$\{escapeHtml\(record\.title\|\|"Untitled"\)\} record later"/);
  assert.match(source, /text\/x-motion-record/);
  assert.match(source, /commitRecordOrder/);
  assert.match(source, /manualRecordOrderEnabled\(view\)/);
  assert.match(source, /Clear filters and sorts to reorder records manually/);
  assert.match(source, /commit\("database\.record-reorder",\{databaseId:database\.id,orderedRecordPageIds\}/);
  assert.match(build, /"record-order\.js"/);
});
