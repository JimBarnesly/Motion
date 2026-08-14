import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { livePropertyDefinitions, reorderPropertyDefinitions, tombstonePropertyDefinition } from "../property-lifecycle.js";

const fixture = () => ({
  properties: [{ id: "title", name: "Name", type: "title" }, { id: "score", name: "Score", type: "number" }, { id: "notes", name: "Notes", type: "plain-text" }],
  propertyOrder: ["title", "score", "notes"],
  recordPageIds: ["record"],
  views: [{ visiblePropertyIds: ["title", "score", "notes"], propertyOrder: ["notes", "title", "score"], columnWidths: { score: 200 },
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

test("web UI uses one canonical command for labelled keyboard and pointer definition reorder", async () => {
  const root = resolve(import.meta.dirname, "..");
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const adapter = await readFile(resolve(root, "app-adapter.js"), "utf8");
  assert.match(adapter, /"database\.property-reorder"/);
  assert.match(source, /commit\("database\.property-reorder"/);
  assert.match(source, /data-property-definition-move/);
  assert.match(source, /aria-label="Move .* property (?:earlier|later)"/);
  assert.match(source, /text\/x-motion-property-definition/);
  assert.match(source, /Property .* moved to position/);
  assert.doesNotMatch(source, /function (?:filterRow|sortRow)[^\n]+database\.properties/);
  assert.doesNotMatch(source, /database\.view-update[^\n]+property-definition/);
});
