# Motion 0.1.0 technical-debt backlog

Owner: Engineering Director  
Decision authority: Managing Director  
Audited: 2026-08-05  
Baseline: `main` at `fda1653`

## Scope

This backlog covers reliability, maintainability, and performance debt found in
the current implementation. Product parity and sequencing remain in
`FEATURE_PARITY.md`. Security-review work is intentionally excluded because it
has a separate pending gate.

Priority meanings: **P0** blocks a trustworthy 0.1.0 release; **P1** should be
completed before scaling feature work; **P2** is measurable engineering
efficiency work.

## Backlog

### TD-01 — Stop rewriting and reindexing the whole workspace for every edit

- **Priority / area:** P0 — performance, reliability
- **Affected files:** `packages/storage/src/index.ts`,
  `packages/app-service/src/index.ts`, `packages/core/src/workspace.ts`
- **Evidence:** `saveUnitOfWork()` serialises the complete workspace JSON,
  deletes every FTS row for the workspace, and rebuilds the index inside one
  synchronous `BEGIN IMMEDIATE` transaction. Page/block commands clone and
  validate the complete document before that write.
- **Risk:** edit latency and writer-lock duration grow with total workspace
  size. A large workspace can turn ordinary typing into long synchronous
  transactions and increase the cost of recovery.
- **Proposed change:** retain versioned workspace snapshots for portability,
  but persist dirty pages/collections and update only their FTS entries. Define
  a transaction-level change set returned by domain commands; periodically
  create a canonical full snapshot for export/migration.
- **Verification:** benchmark single-block edits at 1k/10k pages and 10k/100k
  blocks; record p50/p95 commit time and lock duration. Prove incremental and
  full-rebuild indexes return identical results, and inject failure between
  entity and FTS writes to prove rollback.

### TD-02 — Stream attachments and backups through bounded IPC

- **Priority / area:** P0 — reliability, performance
- **Affected files:** `apps/web/app.js`, `apps/web/app-adapter.js`,
  `apps/desktop/src/client.ts`, `apps/desktop/service-runner.mjs`,
  `packages/app-service/src/index.ts`, `packages/storage/src/index.ts`,
  `packages/backup/src/index.ts`
- **Evidence:** files are loaded into `Uint8Array`, expanded into JSON number
  arrays for IPC, read again for hashing/promotion, and collected in-memory for
  backup/restore. The service runner rejects requests above 16 MiB, so practical
  attachment size is lower than the data model implies.
- **Risk:** several simultaneous copies can exhaust memory; large valid files
  cannot cross the current IPC boundary; backup memory grows with total
  attachment bytes.
- **Proposed change:** add stream/file-handle attachment commands with chunked
  hashing and bounded staging; make backup creation/restoration stream archive
  entries rather than construct a `Record<string, Uint8Array>`. Keep the small
  byte-envelope path only for explicitly bounded payloads.
- **Verification:** round-trip 1 MiB, 100 MiB, and configured-limit files with
  checksum equality; verify a file above the limit fails before allocation;
  measure peak RSS during multi-file backup/restore and test interruption after
  every staged chunk.

### TD-03 — Prove installed UI durability at crash boundaries

- **Priority / area:** P0 — reliability
- **Affected files:** `scripts/smoke-packaged-app.mjs`,
  `apps/desktop/service-runner.mjs`, `apps/desktop/src-tauri/src/lib.rs`,
  `packages/storage/src/index.ts`, `packages/storage/src/test/storage.test.ts`,
  `.github/workflows/ci.yml`
- **Evidence:** CI extracts each AppImage and proves bundled-service restart,
  but does not launch the installed native UI. Current failure injection throws
  within a controlled transaction; it does not kill the process at filesystem,
  SQLite, attachment-promotion, or UI-state boundaries.
- **Risk:** release artifacts may fail only after installation or leave stale UI
  state, pending FTS work, or attachment metadata after abrupt termination.
- **Proposed change:** add an installed `.deb`/AppImage UI smoke harness on both
  supported architectures and deterministic kill points before/after commit,
  reindex completion, attachment metadata commit/promotion, and UI-state rename.
  Add disk-full and read-only data-directory cases.
- **Verification:** each kill-point test must reopen the installed application,
  produce either the old or fully committed revision, pass FTS integrity, and
  report no lost referenced attachment. Run on x86-64 and ARM64 release jobs.

### TD-04 — Remove full-store attachment recovery from every async operation

- **Priority / area:** P1 — performance, maintainability
- **Affected files:** `packages/app-service/src/index.ts`,
  `packages/storage/src/index.ts`
- **Evidence:** every async attachment/backup command and query calls
  `recoverAttachments()`. It loads and validates every workspace document, then
  scans staging plus all content-address buckets even when the previous
  operation shut down cleanly.
- **Risk:** attachment reads and backups acquire latency proportional to all
  workspaces and blobs; unrelated corrupt workspace metadata can block a valid
  attachment operation.
- **Proposed change:** run recovery at service startup and when a durable
  recovery-needed marker exists. Store referenced hashes in queryable metadata
  so recovery does not parse all workspace JSON; target recovery to affected
  hashes after promotion failures.
- **Verification:** seed 10k attachment records and 100 workspaces; prove steady
  attachment-read latency does not scan the blob tree. Kill after metadata
  commit and prove the next startup still repairs the staged blob.

### TD-05 — Add a summary query that does not parse every workspace

- **Priority / area:** P1 — performance
- **Affected files:** `packages/storage/src/index.ts`,
  `packages/app-service/src/index.ts`, `apps/desktop/service-runner.mjs`
- **Evidence:** `workspace.list` calls `SqliteWorkspaceStore.list()`, which
  selects and parses `document_json` for every workspace just to return ID,
  name, update time, and revision. UI load/save call this path.
- **Risk:** startup, workspace selection, and every compatibility save grow with
  the combined byte size of all workspaces.
- **Proposed change:** persist the display name beside workspace metadata and add
  `listSummaries()` selecting only metadata columns. Migrate existing rows by
  deriving the name once; load a full document only after selection.
- **Verification:** create 100 large workspaces and assert summary results match
  full documents while query time and allocated bytes remain independent of
  `document_json` size. Add migration/restart coverage.

### TD-06 — Replace repeated hierarchy scans and recursive traversal

- **Priority / area:** P1 — performance, reliability
- **Affected files:** `packages/core/src/validation.ts`,
  `packages/core/src/workspace.ts`, `packages/core/src/export.ts`,
  `packages/backup/src/index.ts`, `apps/web/app.js`,
  `apps/web/workspace-v1.js`
- **Evidence:** validation follows each parent with `pages.find()`, descendants
  repeatedly filter the full page list recursively, and several Web/backup paths
  repeat linear ancestor/descendant scans.
- **Risk:** deep or wide hierarchies become quadratic; recursive paths can exceed
  the JavaScript call stack even when input counts are otherwise valid.
- **Proposed change:** build one `pageById` map and parent-to-children adjacency
  index per operation; use iterative DFS with explicit visit states for cycle
  checks and traversal. Reuse the same hierarchy utility across validation,
  domain operations, backup, and compatibility code.
- **Verification:** validate, move, export, trash, and restore deterministic
  10k-page deep and wide fixtures without stack overflow; add a scaling check
  showing near-linear runtime and preserve existing cycle errors.

### TD-07 — Make the canonical command model the only desktop mutation path

- **Priority / area:** P1 — maintainability, reliability
- **Affected files:** `apps/web/app.js`, `apps/web/workspace-v1.js`,
  `apps/web/app-adapter.js`, `apps/desktop/service-runner.mjs`,
  `packages/core/src/migrations/web-v1.ts`, `packages/app-service/src/index.ts`
- **Evidence:** the Web client mutates a schema-v1 document, browser code
  normalises it, and the desktop runner migrates the full document again before
  writing directly through the store. Typed page commands exist alongside this
  compatibility lane.
- **Risk:** two mutation models can drift, overwrite fields not represented by
  Web-v1, and require every new domain field to be handled in several modules.
- **Proposed change:** keep Web-v1 only as an explicit import migration. Route
  editor mutations through typed app-service commands/queries and generated or
  shared DTO types; remove direct `store.saveUnitOfWork()` from the runner.
- **Verification:** contract tests run the same create/edit/move/trash/restore
  sequence through browser and Tauri adapters and compare canonical snapshots,
  revisions, links, and restart results. Add a fixture with unknown future fields
  to prove edits do not erase them.

### TD-08 — Split high-change monoliths and replace source-text tests

- **Priority / area:** P1 — maintainability
- **Affected files:** `apps/web/app.js`, `packages/core/src/validation.ts`,
  `packages/app-service/src/index.ts`, `apps/web/test/web.test.mjs`,
  `apps/desktop/test/client.test.mjs`
- **Evidence:** the three main modules are approximately 26 KiB, 19 KiB, and
  18 KiB and mix unrelated responsibilities. Several Web/desktop tests inspect
  source strings rather than exercise exported behaviour.
- **Risk:** routine changes have a large regression surface; formatting or safe
  refactoring can break tests while behavioural drift can still pass.
- **Proposed change:** extract Web state/actions/rendering, validation domains,
  and app-service command handlers behind stable interfaces. Convert structural
  source assertions into adapter/DOM/IPC contract tests; retain only narrowly
  justified static policy checks.
- **Verification:** existing behaviour suite remains green; add direct tests for
  each extracted interface and mutation lane. Track module dependency cycles and
  require zero cycles in the extracted graph.

### TD-09 — Remove repeated TypeScript compilation from the npm lifecycle

- **Priority / area:** P2 — maintainability, engineering efficiency
- **Affected files:** root and workspace `package.json` files, package
  `tsconfig.json` files, `.github/workflows/ci.yml`
- **Evidence:** package `test`, `prebuild`, and `pretypecheck` scripts recursively
  build dependencies. A root test/typecheck/build run compiles core, storage,
  and backup repeatedly before doing the same root build again.
- **Risk:** slow feedback and CI time obscure the actual failing stage and grow
  disproportionately as packages are added.
- **Proposed change:** define TypeScript project references with one ordered root
  build, separate `test:compiled` from compilation, and let CI build once before
  test/typecheck consumers. Preserve standalone workspace commands.
- **Verification:** clean-clone CI produces the same artifacts and test results;
  instrument compiler invocations and show each project builds at most once per
  gate. Record before/after wall time for verify and native jobs.

### TD-10 — Benchmark the production SQLite/FTS and packaged paths

- **Priority / area:** P1 — performance
- **Affected files:** `scripts/benchmark.mjs`, `scripts/benchmark-smoke.mjs`,
  `packages/search/src/search.ts`, `packages/storage/src/index.ts`,
  `docs/BENCHMARKS.md`, `.github/workflows/ci.yml`
- **Evidence:** the benchmark measures `LocalSearch` with the in-memory adapter,
  while the application uses SQLite FTS through the app service. The CI smoke
  fixture uses only 250 pages/2,000 blocks and records one query. On this audit
  host the 10k-page/100k-block query took 243.57 ms against the documented
  200 ms target, but `scripts/benchmark.mjs` still exited successfully because
  it fails only on integrity or empty results.
- **Risk:** the current green benchmark does not detect regressions in actual
  persistence, FTS, IPC, startup, mutation, or packaged memory use.
- **Proposed change:** add deterministic app-service/SQLite fixtures at
  10k pages/100k blocks, mixed query sets, incremental edits, cold/warm startup,
  and packaged-runtime sampling. Record p50/p95, RSS, database size, and hardware
  metadata. Keep the small smoke test for fast feedback.
- **Verification:** benchmark output is reproducible by seed, validates result
  correctness/integrity, and publishes comparable artifacts. Set CI thresholds
  only after representative x86-64 and ARM64 baselines are reviewed.

### TD-11 — Define and test the SQLite writer/concurrency policy

- **Priority / area:** P1 — reliability, maintainability
- **Affected files:** `packages/storage/src/index.ts`,
  `packages/app-service/src/index.ts`, `apps/desktop/service-runner.mjs`,
  `packages/storage/src/test/storage.test.ts`
- **Evidence:** the store uses synchronous `BEGIN IMMEDIATE` transactions with
  one expected service process, but has no explicit busy timeout, process lock,
  or test for a second writer opening the same database/data directory.
- **Risk:** accidental duplicate application/service instances can produce
  immediate lock failures or interleave filesystem attachment recovery without
  a documented ownership rule.
- **Proposed change:** decide and enforce single-writer ownership for 0.1.0 (or
  implement bounded multi-writer retry deliberately), set an explicit busy
  policy, and coordinate attachment recovery with the same ownership mechanism.
- **Verification:** start two service processes against one data root and prove
  deterministic rejection or bounded conflict handling without lost revisions,
  corrupt FTS state, or duplicate attachment promotion.

## Recommended execution order

1. **Release evidence:** TD-03.
2. **Data-path scale:** TD-01 and TD-02.
3. **Remove avoidable whole-store work:** TD-04, TD-05, and TD-06.
4. **Stabilise ownership boundaries:** TD-07 and TD-11.
5. **Improve change throughput and evidence:** TD-08, TD-09, and TD-10.

TD-01 and TD-07 need a short Managing Director-approved sequencing decision:
incremental persistence should be designed against the canonical typed command
model, not against the temporary Web-v1 save path. Implementation can begin on
TD-03 and the benchmark harness without waiting for that decision.

## Audit validation

The audit was grounded in source inspection of the listed files and the current
test/build configuration. On 2026-08-05, from `main` at `fda1653`:

- `npm test`: **pass**, 62 tests.
- `npm run typecheck`: **pass**.
- `npm run build`: **pass**.
- `npm run benchmark`: completed with index integrity true, 115.88 ms indexing
  and 243.57 ms query time for 10k pages/100k blocks; the 200 ms query target
  was **not met**.
- `git diff --check`: **pass**.

The benchmark result is directional only: it measures the in-memory search
adapter on this host, not the SQLite/FTS or installed desktop path.
