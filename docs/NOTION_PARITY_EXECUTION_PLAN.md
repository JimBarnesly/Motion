# Motion core-workspace parity execution plan

Status: active

## Objective

Reach comparable capability for the core personal-workspace outcomes of Notion without copying its branding, wording, assets, or exact interaction patterns. Motion remains local-first, usable without an account or network, structurally exportable, and backed by the canonical typed application-service boundary.

This plan turns `FEATURE_PARITY.md`, `BACKLOG_0.1.1.md`, and the current implementation into vertical delivery slices. A slice is complete only when its domain behaviour, native application-service route, browser compatibility path, persistence/restart behaviour, export/restore behaviour, accessibility path, and automated evidence agree.

## Verified starting point

The repository already provides:

- canonical schema-v2 pages, blocks, records-as-pages, typed collection properties, saved view data, stable links, search, attachments, backup, and export models;
- SQLite application-service persistence and an allowlisted Tauri IPC boundary;
- a zero-network Web-v1 compatibility UI with nested page organisation, typed table editing, filters, multi-sort, links/backlinks, search, trash/restore, and backup/export controls;
- Linux x86-64 and ARM64 package pipelines and focused security/reliability gates.

The principal product gaps are the compatibility editor, complete linked-knowledge UX, collection views beyond table, relations/rollups, import, and installed-package interaction evidence.

## Delivery rules

1. Use test-driven vertical slices: write and observe a focused failing test, implement the minimum canonical behaviour, make it pass, then run the relevant regression suite.
2. Never make browser-only state authoritative. UI mutations must route through typed application-service commands in native mode and the equivalent validated compatibility mutation in browser-development mode.
3. Preserve stable IDs, unknown blocks, local-only operation, deterministic ordering, and lossless structured export.
4. Every schema change requires migration and round-trip tests. Derived indexes remain rebuildable.
5. Every pointer interaction has a keyboard alternative. Destructive operations are explicit and recoverable where specified.
6. Do not claim a capability complete from source inspection alone; require exercised tests and, for release status, packaged-app evidence.

## Phase 0 — reproducible engineering baseline

- Provide or restore a Node 22+ toolchain and dependency cache that can run without runtime network access.
- Run `npm test`, `npm run typecheck`, `npm run build`, `npm run test:offline`, and focused Playwright tests.
- Record environment-caused failures separately from product regressions.
- Keep the zero-dependency Web tests/build available as the minimum local gate.

Exit gate: a clean checkout can execute the documented verification commands with pinned inputs.

## Phase 1 — trustworthy daily-writing editor

Deliver in vertical slices over the canonical `page.replace-blocks`/fine-grained command boundary:

1. Mount a flagged React/Tiptap paragraph-editor canary for ordinary pages beside
   the existing read path without creating a second source of truth.
2. Prove one complete path: canonical paragraph block → Motion-owned
   ProseMirror node → React/Tiptap edit → typed `page.replace-blocks` commit →
   SQLite restart/reload → canonical export, preserving the same block ID and
   requiring no network access.
3. Keep the canary disabled by default until every currently editable block
   type has a lossless codec. Do not combine this slice with Yjs storage,
   collaboration, or a full React-shell rewrite.
4. Headings, lists, tasks, toggles, quotes, callouts, divider, and code round-trip through native restart and structured export/restore.
5. Block selection, transform, duplicate, move, indent/outdent, delete, undo/redo, and cross-page move have keyboard coverage.
6. Clipboard/Markdown paste, multiline paste, IME composition, unknown-node preservation, and 10,000-word editing receive browser tests.
7. Remove the compatibility editor only after equivalent behaviour and migration evidence pass.

Exit gate: every scoped block type preserves ID/type/content through edit, restart, export, and restore; no second authoritative editing path remains.

## Phase 2 — linked knowledge and search

1. Resolve `[[` and `@` entry to stable page IDs through an accessible chooser.
2. Render live, trashed, and missing targets distinctly while retaining references.
3. Add outgoing-link and backlink entries with source snippets and block-level navigation.
4. Add search snippets, safe highlighting, deterministic keyboard navigation, recent-search controls, and page/record/attachment filters.
5. Prove transactional index updates after edit, rename, move, trash, restore, and target loss.
6. Make ordinary search tombstone-consistent across core, SQLite, and the app
   service: trashed pages, blocks, and database-row projections disappear
   immediately, remain absent after restart, and return exactly once with the
   same stable IDs after restore. This gate requires no persisted-schema
   migration because the FTS projection is already rebuilt transactionally.

Exit gate: links survive rename/move, target lifecycle is honest, block deep links focus the source block, and the documented moderate-workspace search target has measured evidence.

## Phase 3 — collection view foundation

1. Add canonical create/update/reorder/delete view commands; do not overload
   table-only mutation semantics, and remove the domain bug that rewrites every
   updated view to `table`.
2. Add a saved-view switcher and preserve filters, sorts, visible properties, grouping, and layout per view.
3. Deliver views in this order using the shared record query path:
   - list: compact records-as-pages with selected properties, deliberately
     first because it reuses the existing record-page/filter/stable-multi-sort
     path while proving the complete saved-view lifecycle;
   - board: select/status grouping, ungrouped lane, keyboard and pointer card moves;
   - calendar: configured date property, range handling, undated section, keyboard date changes;
   - gallery: configurable preview and visible properties;
   - timeline: configured start/end fields and deterministic range placement;
   - chart: configured dimensions/measures, deterministic aggregation and an
     accessible data-table alternative;
   - feed: configured date/order, grouping, preview and visible properties over
     shared records, with no collaboration or remote-activity dependency;
   - map: explicit location coordinates, deterministic marker clustering, an
     equivalent list/table path, and no silent remote tiles or geocoding.
4. Keep table behaviour and the 5,000-record bounded-rendering evidence intact.

Exit gate: all nine mandatory views are saved canonical configuration, survive
restart/export/restore, use deterministic filtered/sorted records, and have
keyboard-accessible record movement/editing. Chart exposes its source data
accessibly, feed remains local record presentation, and map remains useful with
networking disabled.

## Phase 4 — advanced databases

1. Populated property type-change preflight with explicit conversion, rejection, or clearing choices, including bounded coordinate validation for location values.
2. Relations with reciprocal constraints and stable record targets.
3. Rollups with cycle detection and deterministic aggregation.
4. Formula-result projection/filter/sort using the versioned parser/evaluator; never JavaScript `eval`.
5. Reusable page/database templates with explicit origin metadata and portable export.

Exit gate: relations, rollups, and formulas survive restart and complete export/restore without hidden remote dependencies.

## Phase 5 — interchange and release confidence

1. Staged Markdown-folder import with hierarchy and local-link resolution.
2. Staged CSV collection import with property inference requiring user confirmation.
3. Compatibility report, idempotency key, limits, and all-or-nothing canonical mutation.
4. Attachment/static HTML export completion and hostile-input fixtures.
5. Installed x86-64 and ARM64 package drills: create, edit, link, search, attach, terminate/restart, export, and restore with networking denied.

Exit gate: full workspace interchange reconstructs supported canonical content, unsupported content is explicit and lossless where possible, and installed packages pass the offline workflow.

## Phase 6 — post-baseline workspace capabilities

After Phases 1–5:

- local comments and history;
- project/task dependency and workload outcomes;
- optional self-hosted sync, collaboration, and permissions;
- explicitly approved automation, standalone dashboards/forms, API/MCP, and AI adapters.

Mobile, enterprise administration, Calendar, Mail, and cloud-only connectors remain separate scope decisions.

## Immediate pull order

1. Establish the reproducible Node 22/dependency baseline.
2. Implement one saved collection view vertical slice beyond table, starting with list or board based on code-level dependency analysis.
3. In parallel, prepare the editor migration tracer bullet and linked-target lifecycle slice.
4. Integrate only after focused tests pass; then run Web build/offline scan and the complete suite where the restored toolchain permits.
