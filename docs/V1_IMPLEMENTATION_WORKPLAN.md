# Motion V1.0 Implementation Plan

Status: active
Scope last updated: 2026-08-11 by Jake's explicit V1 decision
Canonical scope: [`V1_SCOPE.md`](V1_SCOPE.md)

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task, with a specification review and code-quality review before each merge.

**Goal:** Ship Motion V1.0 as a dependable, offline, single-user Linux knowledge workspace with production-grade documents, stable linked knowledge, typed databases, all nine mandatory database views, portable data, and verified x86-64/ARM64 desktop releases.

**Architecture:** Keep SQLite and structured workspace data authoritative behind `packages/app-service`. Replace the Web-v1 compatibility UI with a React and Tiptap/ProseMirror client that sends fine-grained typed commands through the existing browser/Tauri adapter boundary. Implement every user capability as a vertical slice spanning model, validation, command/query service, persistence, UI, restart/export behavior, and automated acceptance.

**Tech stack:** TypeScript, Node 22/24, React, Tiptap/ProseMirror, SQLite/FTS5, Tauri 2/Rust, Playwright, Node test runner, GitHub Actions.

---

## 1. V1.0 product contract

V1.0 is complete only when all of the following outcomes pass in packaged AppImage and Debian builds with networking disabled.

### Included

1. **Pages and navigation**
   - Create, rename, nest, move, reorder, favourite, trash, restore, and permanently delete from Trash.
   - Pointer drag-and-drop and equivalent keyboard commands.
   - Stable hierarchy, breadcrumbs, selection, and restart behavior.

2. **Daily-writing editor**
   - Paragraphs, headings 1–3, bulleted/numbered lists, tasks, toggles, quotes, callouts, dividers, code blocks, images/files, page mentions, and unsupported placeholders.
   - Stable block IDs; single/multi-block selection; duplicate, delete, transform, reorder, indent/outdent, cross-page move, copy/paste, copy as Markdown, undo, and redo.
   - IME composition, multiline paste, 10,000-word documents, and unknown-block preservation.

3. **Linked knowledge and search**
   - `@` mentions and `[[...]]` completion select stable IDs.
   - Outgoing links, backlinks, block deep links, previews, and honest live/trashed/missing states.
   - Search titles, block text, table values, and attachment filenames with snippets, highlights, filters, keyboard navigation, and deterministic ordering.

4. **Typed databases**
   - Records remain normal pages.
   - Title, text, number, checkbox, select, multi-select, status, date, URL, email, phone, files, location, relation, rollup, and formula properties.
   - Property creation, rename, reorder, width, visibility, type conversion with preview, and deletion with consequences.
   - Nested filters, deterministic multi-sort, grouping, and saved view state.

5. **Core views**
   - Table, list, board, calendar, gallery, timeline, chart, feed, and map.
   - Independent saved configuration over shared record data.
   - Pointer and keyboard operations, empty/null/deleted states, restart, export, and restore.
   - Accessible chart source data, a deterministic local-record feed, and an
     offline map path using explicit coordinates with no silent remote tiles or
     geocoding.

6. **Portability and reliability**
   - Structured JSON workspace export/restore, Markdown tree export/import, CSV export/import, and attachment-complete verified backup.
   - Import preflight, limits, compatibility report, cancellation, and transactional rollback.
   - Offline launch, save, search, backup, restore, and restart.

7. **Release quality**
   - WCAG 2.2 AA automated checks plus documented keyboard and Linux screen-reader passes.
   - Representative performance and failure-injection gates.
   - Signed, provenance-bound x86-64 and ARM64 AppImage/Debian artifacts.

### Explicitly deferred to post-V1

- Sync, collaboration, accounts, sharing, comments, presence, permissions, and public publishing.
- AI, MCP, connectors, automations, webhooks, and public API.
- Windows, macOS, mobile, hosted service, and browser-as-product distribution.
- Form, dashboard, canvas, mail, and separate calendar products. Database chart,
  feed, and map views remain mandatory V1 scope.
- Application-level encrypted vaults. Release wording must explicitly state local data is not application-encrypted.

### Non-negotiable constraints

- Complete local mode without account or network access.
- Structured versioned data remains authoritative; rendered HTML is never canonical.
- No telemetry or silent remote resources.
- Unknown newer blocks/fields remain lossless and visibly unsupported.
- Every persisted schema change has a migration and restart/export/restore tests.
- Every pointer action has a keyboard path.

---

## 2. Delivery model

### Branch and merge policy

- Create one branch per vertical slice from current green `main`.
- Do not merge schema-only or UI-only feature claims.
- Require: focused tests, full affected-workspace tests, typecheck, build, offline scan, `git diff --check`, specification review, and code-quality review.
- Squash merge only after CI passes on the exact candidate commit.
- Keep `main` releasable after Phase 0.

### Parallel lanes

- **Lane A — Release foundation:** CI, persistence, reliability, packaging.
- **Lane B — Documents:** typed service commands and React/Tiptap editor.
- **Lane C — Knowledge:** links, search, attachments, import/export.
- **Lane D — Databases:** table completion, saved views, relations/formulas.
- **Lane E — Quality:** accessibility, performance, E2E, packaged acceptance.

Lane A Phase 0 blocks all feature merges. After that, B–E may proceed in parallel where contracts are stable.

---

## 3. Phase 0 — Restore a truthful green baseline

**Target:** Weeks 1–2
**Exit gate:** One immutable `main` commit passes every configured CI job; no intended test exists outside a documented gate.

### Task 0.1: Repair missing npm script wiring

**Files:**
- Modify: `package.json`
- Inspect/use: `scripts/dependency-release-gate.mjs`
- Inspect/use: `scripts/release-security-preflight.mjs`
- Inspect/use: `scripts/release-manifest-hardening.test.mjs`
- Test: `.github/workflows/ci.yml`

**Steps:**
1. Add a test that parses every `npm run` reference in `.github/workflows/*.yml` and fails if no matching workspace/root script exists.
2. Run it and verify it reports the six currently missing scripts.
3. Add exact scripts for dependency release, offline dependency validation, runtime confinement, backup integrity, release preflight, and release manifest enforcement; rename workflow calls only where an existing script is canonical.
4. Run each command independently and prove it exercises a real gate rather than a no-op wrapper.
5. Run the workflow/script consistency test again.
6. Commit: `ci: restore release gate script contracts`.

### Task 0.2: Repair static-analysis policy anchors

**Files:**
- Modify: `static-analysis-policy.json`
- Modify only if defective: `scripts/static-analysis.mjs`
- Test: `scripts/static-analysis.test.mjs`

**Steps:**
1. Add/retain a test proving source movement invalidates stale suppressions.
2. Identify the exact current findings and compare them with the pre-change baseline.
3. Fix unsafe source where possible; refresh only reviewed, narrowly scoped fingerprints for accepted findings.
4. Run `npm run static-analysis` and `npm run test:static-analysis`.
5. Verify report permissions and that sensitive source is not echoed.
6. Commit: `security: reconcile static analysis policy with source`.

### Task 0.3: Gate all intended browser acceptance suites

**Files:**
- Modify: `package.json`
- Modify: `playwright.config.ts` if required
- Tests: `e2e/web.spec.ts`
- Tests: `e2e/editor-accessibility.spec.ts`
- Tests: `e2e/first-run-table-creation.spec.ts`
- Tests: `e2e/table-cell-search.spec.ts`
- Tests: `e2e/destructive-accessibility.spec.ts`

**Steps:**
1. Add a test asserting every tracked `e2e/*.spec.ts` is included by a release command or explicitly documented as non-release.
2. Change `test:e2e` to run the complete supported E2E set.
3. Keep focused scripts for destructive and accessibility diagnostics where useful, without replacing the complete suite.
4. Run all E2E tests with external HTTP/WebSocket access blocked.
5. Commit: `test: gate complete browser acceptance suite`.

### Task 0.4: Integrate outstanding verified fixes

**Branches:**
- `feat/link-lifecycle-recovery`
- `fix/motion-ux-005-accessible-search`
- `fix/motion-ux-011-recoverable-edits`

**Steps:**
1. Rebase each branch onto repaired `main` in a separate worktree.
2. Inventory overlapping changes by behavior, not commit count.
3. Preserve the stable-link lifecycle tests from the feature branch.
4. Preserve accessible search, failed-edit recovery, and identifier-keyed backup remapping where not superseded.
5. Run focused tests after each cherry-pick/reimplementation.
6. Run complete CI once on the combined integration branch.
7. Merge in dependency order and delete superseded remote branches.

### Task 0.5: Freeze current evidence and update status

**Files:**
- Modify: `docs/STATUS.md`
- Modify: `docs/ENGINEERING_HEALTH.md`
- Modify: `docs/QUALITY_RELEASE_STATUS.md`
- Modify: `docs/FEATURE_PARITY.md`
- Create: `docs/V1_SCOPE.md`

Document exact commit, CI run, supported features, excluded features, known blockers, and V1 acceptance rule. Remove stale claims such as “no milestone complete” when contradicted by current evidence.

---

## 4. Phase 1 — Canonical mutation and scale foundation

**Target:** Weeks 2–4
**Exit gate:** Desktop UI mutations no longer depend on whole-document Web-v1 saves; normal edits update bounded persisted/indexed data.

### Task 1.1: Define typed document command contracts

**Files:**
- Modify: `packages/app-service/src/index.ts`
- Modify: `packages/core/src/model.ts`
- Modify: `packages/core/src/workspace.ts`
- Modify: `apps/web/app-adapter.d.ts`
- Modify: `apps/web/app-adapter.js`
- Modify: `apps/desktop/service-runner.mjs`
- Tests: `packages/app-service/src/test/app-service.test.ts`

Add commands/queries for block create, replace content, transform, move, nest/outdent, duplicate, delete, and batch transaction. Include expected revision, stable IDs, deterministic target position, and typed result/failure DTOs.

Use TDD for each command:
1. Write a failing domain/service test.
2. Run the focused test and verify the expected failure.
3. Implement the minimal command and validation.
4. Add SQLite restart, unknown-field preservation, and revision-conflict assertions.
5. Run focused package tests.
6. Commit one coherent command family at a time.

### Task 1.2: Make Web-v1 import-only

**Files:**
- Modify: `apps/web/workspace-v1.js`
- Modify: `apps/web/app-adapter.js`
- Modify: `packages/core/src/migrations/web-v1.ts`
- Modify: `apps/desktop/service-runner.mjs`
- Tests: `packages/app-service/src/test/app-service.test.ts`
- Tests: `apps/web/test/web.test.mjs`

Route normal native editing solely through typed commands. Retain Web-v1 only as an explicit migration/import path. Add contract tests comparing browser and Tauri adapter snapshots after the same command sequence.

### Task 1.3: Implement incremental persistence and FTS updates

**Files:**
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/app-service/src/index.ts`
- Modify: `packages/core/src/workspace.ts`
- Tests: `packages/storage/src/test/storage.test.ts`
- Tests: `packages/app-service/src/test/app-service.test.ts`
- Modify: `scripts/benchmark.mjs`

Introduce transaction change sets for dirty pages, collections, links, and FTS entities. Keep periodic canonical snapshots for migration/export. Prove incremental and full-rebuild indexes return identical results and roll back atomically.

### Task 1.4: Enforce single-writer ownership

**Files:**
- Modify: `packages/storage/src/index.ts`
- Modify: `apps/desktop/service-runner.mjs`
- Tests: `packages/storage/src/test/storage.test.ts`
- Tests: `apps/desktop/test/runner.test.mjs`

Start two service processes against one data root and verify deterministic rejection or bounded conflict handling without lost revisions, attachment races, or corrupt FTS.

---

## 5. Phase 2 — Production React/Tiptap editor

**Target:** Weeks 4–8
**Exit gate:** The compatibility editor is no longer an authoritative editing path; all V1 block behaviors pass restart/export/restore and accessibility acceptance.

### Task 2.1: Establish the React application shell

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/scripts/build.mjs`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/services/motion-adapter.ts`
- Create: `apps/web/src/state/workspace-store.ts`
- Modify: `apps/web/index.html`
- Tests: `apps/web/test/web.test.mjs`

Preserve local-only assets and the existing browser/Tauri adapter contract. Add a canary page load, save, restart, and offline E2E before migrating features.

### Task 2.2: Define Motion-owned ProseMirror schema and codec

**Files:**
- Create: `packages/editor/package.json`
- Create: `packages/editor/src/schema.ts`
- Create: `packages/editor/src/codec.ts`
- Create: `packages/editor/src/commands.ts`
- Create: `packages/editor/src/test/codec.test.ts`
- Modify: root `package.json` workspaces only if required

Implement stable block IDs, supported node types, deterministic conversion to/from canonical blocks, and opaque unsupported placeholders. No rendered HTML persistence.

### Task 2.3: Implement basic editing and persistence

**Files:**
- Create: `apps/web/src/editor/MotionEditor.tsx`
- Create: `apps/web/src/editor/extensions/*.ts`
- Modify: `apps/web/src/App.tsx`
- Tests: `e2e/editor.spec.ts`

Implement paragraphs, headings, lists, tasks, toggles, quotes, callouts, dividers, code, page mentions, images/files, and save-state announcements through typed service commands.

### Task 2.4: Implement structural commands

**Files:**
- Modify: `packages/editor/src/commands.ts`
- Modify: `apps/web/src/editor/MotionEditor.tsx`
- Tests: `packages/editor/src/test/commands.test.ts`
- Tests: `e2e/editor-structure.spec.ts`

Implement selection, duplicate, delete, transform, indent/outdent, reorder, and cross-page movement. Each command must have keyboard and pointer paths issuing the same canonical command.

### Task 2.5: Clipboard, history, IME, and long documents

**Files:**
- Create: `packages/editor/src/clipboard.ts`
- Create: `packages/editor/src/history.ts`
- Tests: `packages/editor/src/test/clipboard.test.ts`
- Tests: `e2e/editor-input.spec.ts`

Cover internal copy/paste, copy as Markdown, multiline paste, IME composition, undo/redo after confirmed persistence, selection across blocks, and 10,000-word documents with no acknowledged lost edit.

### Task 2.6: Remove the old editor path

Delete or isolate obsolete editor mutation/rendering from `apps/web/app.js`. Keep migration fixtures and explicit compatibility import tests. Update ADR 0006 with the production verdict.

---

## 6. Phase 3 — Linked knowledge, search, and attachments

**Target:** Weeks 5–9, parallel with Phase 2
**Exit gate:** Links and search remain correct through rename, move, trash, restore, restart, export, and backup restore.

### Task 3.1: Complete link entry and lifecycle

**Files:**
- Create: `apps/web/src/editor/extensions/page-link.ts`
- Create: `apps/web/src/components/LinkPicker.tsx`
- Create: `apps/web/src/components/PageContext.tsx`
- Modify: `packages/app-service/src/index.ts`
- Tests: `e2e/link-lifecycle.spec.ts`

Implement `@` and `[[...]]` completion by stable ID, live/trashed/missing states, recovery action, current-title presentation, outgoing links, backlinks, and duplicate-safe indexing.

### Task 3.2: Add block deep links and previews

**Files:**
- Modify: `packages/core/src/model.ts`
- Modify: `packages/app-service/src/index.ts`
- Create: `apps/web/src/services/internal-links.ts`
- Create: `apps/web/src/components/LinkPreview.tsx`
- Tests: `packages/app-service/src/test/app-service.test.ts`
- Tests: `e2e/deep-links.spec.ts`

Copyable internal URLs must focus a stable block and survive page rename/move. Missing targets show an honest recovery state.

### Task 3.3: Complete search UX and performance

**Files:**
- Modify: `packages/search/src/search.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/app-service/src/index.ts`
- Create: `apps/web/src/components/QuickSearch.tsx`
- Tests: `packages/search/src/test/search.test.ts`
- Tests: `e2e/search.spec.ts`
- Modify: `scripts/search-benchmark-lib.mjs`

Add snippets, safe highlights, page/record/attachment filters, recent-search controls, deterministic keyboard navigation, and p50/p95 representative SQLite/FTS measurements.

### Task 3.4: Stream attachments through bounded IPC

**Files:**
- Modify: `apps/desktop/src/client.ts`
- Modify: `apps/desktop/service-runner.mjs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `packages/app-service/src/index.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/backup/src/index.ts`
- Tests: corresponding desktop/app-service/storage/backup tests

Add file-handle/chunk commands, configured limits, chunked hashing, bounded staging, cancellation, and recovery. Verify 1 MiB and 100 MiB round trips, above-limit rejection before allocation, and bounded backup RSS.

---

## 7. Phase 4 — Complete typed databases and saved views

**Target:** Weeks 8–15
**Exit gate:** Table, list, board, calendar, gallery, timeline, chart, feed, and map independently persist configuration and operate over shared records.

### Task 4.1: Finish table property lifecycle

**Files:**
- Modify: `packages/core/src/model.ts`
- Modify: `packages/core/src/validation.ts`
- Modify: `packages/app-service/src/index.ts`
- Create: `apps/web/src/database/TableView.tsx`
- Create: `apps/web/src/database/PropertyEditor.tsx`
- Tests: `packages/core/src/test/core.test.ts`
- Tests: `packages/app-service/src/test/app-service.test.ts`
- Tests: `e2e/table.spec.ts`

Add populated type-change preview/conversion, deletion consequences, full virtual scrolling, keyboard column movement, and stable row focus.

### Task 4.2: Canonical saved-view lifecycle

**Files:**
- Modify: `packages/app-service/src/index.ts`
- Create: `apps/web/src/database/ViewTabs.tsx`
- Create: `apps/web/src/database/view-state.ts`
- Tests: `packages/app-service/src/test/app-service.test.ts`
- Tests: `e2e/saved-views.spec.ts`

Add view create, rename, duplicate, reorder, select, update, and delete commands. Persist view configuration; keep active selection in existing UI-state persistence unless product requirements make it shared content.

### Task 4.3: Implement list view

**Files:**
- Create: `apps/web/src/database/ListView.tsx`
- Tests: `e2e/list-view.spec.ts`

Verify independent property visibility/order, filters/sorts, record opening, keyboard navigation, restart, export, and restore.

### Task 4.4: Implement board view

**Files:**
- Create: `apps/web/src/database/BoardView.tsx`
- Create: `packages/app-service/src/commands/board.ts` if command extraction has occurred
- Tests: `e2e/board-view.spec.ts`

Group by select/status, move/reorder cards through validated property mutations, and provide keyboard move controls. Test null/deleted groups and deterministic order.

### Task 4.5: Implement calendar view

**Files:**
- Create: `apps/web/src/database/CalendarView.tsx`
- Tests: `e2e/calendar-view.spec.ts`

Configure a date property, render deterministic date placement, move records by validated date mutation, and cover no-date/time-zone boundaries.

### Task 4.6: Implement gallery view

**Files:**
- Create: `apps/web/src/database/GalleryView.tsx`
- Tests: `e2e/gallery-view.spec.ts`

Persist card preview and visible properties; never fetch remote media silently. Cover missing/deleted attachments.

### Task 4.7: Implement timeline view

**Files:**
- Create: `apps/web/src/database/TimelineView.tsx`
- Tests: `e2e/timeline-view.spec.ts`

Configure start/end properties, validate ranges, move/resize via canonical mutations, and provide keyboard alternatives.

### Task 4.8: Implement chart view

**Files:**
- Create: `apps/web/src/database/ChartView.tsx`
- Create: `packages/app-service/src/queries/chart.ts` if query extraction has occurred
- Tests: `e2e/chart-view.spec.ts`

Persist dimension, measure, aggregation, series and chart-type configuration.
Compute results through the canonical typed query path with deterministic null and
empty-set semantics. Provide a keyboard-accessible source-data table and text
summary; do not make a standalone dashboard system part of this slice.

### Task 4.9: Implement feed view

**Files:**
- Create: `apps/web/src/database/FeedView.tsx`
- Tests: `e2e/feed-view.spec.ts`

Persist date/order, grouping, preview and visible-property configuration. Render a
deterministic stream of shared records with virtualised long-list behavior and full
keyboard record navigation. Feed is local record presentation, not collaboration,
presence, comments, or remotely sourced activity.

### Task 4.10: Implement map view

**Files:**
- Modify: `packages/core/src/model.ts`
- Modify: `packages/core/src/validation.ts`
- Modify: `packages/app-service/src/index.ts`
- Create: `apps/web/src/database/MapView.tsx`
- Tests: core/app-service location tests and `e2e/map-view.spec.ts`

Add an explicit location value with bounded latitude/longitude and optional human
label, then persist location-property, viewport, clustering and visible-property
configuration. The view must remain functional with networking denied, never
silently fetch tiles or geocoding, handle invalid/missing/deleted locations
deterministically, and expose the same records through an accessible list/table
alternative.

---

## 8. Phase 5 — Relations, rollups, formulas, and reusable structures

**Target:** Weeks 12–16
**Exit gate:** Advanced properties produce deterministic persisted results and survive deletion/export/restore.

### Task 5.1: Implement relation mutations

**Files:**
- Modify: `packages/core/src/workspace.ts`
- Modify: `packages/core/src/validation.ts`
- Modify: `packages/app-service/src/index.ts`
- Create: `apps/web/src/database/RelationEditor.tsx`
- Tests: core/app-service/E2E relation suites

Implement one-way/reciprocal relations, cardinality, limits, deleted targets, filters, restart, and export metadata.

### Task 5.2: Implement rollups

Define explicit count/sum/min/max/average/earliest/latest semantics, null/missing/deleted behavior, and deterministic results. Add cycle/restart/export tests.

### Task 5.3: Integrate formulas

**Files:**
- Modify: `packages/formula/src/*`
- Modify: `packages/app-service/src/index.ts`
- Create: `apps/web/src/database/FormulaEditor.tsx`
- Tests: formula/app-service/E2E suites

Use stable property IDs, typed errors, cycle reporting, formula-result filters/sorts, and versioned source serialization.

### Task 5.4: Add basic templates

Implement create-template-from-page/database, instantiate with new stable IDs, edit/delete template, and export/restore template definitions. Exclude public galleries and remote templates.

---

## 9. Phase 6 — Import, export, backup, and recovery

**Target:** Weeks 13–17
**Exit gate:** A user can move representative notes into Motion and reconstruct the complete workspace elsewhere without silent loss.

### Task 6.1: Staged Markdown-folder import

**Files:**
- Create: `packages/import/src/markdown.ts`
- Create: `packages/import/src/preflight.ts`
- Modify: `packages/app-service/src/index.ts`
- Create: `apps/web/src/import/ImportDialog.tsx`
- Tests: hostile paths, hierarchy, links, unsupported content, cancellation, idempotency

### Task 6.2: Staged CSV import

Add delimiter/encoding detection, property-type confirmation, preflight, atomic creation, warnings, and rerun behavior.

### Task 6.3: Complete full export

Ensure structured JSON, Markdown tree, CSV companion metadata, and attachment manifest reproduce IDs, hierarchy, blocks, database schemas/views, links, relations, formulas, templates, and hashes.

### Task 6.4: Stream verified backup/restore

Replace whole-bundle in-memory construction with bounded archive streaming. Add hostile archive, traversal, oversized, interruption, disk-full, and restore-equivalence tests.

---

## 10. Phase 7 — Accessibility, reliability, and performance closure

**Target:** Weeks 15–19
**Exit gate:** All V1 quality budgets pass on representative source and packaged paths.

### Task 7.1: WCAG and keyboard automation

Add axe-core or equivalent local automation, focus-order tests, visible focus, live announcements, dialog focus management, 200% zoom, reduced motion, and complete pointer/keyboard equivalence.

### Task 7.2: Manual screen-reader acceptance

Record Linux Orca results for navigation, editor, search, database views, Trash, attachments, import/export, backup, and restore. File every failure with reproduction and evidence.

### Task 7.3: Crash and filesystem failure injection

Add deterministic kill points before/after SQLite commit, FTS update, attachment metadata/promotion, backup publication, and UI-state rename. Test disk-full, read-only data directory, corrupt index, and duplicate process.

### Task 7.4: Representative performance gates

Fixtures and budgets:
- 10,000 pages / 100,000 blocks.
- 5,000 database records across all V1 views.
- 10,000-word editor document.
- 100 MiB attachment and multi-file backup.

Record p50/p95 startup, typing commit, search, view interaction, backup/restore, peak RSS, database size, architecture, and hardware metadata. Establish reviewed x86-64 and ARM64 budgets before making CI fail on timing.

### Task 7.5: Dependency and source-security closure

Run dependency inventory, offline vulnerability scanning, static analysis, secret scan, unsafe-default scan, diagnostic leakage, runtime confinement, backup integrity, and release preflight. No missing/skipped gate may pass.

---

## 11. Phase 8 — V1.0 release candidate and publication

**Target:** Weeks 18–20
**Exit gate:** Signed V1.0 artifacts and complete acceptance evidence are published from one reviewed commit.

### Task 8.1: Freeze V1.0 RC

- Set package/Tauri versions to `1.0.0`.
- Update schema compatibility and migration documentation.
- Freeze dependency locks and inventories.
- Update `README.md`, `docs/RELEASE.md`, `docs/STATUS.md`, and release notes.
- Tag only after acceptance; do not retag a failed candidate.

### Task 8.2: Build four canonical artifacts

- x86-64 AppImage
- x86-64 Debian package
- ARM64 AppImage
- ARM64 Debian package

Bind names, sizes, SHA-256 hashes, version, repository, and exact 40-character commit in the signed manifest and provenance.

### Task 8.3: Installed-package acceptance

On clean representative x86-64 and ARM64 graphical hosts, test both package formats with networking disabled:
- Install/launch and desktop menu.
- Full page/editor/link/search/table/view workflow.
- Attachment, import/export, backup/restore.
- Normal restart and forced termination.
- Keyboard, screen reader, and 200% zoom.
- Debian remove/reinstall preserving user data.

Record OS, architecture, artifact hash, tester, date, screenshots/logs, and pass/fail for every criterion.

### Task 8.4: Publish V1.0

- Obtain Quality and Security sign-off against exact artifacts.
- Create immutable `v1.0.0` tag.
- Publish GitHub Release with signed manifest, attestations, checksums, installation instructions, known limitations, and data-path documentation.
- Verify downloaded artifacts independently using `npm run verify:release`.
- Run post-release installation smoke from the public assets.

---

## 12. Required verification commands

Run from a clean checkout with Node 22.22+ and the repository-pinned Rust toolchain:

```sh
npm ci --ignore-scripts
npm run inventory:dependencies:check
npm run static-analysis
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:offline
npm run benchmark
npm run scan:secrets
npm run scan:unsafe-defaults
git diff --check
```

Also run all restored release-gate scripts individually, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, native package builds on both architectures, packaged service smoke, and installed-window acceptance.

Expected result for an RC: every command exits zero; no missing/skipped gate; repository clean; generated evidence names the exact RC commit.

---

## 13. Milestones and decision gates

| Milestone | Target | Decision gate |
| --- | --- | --- |
| Green baseline | Week 2 | Current CI truthful and green; branches reconciled |
| Canonical command/storage path | Week 4 | No Web-v1 normal mutation; bounded persistence |
| Production editor | Week 8 | Daily-writing acceptance passes |
| Knowledge workflows | Week 9 | Link/search/attachment lifecycle passes |
| Nine mandatory views | Week 15 | Table/list/board/calendar/gallery/timeline/chart/feed/map pass |
| Advanced properties and interchange | Week 17 | Relations/formulas/import/export complete |
| Quality closure | Week 19 | Accessibility/reliability/performance gates pass |
| V1.0 publication | Week 20 | Four accepted, signed artifacts published |

At each gate, reduce scope only by an explicit Jake-approved change to `docs/V1_SCOPE.md`. Do not silently label incomplete capability as V1-ready.

---

## 14. Principal risks and mitigations

1. **Editor replacement expands into a storage rewrite.** Keep storage and IPC contracts stable; migrate editing behind typed commands first.
2. **Schema declarations are mistaken for features.** Require rendered, persisted, restarted, exported, restored, and E2E-tested evidence for every capability.
3. **Parallel branches diverge.** Use small vertical branches, one owner per contract, daily rebase, and merge only through green integration.
4. **Performance work arrives too late.** Complete incremental persistence before editor rollout and benchmark each database view at 5,000 records.
5. **Native defects appear after source tests pass.** Begin weekly package smoke during development; do not defer installed UI testing to final RC.
6. **V1 scope grows toward all of Notion.** Enforce the explicit post-V1 exclusions above.
7. **Security gates become ceremonial.** Keep every gate fail-closed, executable independently, and tested with seeded violations.
8. **Documentation drifts.** Update status/parity evidence in the same PR that changes capability state.

---

## 15. Definition of done

Motion V1.0 is done when:

- Every included outcome is implemented vertically and accepted in packaged Linux builds.
- Complete CI is green on the exact release commit.
- Data survives restart, force termination, export/restore, and package reinstall.
- No included workflow requires an account or network.
- Accessibility, performance, security, and provenance gates have recorded evidence.
- Four signed architecture/package artifacts are independently verifiable.
- Documentation accurately states capabilities, exclusions, encryption status, and recovery procedures.
- The public `v1.0.0` tag and GitHub Release point to the accepted immutable commit.
