import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SqliteWorkspaceStore, toFtsQuery } from "../packages/storage/dist/index.js";
import { fixtureFingerprint, policyVerdict, representativeWorkspace, SEARCH_POLICY_MS, summarise } from "./search-benchmark-lib.mjs";

const integer = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};
const pageCount = integer("MOTION_BENCH_PAGES", 10_000);
const blocksPerPage = integer("MOTION_BENCH_BLOCKS", 10);
const coldRuns = integer("MOTION_BENCH_COLD_RUNS", 15);
const warmRuns = integer("MOTION_BENCH_WARM_RUNS", 100);
const thresholdMs = Number(process.env.MOTION_BENCH_MAX_QUERY_MS ?? SEARCH_POLICY_MS);
if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) throw new Error("MOTION_BENCH_MAX_QUERY_MS must be positive");

const workspace = representativeWorkspace({ pageCount, blocksPerPage });
const root = mkdtempSync(join(tmpdir(), "motion-search-benchmark-"));
const databasePath = join(root, "motion.sqlite3");
const query = `marker-${pageCount - 1}-${blocksPerPage - 1}`;
const cellQuery = "persisted-cell-19-49";
const timed = (store) => { const start = performance.now(); const hits = store.search(query, workspace.id, 8); return { ms: performance.now() - start, hits }; };

try {
  let store = new SqliteWorkspaceStore(databasePath);
  const persistStart = performance.now();
  store.save(workspace.id, workspace.schemaVersion, workspace);
  const persistAndIndexMs = performance.now() - persistStart;
  store.close();

  const coldSamples = [];
  let representativeHits = [];
  for (let run = 0; run < coldRuns; run += 1) {
    store = new SqliteWorkspaceStore(databasePath);
    const measured = timed(store);
    coldSamples.push(measured.ms);
    representativeHits = measured.hits;
    store.close();
  }
  store = new SqliteWorkspaceStore(databasePath);
  timed(store); // Explicit untimed warm-up.
  const warmSamples = [];
  for (let run = 0; run < warmRuns; run += 1) warmSamples.push(timed(store).ms);
  const cellHits = store.search(cellQuery, workspace.id, 8);
  const queryPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT entity_id FROM workspace_search WHERE workspace_search MATCH ? AND workspace_id = ? ORDER BY rank LIMIT ?").all(`\"${query}\"`, workspace.id, 8);
  const match = toFtsQuery(query);
  const diagnosticRuns = 30;
  const diagnostic = (sql, parameters) => {
    const statement = store.database.prepare(sql);
    statement.all(...parameters);
    const samples = [];
    for (let run = 0; run < diagnosticRuns; run += 1) { const start = performance.now(); statement.all(...parameters); samples.push(performance.now() - start); }
    return summarise(samples, thresholdMs);
  };
  const bottleneck = {
    runs: diagnosticRuns,
    matchOnly: diagnostic("SELECT entity_id FROM workspace_search WHERE workspace_search MATCH ? AND workspace_id = ? LIMIT ?", [match, workspace.id, 8]),
    ranked: diagnostic("SELECT entity_id FROM workspace_search WHERE workspace_search MATCH ? AND workspace_id = ? ORDER BY rank LIMIT ?", [match, workspace.id, 8]),
    rankedWithSnippet: diagnostic("SELECT entity_id, snippet(workspace_search, 3, '[', ']', '…', 12) FROM workspace_search WHERE workspace_search MATCH ? AND workspace_id = ? ORDER BY rank LIMIT ?", [match, workspace.id, 8])
  };
  store.close();

  const cold = summarise(coldSamples, thresholdMs);
  const warm = summarise(warmSamples, thresholdMs);
  const resultChecks = {
    representativeBlock: representativeHits.some((hit) => hit.entityId === `page-${pageCount - 1}-block-${blocksPerPage - 1}`),
    persistedCell: cellHits.some((hit) => hit.entityId === "table-19-row-49"),
    indexedPlan: queryPlan.some((row) => String(row.detail).includes("VIRTUAL TABLE INDEX"))
  };
  const verdict = policyVerdict({ cold, warm, resultChecks });
  const git = (args) => { try { return execFileSync("git", args, { encoding: "utf8" }).trim(); } catch { return "unavailable"; } };
  const candidateFiles = ["packages/storage/src/index.ts", "scripts/benchmark.mjs", "scripts/search-benchmark-lib.mjs"];
  const sourceFingerprint = createHash("sha256");
  for (const path of candidateFiles) sourceFingerprint.update(path).update("\0").update(readFileSync(path)).update("\0");
  const report = {
    schemaVersion: "1.0.0",
    candidate: { gitHead: git(["rev-parse", "HEAD"]), sourceFiles: candidateFiles, sourceSha256: sourceFingerprint.digest("hex"), clean: git(["status", "--porcelain"]) === "" },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    fixture: { pages: pageCount, blocks: pageCount * blocksPerPage, tables: workspace.databases.length, rows: workspace.databases.reduce((sum, table) => sum + table.rows.length, 0), fingerprint: fixtureFingerprint(workspace) },
    method: { path: "SqliteWorkspaceStore.search / SQLite FTS5", cold: `${coldRuns} store reopen + first-query samples`, warm: `one warm-up + ${warmRuns} same-process samples`, query, cellQuery },
    persistAndIndexMs, cold: { ...cold, samplesMs: coldSamples }, warm: { ...warm, samplesMs: warmSamples }, bottleneck, resultChecks, queryPlan, verdict
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!verdict.passed) { process.stderr.write(`Search performance policy failed: ${verdict.failures.join("; ")}\n`); process.exitCode = 1; }
} finally {
  rmSync(root, { recursive: true, force: true });
}
