import assert from "node:assert/strict";
import test from "node:test";
import { LocalSearch, MemorySearchIndexAdapter, type SearchDocument } from "../index.js";

const documents: SearchDocument[] = [
  { id: "p1", workspaceId: "w1", type: "page", title: "Pump maintenance", body: "Inspect seals monthly", headings: ["Service procedure"], blocks: ["Isolate power"], aliases: ["Pump PM"], backlinks: ["Plant room"], fileNames: ["pump-manual.pdf"], updatedAt: "2026-08-01T00:00:00Z" },
  { id: "p2", workspaceId: "w1", type: "page", title: "Jobs", collectionId: "c1", collectionName: "Maintenance", propertyNames: ["Status", "Owner"], propertyValues: { Status: "In progress", Owner: "Jake" }, selectValues: ["Urgent"], updatedAt: "2026-08-02T00:00:00Z" },
  { id: "p3", workspaceId: "w2", type: "attachment", title: "Wiring", fileNames: ["control-panel.png"], updatedAt: "2026-07-01T00:00:00Z" }
  ,{ id: "row-7", workspaceId: "w1", type: "row", title: "Commissioning register", ownerEntityId: "table-2",
    propertyNames: ["Reading"], propertyValues: { Reading: "Flow <10 & stable\nsecond line" }, updatedAt: "2026-08-03T00:00:00Z" }
];

test("indexes all supported text sources and returns deterministic highlights", async () => {
  const search = new LocalSearch(new MemorySearchIndexAdapter());
  await search.reindex(documents);
  assert.equal((await search.quickSearch("pump manual"))[0]?.id, "p1");
  const propertyHit = (await search.search("progress", { filters: { property: { name: "Status", value: "progress" } } }))[0];
  assert.equal(propertyHit?.id, "p2");
  assert.ok(propertyHit && propertyHit.highlights.length > 0);
  assert.deepEqual((await search.search("control panel", { filters: { workspaceId: "w2", types: ["attachment"] } })).map((hit) => hit.id), ["p3"]);
});

test("returns deterministic table-row context with normalized safe text", async () => {
  const search = new LocalSearch(new MemorySearchIndexAdapter());
  await search.reindex(documents);
  const hit = (await search.search("stable second"))[0];
  assert.deepEqual({ id: hit?.id, type: hit?.type, ownerEntityId: hit?.ownerEntityId },
    { id: "row-7", type: "row", ownerEntityId: "table-2" });
  assert.equal(hit?.snippet, "Reading Flow <10 & stable second line");
  assert.ok(hit?.highlights.every(range => range.start >= 0 && range.end <= hit.snippet.length));
});

test("supports incremental updates, history controls, reindex and integrity checks", async () => {
  const search = new LocalSearch(new MemorySearchIndexAdapter());
  await search.index(documents[0]!);
  await search.index({ ...documents[0]!, title: "Motor maintenance" });
  assert.equal((await search.search("motor"))[0]?.id, "p1");
  assert.deepEqual(search.recentSearches(), ["motor"]);
  search.setHistoryEnabled(false);
  await search.search("seals");
  assert.deepEqual(search.recentSearches(), []);
  await search.remove("p1");
  assert.equal((await search.search("motor")).length, 0);
  await search.reindex(documents);
  assert.deepEqual(await search.checkIntegrity(), { ok: true, documentCount: 4, duplicateIds: [], invalidDocuments: [] });
});
