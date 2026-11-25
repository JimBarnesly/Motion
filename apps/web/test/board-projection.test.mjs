import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceDocument, assertWorkspaceValue, createWorkspace } from "../../../packages/core/dist/index.js";
import { encodeBinary } from "../app-adapter.js";
import { boardGroupingProperties, projectBoardView } from "../board-projection.js";
import { confirmBrowserEdit } from "../browser-edit-confirmation.js";

function fixture() {
  const document = new WorkspaceDocument(createWorkspace("Board projection"));
  const host = document.addPage("Tasks");
  const database = document.addDatabase({ id: "tasks", pageId: host.id, name: "Tasks", properties: [
    { id: "name", name: "Name", type: "title" },
    { id: "phase", name: "Phase", type: "status", options: [
      { id: "phase-ready", name: "Same label" }, { id: "phase-doing", name: "Same label" },
      { id: "phase-done", name: '<img data-block="literal">' }
    ] },
    { id: "choice", name: "Choice", type: "select", options: [{ id: "choice-one", name: "One" }] },
    { id: "score", name: "Score", type: "number" }
  ], rows: [], views: [
    { id: "table", name: "Table", type: "table", visiblePropertyIds: ["name", "phase"] },
    { id: "board", name: "Board", type: "board", groupByPropertyId: "phase", visiblePropertyIds: ["name", "phase"],
      layout: { imported: { width: 260 } }, cardPreview: { imported: "retained" } }
  ] });
  const ready = document.addRecord(database.id, "Ready", { phase: "phase-ready", choice: "choice-one", score: 1 });
  const doing = document.addRecord(database.id, "Doing", { phase: "phase-doing", score: 2 });
  const missing = document.addRecord(database.id, "Missing", { score: 3 });
  const empty = document.addRecord(database.id, "Null", { phase: null, score: 4 });
  ready.blocks = [{ id: "retained-container", type: "toggle", text: "Details", children: [
    { id: "retained-child", type: "future-note", text: "Retained body", children: [],
      references: [{ pageId: host.id }], unknownData: { imported: ["value", { keep: true }] } }
  ] }];
  assertWorkspaceValue(document.data);
  return { document, database, view: database.views[1], ready, doing, missing, empty };
}

test("status lanes use stable option IDs and definition order, with missing/null records assigned once", () => {
  const { document, database, view, ready, doing, missing, empty } = fixture();
  const before = JSON.stringify(document.data);
  const board = projectBoardView(document.data, database, view);
  assert.equal(board.state, "ready");
  assert.equal(board.propertyId, "phase");
  assert.deepEqual(board.groups.map(group => group.value), ["phase-ready", "phase-doing", "phase-done", null]);
  assert.deepEqual(board.groups.map(group => group.records.map(page => page.id)), [[ready.id], [doing.id], [], [missing.id, empty.id]]);
  assert.equal(board.groups[0].label, board.groups[1].label, "Equal names do not merge distinct option identities");
  assert.equal(board.groups[2].label, '<img data-block="literal">', "Labels remain plain data, not rendered markup");
  const ids = board.groups.flatMap(group => group.records.map(page => page.id));
  assert.equal(new Set(ids).size, board.records.length);
  assert.ok(board.groups.flatMap(group => group.records).every(page => page === document.page(page.id)));
  assert.equal(JSON.stringify(document.data), before);
});

test("select grouping and option renaming preserve record identity and stored values", () => {
  const { document, database, view, ready } = fixture();
  const selectView = document.updateView(database.id, view.id, { groupByPropertyId: "choice" });
  const before = JSON.stringify(document.data);
  assert.deepEqual(projectBoardView(document.data, database, selectView).groups[0].records.map(page => page.id), [ready.id]);
  assert.equal(JSON.stringify(document.data), before);
  document.updateProperty(database.id, "choice", { options: [{ id: "choice-one", name: "Renamed option" }] });
  const renamed = projectBoardView(document.data, database, selectView);
  assert.equal(renamed.groups[0].label, "Renamed option");
  assert.equal(renamed.groups[0].value, "choice-one");
  assert.equal(ready.properties.choice, "choice-one");
  assert.deepEqual(selectView.layout, { imported: { width: 260 } });
});

test("board cards preserve real core filter/sort order within each lane", () => {
  const { document, database, view, ready } = fixture();
  const second = document.addRecord(database.id, "Second ready", { phase: "phase-ready", score: 5 });
  document.addRecord(database.id, "Filtered out", { phase: "phase-ready", score: 0 });
  const saved = document.updateView(database.id, view.id, {
    filters: { kind: "condition", propertyId: "score", operator: "gte", value: 1 },
    sorts: [{ propertyId: "score", direction: "desc", nulls: "last" }]
  });
  const before = JSON.stringify(document.data);
  const board = projectBoardView(document.data, database, saved);
  const expected = document.queryRecords(database.id, saved.filters, saved.sorts);
  assert.deepEqual(board.records.map(page => page.id), expected.map(page => page.id));
  assert.deepEqual(board.groups[0].records.map(page => page.id), [second.id, ready.id]);
  for (const group of board.groups) assert.deepEqual(group.records.map(page => page.id), expected
    .filter(page => (page.properties.phase ?? null) === group.value).map(page => page.id));
  assert.equal(JSON.stringify(document.data), before, "Grouping never persists presentation order into the collection");
});

test("a JSON-bound move to unassigned matches native and browser record commands without losing body payloads", async () => {
  const { document, database, view, ready } = fixture();
  const initial = { schemaVersion: 2, revision: 7, workspace: structuredClone(document.data) };
  const unassigned = projectBoardView(document.data, database, view).groups.at(-1);
  const payload = JSON.parse(JSON.stringify(encodeBinary({ pageId: ready.id, values: { phase: unassigned.value } })));
  assert.deepEqual(payload.values, { phase: null }, "Unassigned must survive the actual JSON/byte-envelope boundary");
  const blocks = structuredClone(ready.blocks), otherValues = { choice: ready.properties.choice, score: ready.properties.score };
  document.updateRecord(payload.pageId, undefined, payload.values);
  let stored;
  const confirmed = await confirmBrowserEdit(initial, { type: "database.record-update", payload }, async candidate => { stored = candidate; }, () => document.data.updatedAt);
  assert.deepEqual(stored, confirmed);
  assert.deepEqual(confirmed.workspace, document.data, "The JSON-bound mutation has real core/browser semantic parity");
  assert.equal(confirmed.revision, 8);
  assert.deepEqual(ready.blocks, blocks);
  assert.deepEqual(ready.properties, { ...otherValues, phase: null });
  assert.equal(projectBoardView(document.data, database, view).groups.at(-1).records.some(page => page.id === ready.id), true);
  assert.equal(initial.workspace.pages.find(page => page.id === ready.id).properties.phase, "phase-ready");
});

test("unsupported grouping and subgroup configurations remain explicit without rewriting imported metadata", () => {
  const { document, database, view } = fixture();
  for (const [patch, state, reason] of [
    [{ groupByPropertyId: undefined }, "unconfigured", "grouping-required"],
    [{ groupByPropertyId: "score" }, "unsupported", "grouping-property-type"],
    [{ subgroupByPropertyId: "choice" }, "unsupported", "subgroup"]
  ]) {
    const candidate = { ...structuredClone(view), ...patch };
    const before = JSON.stringify({ workspace: document.data, view: candidate });
    const projection = projectBoardView(document.data, database, candidate);
    assert.equal(projection.state, state); assert.equal(projection.reason, reason);
    assert.deepEqual(projection.groups, []);
    assert.equal(projection.records.length, 4, "The configuration result must retain every selected record");
    assert.equal(JSON.stringify({ workspace: document.data, view: candidate }), before);
  }
  assert.throws(() => projectBoardView(document.data, database, database.views[0]), /board view/);
});

test("live grouping choices follow canonical definition order and deletion preserves retained cell values", () => {
  const { document, database, view, ready } = fixture();
  document.reorderProperties(database.id, ["choice", "name", "score", "phase"]);
  assert.deepEqual(boardGroupingProperties(database).map(property => property.id), ["choice", "phase"]);
  document.deleteProperty(database.id, "phase");
  const before = JSON.stringify(document.data);
  assert.deepEqual(boardGroupingProperties(database).map(property => property.id), ["choice"]);
  assert.equal(projectBoardView(document.data, database, view).state, "unconfigured");
  assert.equal(ready.properties.phase, "phase-ready");
  assert.equal(JSON.stringify(document.data), before);
});

test("an undeclared option is rejected rather than silently dropping its record into another lane", () => {
  const { document, database, view, ready } = fixture();
  ready.properties.phase = "unknown-option";
  const before = JSON.stringify(document.data);
  assert.throws(() => assertWorkspaceValue(document.data), /declared option/);
  assert.throws(() => projectBoardView(document.data, database, view), /unavailable board option/);
  assert.equal(JSON.stringify(document.data), before);
});
