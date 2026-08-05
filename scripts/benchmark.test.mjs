import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runBenchmark(maxQueryMs) {
  return spawnSync(process.execPath, ["scripts/benchmark.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MOTION_BENCH_PAGES: "10",
      MOTION_BENCH_BLOCKS: "2",
      MOTION_BENCH_MAX_QUERY_MS: String(maxQueryMs)
    },
    encoding: "utf8"
  });
}

test("benchmark exits zero only when the measured query is within policy", () => {
  const result = runBenchmark(60_000);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.targetQueryMs, 60_000);
  assert.equal(report.queryTargetMet, true);
  assert.ok(report.queryMs <= report.targetQueryMs);
});

test("benchmark exits non-zero and reports measured and allowed latency when over policy", () => {
  const result = runBenchmark(0.000001);
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.targetQueryMs, 0.000001);
  assert.equal(report.queryTargetMet, false);
  assert.ok(report.queryMs > report.targetQueryMs);
  assert.match(result.stderr, /Search benchmark threshold exceeded: measured \d+\.\d{2} ms; limit 0\.000001 ms\./);
});
