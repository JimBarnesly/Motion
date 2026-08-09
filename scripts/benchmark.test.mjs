import assert from "node:assert/strict";
import test from "node:test";
import { fixtureFingerprint, policyVerdict, representativeWorkspace, summarise } from "./search-benchmark-lib.mjs";

test("representative fixture is deterministic and includes pages, blocks, tables, rows and persisted cell text", () => {
  const first = representativeWorkspace({ pageCount: 3, blocksPerPage: 2, tableCount: 2, rowsPerTable: 2 });
  const second = representativeWorkspace({ pageCount: 3, blocksPerPage: 2, tableCount: 2, rowsPerTable: 2 });
  assert.equal(fixtureFingerprint(first), fixtureFingerprint(second));
  assert.equal(first.pages.flatMap((page) => page.blocks).length, 6);
  assert.equal(first.databases.flatMap((table) => table.rows).length, 4);
  assert.equal(first.databases[1].rows[1].values.reading, "persisted-cell-1-1");
});

test("percentile policy deterministically rejects a genuine 200 ms breach", () => {
  const passing = summarise([80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 195, 199, 200], 200);
  const failing = summarise([80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 201, 220, 250], 200);
  assert.equal(passing.passed, true);
  assert.equal(failing.passed, false);
  assert.equal(failing.p95Ms, 250);
  assert.deepEqual(policyVerdict({ cold: passing, warm: failing, resultChecks: { indexedPlan: true } }), {
    passed: false,
    failures: ["warm latency percentile exceeds 200 ms"]
  });
});

test("policy fails independently of timing when representative content or indexed routing regresses", () => {
  const timings = summarise([1, 2, 3], 200);
  const verdict = policyVerdict({ cold: timings, warm: timings, resultChecks: { representativeBlock: false, persistedCell: false, indexedPlan: false } });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.failures.length, 3);
});
