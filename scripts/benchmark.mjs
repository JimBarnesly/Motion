import { performance } from "node:perf_hooks";
import { LocalSearch, MemorySearchIndexAdapter } from "../packages/search/dist/index.js";

const pageCount = Number(process.env.MOTION_BENCH_PAGES || 10_000);
const blocksPerPage = Number(process.env.MOTION_BENCH_BLOCKS || 10);
const targetQueryMs = Number(process.env.MOTION_BENCH_MAX_QUERY_MS || 200);
if (!Number.isFinite(targetQueryMs) || targetQueryMs <= 0) {
  throw new Error(`MOTION_BENCH_MAX_QUERY_MS must be a positive number; received ${process.env.MOTION_BENCH_MAX_QUERY_MS}`);
}
const documents = Array.from({ length: pageCount }, (_, page) => ({
  id: `page-${page}`,
  workspaceId: "benchmark",
  type: "page",
  title: `Operations page ${page}`,
  body: `Deterministic offline workspace content for page ${page}`,
  blocks: Array.from({ length: blocksPerPage }, (_, block) => `Block ${block} on page ${page} contains local knowledge`),
  headings: [`Section ${page % 20}`],
  updatedAt: "2026-08-04T00:00:00.000Z"
}));

const search = new LocalSearch(new MemorySearchIndexAdapter());
const startIndex = performance.now();
await search.reindex(documents);
const indexMs = performance.now() - startIndex;
const startQuery = performance.now();
const hits = await search.quickSearch(`local knowledge page ${pageCount - 1}`);
const queryMs = performance.now() - startQuery;
const integrity = await search.checkIntegrity();
const measuredQueryMs = Number(queryMs.toFixed(2));
const queryTargetMet = queryMs <= targetQueryMs;

console.log(JSON.stringify({
  fixture: { pages: pageCount, blocks: pageCount * blocksPerPage },
  indexMs: Number(indexMs.toFixed(2)),
  queryMs: measuredQueryMs,
  hits: hits.length,
  integrity: integrity.ok,
  targetQueryMs,
  queryTargetMet
}, null, 2));

if (!queryTargetMet) {
  console.error(`Search benchmark threshold exceeded: measured ${measuredQueryMs.toFixed(2)} ms; limit ${targetQueryMs} ms.`);
}
if (!integrity.ok || !hits.length || !queryTargetMet) process.exitCode = 1;
