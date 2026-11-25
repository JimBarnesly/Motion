import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MotionAppService } from "@motion/app-service";
import { SqliteWorkspaceStore } from "@motion/storage";
import { WorkspaceDocument, assertWorkspaceValue } from "@motion/core";
import { encodeBinary } from "../../web/app-adapter.js";
import { confirmBrowserEdit } from "../../web/browser-edit-confirmation.js";

const wire = value => JSON.parse(JSON.stringify(encodeBinary(value)));
const selectedIds = state => {
  const database = state.workspace.databases[0], view = database.views.find(view => view.id === "board-view");
  return new WorkspaceDocument(structuredClone(state.workspace)).queryRecords(database.id, view.filters, view.sorts).map(page => page.id);
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "motion-view-filter-")), path = join(root, "workspace.sqlite");
  let store = new SqliteWorkspaceStore(path), service = new MotionAppService(store);
  t.after(async () => { store.close();await rm(root, { recursive: true, force: true }); });
  let state = service.execute({ type: "workspace.create", name: "View filter removal" });
  const workspaceId = state.workspace.id;
  const execute = (type, payload) => {
    state = service.execute(wire({ type, workspaceId, expectedRevision: state.revision, ...payload }));
    return state;
  };
  execute("database.create", { title: "Tasks" });
  const databaseId = state.workspace.databases[0].id, titleId = state.workspace.databases[0].properties[0].id;
  execute("database.property-add", { databaseId, property: { name: "Status", type: "status", options: [
    { id: "todo", name: "To do" }, { id: "done", name: "Done" }
  ] } });
  const statusId = state.workspace.databases[0].properties.find(property => property.name === "Status").id;
  execute("database.record-create", { databaseId, title: "Open", values: { [statusId]: "todo" } });
  const openId = state.workspace.pages.find(page => page.title === "Open").id;
  execute("database.record-create", { databaseId, title: "Finished", values: { [statusId]: "done" } });
  const finishedId = state.workspace.pages.find(page => page.title === "Finished").id;
  execute("page.replace-blocks", { pageId: openId, blocks: [
    { id: "retained-toggle", type: "toggle", text: "Details", children: [
      { id: "retained-opaque", type: "future-note", text: "Imported", children: [], unknownData: { retain: [1, "two"] } }
    ] }
  ] });
  const filters = { kind: "and", children: [
    { kind: "condition", propertyId: statusId, operator: "equals", value: "todo" },
    { kind: "not", child: { kind: "condition", propertyId: titleId, operator: "equals", value: "Hidden" } }
  ] };
  execute("database.view-create", { databaseId, view: { id: "board-view", name: "Open board", type: "board",
    groupByPropertyId: statusId, visiblePropertyIds: [titleId, statusId], propertyOrder: [statusId, titleId],
    filters, sorts: [{ propertyId: titleId, direction: "asc", nulls: "last", locale: "en" }],
    layout: { imported: { columns: 3 } }, cardPreview: { imported: "retained" }
  } });
  return {
    databaseId, workspaceId, openId, finishedId, filters, execute,
    get state() { return state; },
    read() { return service.query({ type: "workspace.get", workspaceId }); },
    export() { return service.query({ type: "workspace.export", workspaceId }); },
    reopen() { store.close();store = new SqliteWorkspaceStore(path);service = new MotionAppService(store);return this.read(); }
  };
}

test("explicit null clears a saved native filter across JSON transport, export and SQLite reopen", async t => {
  const f = await fixture(t), before = f.state, oldView = before.workspace.databases[0].views[1];
  assert.deepEqual(selectedIds(before), [f.openId]);
  const payload = wire({ databaseId: f.databaseId, viewId: oldView.id, patch: { filters: null } });
  assert.deepEqual(payload.patch, { filters: null });
  const cleared = f.execute("database.view-update", payload), view = cleared.workspace.databases[0].views[1];
  assert.equal(cleared.revision, before.revision + 1);
  const expected = structuredClone(oldView);delete expected.filters;
  assert.deepEqual(view, expected, "Only the filter is removed; grouping, sorting and imported settings survive");
  assert.equal(Object.hasOwn(view, "filters"), false, "null is a command sentinel, never persisted data");
  assert.deepEqual(cleared.workspace.pages, before.workspace.pages, "Record identities, body trees and opaque payloads survive");
  assert.deepEqual(selectedIds(cleared), [f.finishedId, f.openId]);
  assertWorkspaceValue(cleared.workspace);
  assert.deepEqual(JSON.parse(f.export().files["workspace.json"]).databases[0].views[1], expected);
  assert.deepEqual(f.reopen(), { workspace: cleared.workspace, revision: cleared.revision });
});

test("omitted filters preserve a saved expression and invalid combined clear patches are atomic", async t => {
  const f = await fixture(t);
  const renamed = f.execute("database.view-update", { databaseId: f.databaseId, viewId: "board-view", patch: { name: "Renamed" } });
  assert.deepEqual(renamed.workspace.databases[0].views[1].filters, f.filters);
  assert.deepEqual(selectedIds(renamed), [f.openId]);
  const before = f.read();
  for (const patch of [
    { filters: null, visiblePropertyIds: ["missing-property"] },
    { filters: null, sorts: null },
    { filters: { kind: "and", children: "invalid" } }
  ]) {
    assert.throws(() => f.execute("database.view-update", { databaseId: f.databaseId, viewId: "board-view", patch }), `Invalid patch ${JSON.stringify(patch)}`);
    assert.deepEqual(f.read(), before, "A refused patch cannot clear the filter, advance revision or change content");
  }
  const cleared = f.execute("database.view-update", { databaseId: f.databaseId, viewId: "board-view", patch: { filters: null } });
  const replaced = f.execute("database.view-update", { databaseId: f.databaseId, viewId: "board-view", patch: { filters: f.filters } });
  assert.equal(replaced.revision, cleared.revision + 1);
  assert.deepEqual(replaced.workspace.databases[0].views[1].filters, f.filters);
  assert.deepEqual(selectedIds(replaced), [f.openId]);
});

test("browser confirmation matches native explicit-null clearing and retains the confirmed filter after save failure", async t => {
  const f = await fixture(t), before = { schemaVersion: 2, revision: f.state.revision, workspace: structuredClone(f.state.workspace) };
  const original = structuredClone(before), payload = wire({ databaseId: f.databaseId, viewId: "board-view", patch: { filters: null } });
  const candidate = { type: "database.view-update", payload };
  await assert.rejects(confirmBrowserEdit(before, candidate, async state => {
    assertWorkspaceValue(state.workspace);
    assert.equal(Object.hasOwn(state.workspace.databases[0].views[1], "filters"), false);
    throw new Error("Simulated durable save failure");
  }), /Simulated durable save failure/);
  assert.deepEqual(before, original);
  const native = f.execute(candidate.type, payload);
  let saved;
  const browser = await confirmBrowserEdit(before, candidate, async state => { assertWorkspaceValue(state.workspace);saved = state; }, () => native.workspace.updatedAt);
  assert.deepEqual(browser.workspace, native.workspace);
  assert.equal(browser.revision, native.revision);
  assert.deepEqual(saved, browser);
  assert.deepEqual(before, original);
});
