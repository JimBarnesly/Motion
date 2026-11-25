import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceDocument, createWorkspace, exportDatabaseCsv, projectRecordProperties } from "../index.js";

function recordFixture() {
  const document = new WorkspaceDocument(createWorkspace("Record query projection"));
  const host = document.addPage("Records");
  const database = document.addDatabase({
    id: "query-records", pageId: host.id, name: "Records",
    properties: [{ id: "record-title", name: "Name", type: "title" }, { id: "score", name: "Score", type: "number" }],
    rows: [], views: [{ id: "query-table", name: "Table", type: "table", visiblePropertyIds: ["record-title", "score"] }]
  });
  return { document, database };
}

test("record title queries use the authoritative page title without a stored property copy", () => {
  const { document, database } = recordFixture();
  const zulu = document.addRecord(database.id, "Zulu", { score: 1 });
  const alpha = document.addRecord(database.id, "Alpha", { score: 2 });
  const before = JSON.stringify(document.data);
  assert.deepEqual(document.queryRecords(database.id, {
    kind: "condition", propertyId: "record-title", operator: "equals", value: "Alpha"
  }).map(page => page.id), [alpha.id]);
  assert.deepEqual(document.queryRecords(database.id, undefined, [
    { propertyId: "record-title", direction: "asc", locale: "en" }
  ]).map(page => page.id), [alpha.id, zulu.id]);
  assert.deepEqual(document.queryRecords(database.id, undefined, [
    { propertyId: "record-title", direction: "desc", locale: "en" }
  ]).map(page => page.id), [zulu.id, alpha.id]);
  assert.equal(JSON.stringify(document.data), before, "Queries must not persist title copies or change timestamps");
  assert.equal(Object.hasOwn(alpha.properties!, "record-title"), false);
});

test("title projection overrides retained legacy values without rewriting canonical records", () => {
  const { document, database } = recordFixture();
  const record = document.addRecord(database.id, "Current page title", { "record-title": "Retained legacy value", score: 3 });
  const before = JSON.stringify(document.data);
  assert.equal(projectRecordProperties(database, record)["record-title"], "Current page title");
  const results = document.queryRecords(database.id, {
    kind: "condition", propertyId: "record-title", operator: "contains", value: "Current"
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].properties!["record-title"], "Current page title");
  results[0].properties!["record-title"] = "Changed projection";
  results[0].blocks.push({ id: "projection-only", type: "paragraph", text: "Query result", children: [] });
  assert.equal(JSON.stringify(document.data), before, "The derived query remains detached from canonical values and blocks");
  assert.equal(record.properties!["record-title"], "Retained legacy value");
});

test("record title projection leaves legacy-only row exports unchanged", () => {
  const { document, database } = recordFixture();
  const stamp = document.data.createdAt;
  database.rows.push({ id: "legacy-row", values: { "record-title": "Legacy row title", score: 7 }, createdAt: stamp, updatedAt: stamp });
  const before = JSON.stringify(document.data);
  assert.deepEqual(document.queryRecords(database.id), [], "Legacy rows do not acquire fabricated record pages");
  assert.equal(exportDatabaseCsv(database, document.data.pages), '"id","Name","Score"\n"legacy-row","Legacy row title","7"\n');
  assert.equal(JSON.stringify(document.data), before);
});
