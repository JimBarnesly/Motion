import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { assertSafePropertyLifecycle, livePropertyDefinitions, reorderPropertyDefinitions, tombstonePropertyDefinition } from "../property-lifecycle.js";
import { persistBrowserMutation } from "../browser-mutation.js";

const fixture = () => ({
  properties: [{ id: "title", name: "Name", type: "title" }, { id: "score", name: "Score", type: "number" }, { id: "notes", name: "Notes", type: "plain-text" }],
  propertyOrder: ["title", "score", "notes"],
  titlePropertyId: "title",
  recordPageIds: ["record"],
  views: [{ id: "table-view", name: "Table", type: "table", visiblePropertyIds: ["title", "score", "notes"], propertyOrder: ["notes", "title", "score"], columnWidths: { score: 200 },
    filters: { kind: "and", children: [{ kind: "condition", propertyId: "score", operator: "equals", value: 1 }, { kind: "condition", propertyId: "notes", operator: "contains", value: "x" }] },
    sorts: [{ propertyId: "score", direction: "asc" }], groupByPropertyId: "score" }]
});

test("browser property lifecycle preserves canonical definitions and historic values", () => {
  const database = fixture(), record = { properties: { score: 7, notes: "historic" } };
  reorderPropertyDefinitions(database, ["score", "title", "notes"]);
  assert.deepEqual(database.propertyOrder, ["score", "title", "notes"]);
  assert.deepEqual(livePropertyDefinitions(database).map(property => property.id), ["score", "title", "notes"]);
  tombstonePropertyDefinition(database, "score", "2026-08-14T00:00:00.000Z");
  assert.equal(database.properties.find(property => property.id === "score").deletedAt, "2026-08-14T00:00:00.000Z");
  assert.equal(record.properties.score, 7);
  assert.deepEqual(database.propertyOrder, ["title", "notes"]);
  assert.deepEqual(database.views[0].visiblePropertyIds, ["title", "notes"]);
  assert.deepEqual(database.views[0].propertyOrder, ["notes", "title"]);
  assert.deepEqual(database.views[0].columnWidths, {});
  assert.deepEqual(database.views[0].filters, { kind: "condition", propertyId: "notes", operator: "contains", value: "x" });
  assert.deepEqual(database.views[0].sorts, []);
  assert.equal(database.views[0].groupByPropertyId, undefined);
  assert.throws(() => reorderPropertyDefinitions(database, ["title"]), /every live property/i);
  assert.throws(() => tombstonePropertyDefinition(database, "title", "2026-08-14T00:00:00.000Z"), /title/i);
});

test("browser schema-v2 lifecycle validation rejects crafted canonical state", () => {
  const valid = fixture();
  assert.equal(assertSafePropertyLifecycle({ databases: [valid] }), true);
  const unknownOrder = structuredClone(valid); unknownOrder.propertyOrder = ["title", "score", "unknown"];
  assert.throws(() => assertSafePropertyLifecycle({ databases: [unknownOrder] }), /property order/i);
  const staleView = structuredClone(valid); staleView.properties[1].deletedAt = "2026-08-14T00:00:00.000Z"; staleView.propertyOrder = ["title", "notes"];
  assert.throws(() => assertSafePropertyLifecycle({ databases: [staleView] }), /live property/i);
  const duplicateTitle = structuredClone(valid); duplicateTitle.properties[1].type = "title";
  assert.throws(() => assertSafePropertyLifecycle({ databases: [duplicateTitle] }), /title/i);
  const convertedTitle = structuredClone(valid); convertedTitle.properties[0].type = "number";
  assert.throws(() => assertSafePropertyLifecycle({ databases: [convertedTitle] }), /title/i);
  const swappedTitle = structuredClone(valid); swappedTitle.properties[0].type = "number"; swappedTitle.properties[1].type = "title";
  assert.throws(() => assertSafePropertyLifecycle({ databases: [swappedTitle] }), /title/i);
  const invalidBounds = structuredClone(valid); invalidBounds.properties[1].validation = { min: 10, max: 1, minLength: -1 };
  assert.throws(() => assertSafePropertyLifecycle({ databases: [invalidBounds] }), /validation/i);
  const invalidRelation = structuredClone(valid); invalidRelation.properties[1].type = "relation"; invalidRelation.properties[1].relation = { targetCollectionId: {}, maxItems: -1 };
  assert.throws(() => assertSafePropertyLifecycle({ databases: [invalidRelation] }), /relation/i);
  const injected = structuredClone(valid); injected.properties[1].injected = true;
  assert.throws(() => assertSafePropertyLifecycle({ databases: [injected] }), /shape/i);
  const hostileViewType = structuredClone(valid); hostileViewType.views[0].type = '<img src=x onerror="alert(1)">';
  assert.throws(() => assertSafePropertyLifecycle({ databases: [hostileViewType] }), /view type/i);
  const injectedView = structuredClone(valid); injectedView.views[0].injected = true;
  assert.throws(() => assertSafePropertyLifecycle({ databases: [injectedView] }), /view.*shape/i);
});

test("schema-v2 restore validates lifecycle state and escapes view labels independently", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const restore = source.match(/async function restoreWorkspace\(file\)\{[^\n]+/)?.[0] ?? "";
  assert.match(restore, /canonicalWorkspace\(candidate\)/);
  assert.doesNotMatch(restore, /assertSafeCanonicalWorkspaceIds\(candidate\)/);
  assert.match(source, /escapeHtml\(candidate\.type\)/);
});

test("browser lifecycle persistence failure restores the exact snapshot and cannot leak later", async () => {
  let state = { revision: 4, workspace: { properties: ["title"] } };
  const run = save => persistBrowserMutation({ snapshot: () => structuredClone(state), restore: snapshot => { state = snapshot; },
    mutate: () => state.workspace.properties.push("score"), touch: () => { state.revision++; }, save });
  await assert.rejects(run(async () => { throw new Error("IndexedDB rejected write"); }));
  assert.deepEqual(state, { revision: 4, workspace: { properties: ["title"] } });
  let persisted;
  await run(async candidate => { persisted = structuredClone(candidate); });
  assert.deepEqual(persisted, { revision: 5, workspace: { properties: ["title", "score"] } });
});

test("web UI uses one canonical command for labelled keyboard and pointer definition reorder", async () => {
  const root = resolve(import.meta.dirname, "..");
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const adapter = await readFile(resolve(root, "app-adapter.js"), "utf8");
  const adapterTypes = await readFile(resolve(root, "app-adapter.d.ts"), "utf8");
  const build = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
  assert.match(adapter, /"database\.property-reorder"/);
  assert.match(source, /commit\("database\.property-reorder"/);
  assert.match(source, /data-property-definition-move/);
  assert.match(source, /aria-label="Move .* property (?:earlier|later)"/);
  assert.match(source, /text\/x-motion-property-definition/);
  assert.match(source, /Property .* moved to position/);
  assert.doesNotMatch(source, /function (?:filterRow|sortRow)[^\n]+database\.properties/);
  assert.doesNotMatch(source, /database\.view-update[^\n]+property-definition/);
  assert.doesNotMatch(adapterTypes, /pattern\?: string/);
  assert.match(build, /"property-lifecycle\.js"/);
  assert.match(build, /"browser-mutation\.js"/);
});
