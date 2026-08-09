# Motion search performance evidence

## Candidate and verdict

Measured local candidate: Git `daa7bb2f90f16375f6f92759a3871cef1697403d`; source SHA-256 `4c7f6f7193a583c4bbb705665b61b88320d20b79bd725d9668443dbd34483cfe` binds the byte content of the storage implementation, benchmark runner, and fixture/policy library. The run used Node v24.18.0/Linux arm64. The complete machine-readable run is retained in `artifacts/search-performance-candidate.json`.

**Latency: PASS. Overall search release gate: PASS.** The production SQLite FTS5 path is well below 200 ms, finds the representative paragraph marker and persisted table-cell value, and uses the FTS virtual-table index.

## Controlled fixture and results

The deterministic fixture contains 10,000 pages, 100,000 paragraph blocks, 20 tables, 1,000 rows, and unique persisted cell values. Its SHA-256 is `59bac23b562307ccdf4f4abcec948ee48d63e40f5797e42416dd546f45ca10cc`.

| Phase | Samples | p50 | p95 | Maximum | 200 ms policy |
|---|---:|---:|---:|---:|---|
| Cold: reopen store, then first query | 15 | 6.27 ms | 7.18 ms | 7.18 ms | PASS |
| Warm: one untimed warm-up, same store | 100 | 5.70 ms | 6.80 ms | 7.51 ms | PASS |

The gate requires both p50 and p95 at or below 200 ms. The median represents normal interaction and p95 catches sustained tail degradation without making one scheduler outlier a release failure. A deterministic unit test feeds fixed samples through this exact policy, so threshold semantics and breach detection do not depend on wall-clock timing. The representative command supplies actual candidate evidence.

## Bottleneck isolation

Thirty warm diagnostic samples gave p50 0.31 ms for FTS matching alone, 5.64 ms with `ORDER BY rank`, and 5.79 ms with ranking plus snippet generation. Ranking is the dominant query cost; snippet generation is a small increment. `EXPLAIN QUERY PLAN` confirms the SQLite FTS5 virtual-table index is used.

The index extractor now emits scalar values nested inside each row's `values` object under the row's stable ID and owning table title. Focused storage coverage proves the persisted value is searchable, editing removes the stale term, and the replacement remains attached to the same row identity.

## Repeatable commands

```sh
npm ci --ignore-scripts
npm run test:benchmark
npm run benchmark | tee artifacts/search-performance-candidate.json
```

`npm run benchmark` exits zero only when both latency percentiles and all representative correctness checks pass. The report retains candidate identity, fixture fingerprint, raw samples, percentiles, query plan, result checks, and explicit verdict.
