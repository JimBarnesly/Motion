import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceDocument, assertWorkspaceValue, createWorkspace } from "../../../packages/core/dist/index.js";
import { selectDatabaseRecords } from "../record-selector.js";

const instant = new Date("2026-11-25T12:00:00.000Z");

function fixture() {
  const document = new WorkspaceDocument(createWorkspace("Record selector parity"));
  const host = document.addPage("Records");
  const database = document.addDatabase({ id: "records", pageId: host.id, name: "Records", properties: [
    { id: "name", name: "Name", type: "title" },
    { id: "score", name: "Score", type: "number" },
    { id: "label", name: "Label", type: "plain-text" },
    { id: "phase", name: "Phase", type: "status", options: [{ id: "queued", name: "Queued" }, { id: "done", name: "Done" }] },
    { id: "due", name: "Due", type: "date-range" },
    { id: "created", name: "Created", type: "created-time" },
    { id: "updated", name: "Updated", type: "updated-time" },
    { id: "author", name: "Author", type: "created-by" },
    { id: "editor", name: "Editor", type: "updated-by" }
  ], rows: [], views: [{ id: "table", name: "Table", type: "table", visiblePropertyIds: ["name", "score"] }] });
  return { document, database };
}

function parity(document, database, view) {
  const before = JSON.stringify(document.data), beforeView = JSON.stringify(view);
  const expected = document.queryRecords(database.id, view.filters, view.sorts, () => instant);
  const actual = selectDatabaseRecords(document.data, database, view, instant);
  assert.deepEqual(actual.map(page => page.id), expected.map(page => page.id));
  assert.equal(JSON.stringify(document.data), before, "Selection must not write projections, ordering or timestamps");
  assert.equal(JSON.stringify(view), beforeView, "Saved filter/sort clauses must remain unchanged");
  assert.ok(actual.every(page => page === document.page(page.id)), "The UI receives the original record identities");
  return actual;
}

test("record selection matches real core null placement in both directions, with stable ties", () => {
  const { document, database } = fixture();
  const missing = document.addRecord(database.id, "Missing");
  const three = document.addRecord(database.id, "Three", { score: 3 });
  const explicitNull = document.addRecord(database.id, "Null", { score: null });
  const one = document.addRecord(database.id, "One", { score: 1 });
  const anotherThree = document.addRecord(database.id, "Another three", { score: 3 });
  for (const direction of ["asc", "desc"]) for (const nulls of [undefined, "first", "last"]) {
    parity(document, database, { sorts: [{ propertyId: "score", direction, ...(nulls ? { nulls } : {}) }] });
  }
  assert.deepEqual(selectDatabaseRecords(document.data, database, { sorts: [{ propertyId: "score", direction: "desc", nulls: "last" }] })
    .map(page => page.id), [three.id, anotherThree.id, one.id, missing.id, explicitNull.id],
  "Descending must reverse present values without moving nulls to the front");
});

test("each saved string sort clause uses its explicit locale like core", () => {
  const { document, database } = fixture();
  document.addRecord(database.id, "Umlaut", { label: "ä", score: 1 });
  document.addRecord(database.id, "Zed", { label: "z", score: 1 });
  document.addRecord(database.id, "A", { label: "a", score: 1 });
  assert.deepEqual(Intl.Collator.supportedLocalesOf(["de", "sv"]), ["de", "sv"]);
  const orders = ["de", "sv"].map(locale => parity(document, database, {
    sorts: [{ propertyId: "score", direction: "asc" }, { propertyId: "label", direction: "asc", locale }]
  }).map(page => page.properties.label));
  assert.deepEqual(orders, [["a", "ä", "z"], ["a", "z", "ä"]], "The locale changes a real non-tied comparison");
});

test("title filters and sorts use Page.title rather than missing or stale property copies", () => {
  const { document, database } = fixture();
  document.addRecord(database.id, "Zulu", { name: "A stale stored title" });
  document.addRecord(database.id, "Alpha");
  assert.deepEqual(parity(document, database, { sorts: [{ propertyId: "name", direction: "asc", locale: "en" }] })
    .map(page => page.title), ["Alpha", "Zulu"]);
  assert.deepEqual(parity(document, database, { filters: { kind: "condition", propertyId: "name", operator: "equals", value: "Alpha" } })
    .map(page => page.title), ["Alpha"]);
});

test("computed property sort/filter projections ignore retained legacy values without persisting replacements", () => {
  const { document, database } = fixture();
  const earlier = document.addRecord(database.id, "Earlier");
  const later = document.addRecord(database.id, "Later");
  earlier.createdAt = "2026-11-24T09:00:00.000Z"; earlier.updatedAt = "2026-11-25T10:00:00.000Z";
  later.createdAt = "2026-11-25T09:00:00.000Z"; later.updatedAt = "2026-11-25T11:00:00.000Z";
  earlier.createdBy = "author-a"; earlier.updatedBy = "editor-z";
  later.createdBy = "author-z"; later.updatedBy = "editor-a";
  // Canonical v2 intentionally retains these old values, while derived queries
  // use page metadata. This is a loaded-data fixture, not a permitted edit.
  earlier.properties = { created: later.createdAt, updated: later.updatedAt, author: later.createdBy, editor: later.updatedBy };
  later.properties = { created: earlier.createdAt, updated: earlier.updatedAt, author: earlier.createdBy, editor: earlier.updatedBy };
  assertWorkspaceValue(document.data);
  for (const propertyId of ["created", "updated", "author", "editor"]) for (const direction of ["asc", "desc"]) {
    parity(document, database, { sorts: [{ propertyId, direction }] });
  }
  assert.deepEqual(parity(document, database, { filters: { kind: "condition", propertyId: "created", operator: "relative-date", value: "today" } })
    .map(page => page.id), [later.id]);
});

test("nested filters and relative dates retain the existing evaluator and one supplied instant", () => {
  const { document, database } = fixture();
  const today = document.addRecord(database.id, "Today", { phase: "queued", score: 2,
    due: { start: "2026-11-24T09:00:00.000Z", end: "2026-11-25T09:00:00.000Z" } });
  const later = document.addRecord(database.id, "Later", { phase: "queued", score: 5,
    due: { start: "2026-11-27T09:00:00.000Z" } });
  document.addRecord(database.id, "Done", { phase: "done", score: 10,
    due: { start: "2026-11-25T09:00:00.000Z" } });
  const view = { filters: { kind: "and", children: [
    { kind: "or", children: [
      { kind: "condition", propertyId: "due", operator: "relative-date", value: "today" },
      { kind: "condition", propertyId: "score", operator: "gt", value: 3 }
    ] },
    { kind: "not", child: { kind: "condition", propertyId: "phase", operator: "equals", value: "done" } }
  ] }, sorts: [{ propertyId: "score", direction: "desc" }] };
  assert.deepEqual(parity(document, database, view).map(page => page.id), [later.id, today.id]);
});

test("manual and tie order follow canonical record IDs, excluding tombstones and unrelated pages", () => {
  const { document, database } = fixture();
  const first = document.addRecord(database.id, "First", { score: 1 });
  const hidden = document.addRecord(database.id, "Deleted", { score: 1 });
  const second = document.addRecord(database.id, "Second", { score: 1 });
  const third = document.addRecord(database.id, "Third", { score: 1 });
  hidden.deletedAt = "2026-11-25T09:00:00.000Z";
  document.addPage("An unrelated page");
  document.reorderRecords(database.id, [third.id, first.id, second.id]);
  const expected = [third.id, first.id, second.id];
  assert.deepEqual(parity(document, database, {}).map(page => page.id), expected);
  assert.deepEqual(parity(document, database, { sorts: [{ propertyId: "score", direction: "desc" }] }).map(page => page.id), expected);
  assert.deepEqual(database.recordPageIds, [third.id, hidden.id, first.id, second.id]);
});
