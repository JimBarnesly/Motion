import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { benchmarkIncrementalPersistence, benchmarkPagesTables, createPagesTablesFixture } from "./pages-tables-fixture.mjs";

test("representative 100-record fixture contains canonical record pages, view state and stable links",()=>{
  const workspace=createPagesTablesFixture(100),database=workspace.databases[0],record=workspace.pages.find(page=>page.title==="Replace heat pump");
  assert.equal(database.recordPageIds.length,100);
  assert.equal(record.collectionId,database.id);
  assert.equal(record.blocks[0].text,"Need quotes from three suppliers.");
  assert.equal(database.views[0].sorts.length,2);
  assert.ok(database.views[0].filters);
  assert.ok(workspace.linkIndex.some(link=>link.targetPageId===record.id));
});

test("incremental persistence SQL write counters follow dirty scopes rather than workspace size and data survives restart",async()=>{
  const roots=await Promise.all([100,5000].map(count=>mkdtemp(join(tmpdir(),`motion-incremental-${count}-`))));
  try{
    const results=[100,5000].map((count,index)=>benchmarkIncrementalPersistence(count,join(roots[index],"motion.sqlite3")));
    for(const result of results){
      assert.equal(result.revision,2);assert.equal(result.reopenedRevision,2);assert.equal(result.normalizedPages,result.records+3);
      assert.equal(result.canonicalEqual,true);assert.equal(result.unknownFieldsPreserved,true);
    }
    assert.deepEqual(results[0].stats,results[1].stats);
    assert.deepEqual({mode:results[0].stats.mode,pages:results[0].stats.pages,databases:results[0].stats.databases,attachments:results[0].stats.attachments,
      linkSources:results[0].stats.linkSources,linksInserted:results[0].stats.linksInserted,ftsScopes:results[0].stats.ftsScopes},
      {mode:"incremental",pages:1,databases:1,attachments:0,linkSources:0,linksInserted:0,ftsScopes:2});
    assert.ok(results[0].stats.ftsInserted>0);
  }finally{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})))}
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
