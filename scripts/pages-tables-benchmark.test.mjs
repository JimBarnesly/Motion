import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkPagesTables, createPagesTablesFixture } from "./pages-tables-fixture.mjs";

test("representative 100-record fixture contains canonical record pages, view state and stable links",()=>{
  const workspace=createPagesTablesFixture(100),database=workspace.databases[0],record=workspace.pages.find(page=>page.title==="Replace heat pump");
  assert.equal(database.recordPageIds.length,100);
  assert.equal(record.collectionId,database.id);
  assert.equal(record.blocks[0].text,"Need quotes from three suppliers.");
  assert.equal(database.views[0].sorts.length,2);
  assert.ok(database.views[0].filters);
  assert.ok(workspace.linkIndex.some(link=>link.targetPageId===record.id));
});

test("5,000-record interactive operations stay bounded",()=>{
  const result=benchmarkPagesTables(5000);
  assert.equal(result.filteredRecords,4000);
  assert.ok(result.openMs<5000,`open took ${result.openMs}ms`);
  assert.ok(result.filterMs<1000,`filter took ${result.filterMs}ms`);
  assert.ok(result.sortMs<1000,`sort took ${result.sortMs}ms`);
  assert.ok(result.editMs<100,`edit took ${result.editMs}ms`);
  assert.ok(result.heapDeltaMiB<256,`heap grew ${result.heapDeltaMiB} MiB`);
});
