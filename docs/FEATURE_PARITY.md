# Motion V1 feature-parity register

Owner: Product Director
Decision authority: Managing Director
Last reviewed: 2026-08-11
Provisional evidence baseline: `5441e1c` (`feat/v1-phase-0-green-baseline`)

## Purpose and evidence rule

This register compares current Motion implementation with the outcomes frozen in
`V1_SCOPE.md`. It records exercised repository evidence, not design intent.
Requirements, ADRs, roadmap entries, schemas without a usable path, and work on
other branches are not implementation evidence.

Statuses:

- **Implemented** — working code and focused repository evidence exist at the
  provisional baseline. Release acceptance may still be open.
- **Partial** — a usable tested slice exists, but one or more V1 outcomes are
  absent or lack required canonical/package evidence.
- **Missing** — no usable tested implementation of the V1 outcome exists at this
  baseline. A specification alone remains missing.
- **Deferred** — explicitly excluded from V1 by `V1_SCOPE.md`.

No row is V1-accepted: there is no complete immutable CI run or installed
package acceptance for this baseline.

## V1 current register

| Capability area | Status | Implemented evidence at `5441e1c` | Missing V1 evidence/outcome |
| --- | --- | --- | --- |
| Pages and navigation | Partial | Canonical create/move/reorder/favourite/trash/restore paths, nested Web navigation, restart-focused tests | Permanent deletion, robust pointer drag/drop plus equivalent keyboard commands, complete restart state, and installed-package acceptance |
| Daily-writing editor | Partial | Web compatibility editor handles several block types and recoverable saves; canonical service now defines bounded typed create/update/transform/move/indent/outdent/duplicate/delete/batch commands | Authoritative React + Tiptap/ProseMirror path; UI adoption of fine-grained commands; selection/clipboard/IME/undo/redo; 10,000-word and packaged evidence |
| Links, mentions, backlinks, deep links | Partial | Stable page-ID links, outgoing links/backlinks, live/trashed/missing states, backlink source-block focus, and focused Web tests | Accessible `[[`/`@` chooser, previews, general block deep-link UX, lifecycle through export/backup restore, restart and packaged evidence |
| Search | Partial | Accessible canonical search covers titles, blocks, record values and attachment filenames with safe DOM rendering, deterministic ordering, recovery states and stable result focus | Highlighting, filters, complete native/package execution and deterministic packaged performance evidence |
| Files and media | Partial | Content-addressed attachment primitives and canonical service/backup paths | Streaming/limits, image/media/PDF block UX, interruption handling, filename search, complete backup/restore and installed-package evidence |
| Typed database properties and records-as-pages | Partial | Canonical records-as-pages with bidirectional collection membership, scoped property validation, typed editors, and schema/order/width paths | Complete V1 property set, populated type-conversion preview, deletion consequences, large/edge-state evidence, packaged acceptance |
| Saved filters, sorts, groups, and view lifecycle | Partial | Saved filter and deterministic multi-sort slices exist in table-oriented UI | Complete nested filter/group behavior and canonical create/update/reorder/delete lifecycle for all views |
| Table view | Partial | Usable typed table slice with focused canonical/restart tests | Complete V1 configuration/edge-state behavior and installed-package acceptance |
| List view | Missing | No usable tested list-view implementation at this baseline | Full saved list configuration, keyboard path, restart/export/restore and package evidence |
| Board view | Missing | No usable tested board-view implementation at this baseline | Status/select grouping, card movement, saved configuration and complete evidence |
| Calendar view | Missing | No usable tested calendar-view implementation at this baseline | Date configuration, ranges/undated behavior, keyboard edits and complete evidence |
| Gallery view | Missing | No usable tested gallery-view implementation at this baseline | Preview/property configuration and complete evidence |
| Timeline view | Missing | No usable tested timeline-view implementation at this baseline | Start/end configuration, deterministic range placement and complete evidence |
| Relations and rollups | Missing | Requirements/schema design only | Usable reciprocal relations, deterministic rollups/cycle handling, restart/export/restore and package evidence |
| Formulas | Partial | Versioned parser/evaluator package with focused tests | Canonical property projection/filter/sort integration, database UX and complete persistence/export/package evidence |
| Templates | Missing | Template-origin field only | Creation, application, editing, portability and tested user workflow |
| Structured export, backup, and restore | Partial | JSON/Markdown/CSV primitives; bounded deterministic restore namespacing; long-ID, collision, reference, row-key, and attachment-focused tests | Complete offline user flows, full V1 reconstruction, interruption drills, and installed-package evidence |
| Markdown and CSV import | Missing | Requirements/design only | Bounded staged preflight, compatibility report, cancellation, deterministic conflicts and transactional rollback |
| Offline Linux desktop | Partial | Tauri shell, canonical SQLite service, bundled-runtime/package pipeline, and historical extracted-service smoke | Exact-baseline x86-64/ARM64 AppImage/Debian installed-window acceptance with networking disabled |
| Accessibility | Partial | Labeled controls, keyboard-focused source tests, accessible search states, and normal/200%-equivalent E2E specifications exist | WCAG 2.2 AA execution and recorded keyboard, 200% zoom and Orca installed-package acceptance are missing |
| Release provenance and security | Partial | Release/security gate implementations, repaired workflow contracts, source scanner and fail-closed governance tests | Full integrated security review, Node 22+ complete chain, Rust/Tauri, `gitleaks`, advisory DB, immutable CI, checksums/signatures/attestations and approvals |
| Performance and failure recovery | Partial | Smoke benchmarks, transaction/recovery tests, and failed-edit retry/discard slice | Reviewed representative source/package budgets plus crash-boundary, disk-full, corrupt-index and duplicate-writer evidence on candidate artifacts |

## Explicitly deferred beyond V1

The following are **Deferred**, not missing V1 work: sync, collaboration,
accounts, sharing, comments, presence, permissions, public publishing, AI, MCP,
connectors, automations, webhooks, public API, Windows, macOS, mobile, hosted
service, chart/form/dashboard/canvas products, separate mail/calendar products,
and application-level encrypted vaults.

## Phase 0 interpretation

Phase 0 repairs reproducibility and evidence collection; it does not complete a
product capability merely because a CI contract now names its gate. At this
baseline, the six missing workflow scripts are declared, the workflow contract
is self-gated, complete E2E spec selection is guarded, and the static-analysis
base passes focused local checks. Actual complete E2E, supported-toolchain CI,
security acceptance, and package acceptance remain open.

Accessible search is separately owned work and must not change the Search or
Accessibility evidence here until its commit is integrated and reverified.

## Monitoring cadence

- Update a status only from implementation plus exercised evidence on the named
  baseline.
- Re-run coordinate-sensitive security and complete-E2E selection gates after
  integrating parallel branches.
- Keep competitor monitoring separate from V1 acceptance; comparable Notion
  breadth beyond `V1_SCOPE.md` does not silently expand this release.
- Route any V1 scope change through the explicit Jake-approved process in
  `V1_SCOPE.md`.
