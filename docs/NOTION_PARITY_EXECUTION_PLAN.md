# Motion V1.0 core-workspace execution plan

Status: active
Scope authority: `V1_SCOPE.md`

## Objective

Ship the Jake-approved V1.0 outcome: a dependable offline single-user Linux
workspace with substantial Markdown-focused pages, stable page/database/record
linking, and complete typed table databases. Comparable behavior matters where
needed for those workflows, but broad Notion parity is not a V1.0 requirement.

This plan turns `FEATURE_PARITY.md`, the current implementation, and exercised
evidence into vertical delivery slices. A slice is complete only when its domain
behavior, native application-service route, browser compatibility path where
retained, persistence/restart behavior, export/restore behavior, accessibility
path, and automated evidence agree.

## Verified starting point

The repository already provides partial canonical schema-v2 pages, blocks,
records-as-pages, typed collection properties, table data, stable links, search,
attachments, backup, and export models; SQLite application-service persistence;
an allowlisted Tauri IPC boundary; and a zero-network Web-v1 compatibility UI.
These are implementation foundations, not V1 acceptance.

The principal included product gaps are remaining data-integrity proof, complete
stable linked-knowledge workflows, a dependable substantial-text editor, complete
table datatype behavior, interchange/recovery, and installed Linux package
acceptance. Non-table views and integrations are deferred.

## Delivery rules

1. Use test-driven vertical slices: write and observe a focused failing test,
   implement the minimum canonical behavior, make it pass, then run the relevant
   regression suite.
2. Never make browser-only state authoritative. UI mutations route through typed
   application-service commands in native mode and an equivalent validated
   compatibility mutation only where the development path remains supported.
3. Preserve stable IDs, unknown content, local-only operation, deterministic
   ordering, and lossless structured export.
4. Every persisted schema change requires migration and round-trip tests. Derived
   indexes remain rebuildable.
5. Every pointer interaction has a keyboard alternative. Destructive operations
   are explicit and recoverable where specified.
6. Do not claim a capability complete from source inspection alone; require
   exercised tests and, for release status, installed packaged-app evidence.
7. Keep excluded integrations and non-table views out of the critical path.

## Phase 0 — integrity and reproducible baseline

1. Close stale-response and authority-transition races across import, restore,
   selection, and other workspace-changing operations.
2. Prove bounded resource handling, atomic rollback, lossless unknown-data
   behavior, migration/restart integrity, and fail-fast single-writer ownership.
3. Provide or restore a Node 22+ toolchain and dependency cache that can run
   without runtime network access.
4. Run the complete relevant test, typecheck, build, offline, security, and focused
   browser gates; distinguish environment prerequisites from product regressions.

Exit gate: the canonical state cannot be silently corrupted by known transition,
restore, crash, resource-bound, or duplicate-writer paths, and a clean checkout
can execute the documented verification commands with pinned inputs.

## Phase 1 — stable linked knowledge

1. Resolve `[[` and `@` entry to stable page, database, or record IDs through an
   accessible chooser.
2. Complete page-to-page, page-to-database, database-to-page, and record-link
   creation and navigation through canonical commands.
3. Add relation-style table linking with stable targets and validated reciprocal
   or canonical membership/index invariants where the datatype requires them.
4. Render live, trashed, and missing targets distinctly while retaining references.
5. Provide outgoing links, backlinks, useful source context, and keyboard-capable
   navigation.
6. Prove links survive rename, move, trash/restore, restart, structured export,
   and backup restore; keep indexes transactional and rebuildable.

Exit gate: all included link directions use stable identities and retain honest,
usable navigation through every included lifecycle and portability operation.

## Phase 2 — dependable Markdown-focused editor

Deliver vertical slices over canonical page/block mutation boundaries:

1. Prove paragraph and common Markdown structure editing end to end: canonical
   content → production editor → typed mutation → SQLite restart/reload → export
   and restore, preserving stable content identities.
2. Complete headings, bulleted and numbered lists, tasks, quotes, dividers, code,
   and links without making rendered HTML authoritative.
3. Provide dependable keyboard editing, selection needed for ordinary substantial
   writing, multiline clipboard/paste, undo/redo, and usable mentions.
4. Preserve unknown structured content honestly and prove IME, large-document,
   restart, and export/restore behavior.
5. Use React/Tiptap/ProseMirror if repository direction requires it; do not make
   framework migration itself the acceptance outcome.
6. Remove any competing authoritative compatibility editing path only after the
   production path has equivalent included behavior and migration evidence.

Exit gate: substantial Markdown-focused pages remain stable through ordinary
editing, keyboard and clipboard workflows, restart, and export/restore, with one
canonical structured source of truth.

## Phase 3 — complete typed table databases

1. Keep records as normal pages with stable identities and editor content.
2. Complete validation, editing, persistence, applicable filtering, and sorting for
   title, text, number, checkbox, select, multi-select, status, date, URL, email,
   phone, files, location, relation, rollup, and formula properties.
3. Complete property create, rename, reorder, width, visibility, populated type
   conversion preflight, and deletion consequences.
4. Complete nested filters and deterministic multi-sort; make empty, null, invalid,
   filtered, deleted, and large-dataset behavior deterministic.
5. Integrate formulas and rollups through versioned deterministic evaluators with
   cycle handling; never use JavaScript `eval`.
6. Prove every included datatype and table configuration through restart and full
   structured export/restore.

Exit gate: the table view and complete intended datatype model are usable through
the canonical boundary, deterministic, restart-safe, portable, and keyboard
accessible. No non-table database view is required.

## Phase 4 — interchange, recovery, and installed acceptance

1. Complete structured JSON restore, Markdown-focused page interchange, CSV table
   interchange, and attachment-complete verified backup for included content.
2. Use bounded staged preflight, compatibility reporting, deterministic conflicts,
   cancellation where applicable, and all-or-nothing canonical mutation.
3. Prove schema-directed stable-ID reconstruction without rewriting opaque values
   or external principals based only on key names.
4. Exercise hostile input, crash boundaries, disk full, corrupt indexes,
   duplicate writers, and recovery without false success or silent loss.
5. Build exact-commit x86-64 and ARM64 AppImage and Debian artifacts and run the
   complete included workflow with networking denied.
6. Complete accessibility, security, provenance, checksums, signatures,
   attestations, and explicit release approvals on the exact candidate bytes.

Exit gate: another offline Linux machine can install Motion and reconstruct the
included workspace without data loss; all immutable acceptance rules in
`V1_SCOPE.md` pass on one frozen commit.

## Deferred work (not V1.0 blockers)

- List, board, calendar, gallery, timeline, chart, feed, map, form, dashboard, and
  canvas database views or products.
- Third-party integrations, AI, MCP, connectors, automations, webhooks, public APIs,
  sync, collaboration, accounts, sharing, and hosted services.
- Broad editor or workspace parity beyond the included dependable outcomes.

## Immediate pull order

1. Finish Phase 0 integrity blockers and reproducible Node 22+ verification.
2. Deliver the smallest stable page/database/record linking increment.
3. Advance the production editor one end-to-end Markdown behavior at a time.
4. Complete missing table datatypes and their filter/sort/persistence semantics.
5. Close interchange, package, offline, accessibility, and release evidence.
