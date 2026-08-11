# Motion V1.0 feature register

Owner: Product Director
Decision authority: Managing Director
Last reviewed: 2026-08-11
Provisional evidence baseline: `f4d07f3` (`feat/v1-phase-0-green-baseline`); this
commit is not a release candidate and all evidence must be revalidated after the
documentation change.

## Purpose and evidence rule

This register compares current Motion implementation with the Jake-approved
outcomes frozen in `V1_SCOPE.md`. It records exercised repository evidence, not
design intent. Requirements, schemas without a usable path, source inspection,
and work on other branches are not implementation evidence.

Statuses:

- **Implemented** — working code and focused repository evidence exist. Release
  acceptance may still be open.
- **Partial** — a usable tested slice exists, but one or more included outcomes are
  absent or lack required canonical/package evidence.
- **Missing** — no usable tested implementation of the included outcome exists.
- **Deferred** — explicitly excluded from V1.0 by `V1_SCOPE.md`.

No row is V1-accepted: there is not yet one frozen commit with complete relevant
CI, exact installed x86-64 and ARM64 offline acceptance, all approvals, and a
valid `v1.0.0` tag.

## V1.0 current register

| Capability area | Status | Exercised implementation evidence | Missing V1.0 evidence/outcome |
| --- | --- | --- | --- |
| Pages and navigation | Partial | Canonical create/move/reorder/favourite/trash/restore paths, nested Web navigation, restart-focused tests | Permanent deletion, complete equivalent pointer/keyboard paths, complete restart state, and installed-package acceptance |
| Markdown-focused editor | Partial | Compatibility editor supports several block types and recoverable saves; typed fine-grained native editing and incremental SQLite persistence are integrated | Dependable production editor for common Markdown structures, substantial keyboard/clipboard editing, undo/redo, large-text/IME evidence, restart/export/restore integrity, and packaged acceptance |
| Page/database/record links and relations | Partial | Stable page-ID links, outgoing links/backlinks, live/trashed/missing states, source-block focus, and focused Web tests | Complete page-to-database/database-to-page/record linking, usable mention chooser/navigation, relation datatype workflow and invariants, lifecycle through restart/export/backup restore, and packaged evidence |
| Search | Partial | Accessible canonical search covers titles, blocks, record values, and attachment filenames with safe DOM rendering and deterministic ordering | Complete keyboard navigation plus native/package execution and deterministic packaged performance evidence for included workflows |
| Files and media needed by included pages/tables | Partial | Content-addressed attachment primitives and canonical service/backup paths | Limits/interruption handling, included editor/table UX, complete backup/restore, and installed-package evidence |
| Typed database properties and records-as-pages | Partial | Canonical records-as-pages, bidirectional collection membership checks, scoped validation, typed editors, and schema/order/width paths | Complete intended datatype set, populated conversion preview, deletion consequences, applicable filter/sort semantics, edge/large-state evidence, and packaged acceptance |
| Table filters, sorts, and configuration | Partial | Saved filtering and deterministic multi-sort slices exist in the table-oriented UI | Complete nested filters, applicable datatype semantics, property visibility/width lifecycle, empty/null/deleted behavior, restart/export/restore, and installed-package acceptance |
| Table view | Partial | Usable typed table slice with focused canonical and restart tests | Complete included datatype/configuration behavior, accessibility, scale evidence, and installed-package acceptance |
| Formulas and rollups | Partial | Versioned formula parser/evaluator has focused tests; schema foundations exist | Canonical property projection/filter/sort, deterministic rollups and cycle handling, database UX, restart/export/restore, and package evidence |
| Structured export, backup, and restore | Partial | JSON/Markdown/CSV primitives; bounded deterministic schema-directed restore; attachment and membership verification; opaque-data preservation tests | Complete offline user flows, full included reconstruction, rollback/interruption drills, and installed-package evidence |
| Markdown-focused and CSV import | Missing | Requirements and design foundations only | Bounded staged preflight, compatibility report, deterministic conflicts, cancellation where applicable, transactional rollback, and included-content reconstruction |
| Offline Linux desktop | Partial | Tauri shell, canonical SQLite service, bundled-runtime/package pipeline, and historical extracted-service smoke | Exact-candidate x86-64/ARM64 AppImage/Debian installed-window acceptance with networking disabled |
| Accessibility | Partial | Labeled controls, keyboard-focused source tests, accessible search states, and browser specifications exist | Exercised automation plus recorded keyboard, 200% zoom, and Linux screen-reader installed-package acceptance for included workflows |
| Release provenance and security | Partial | Release/security gate implementations, workflow contracts, source scanner, and fail-closed governance tests | Full exact-candidate security review, complete Node 22+/Rust/Tauri chain, immutable CI, checksums/signatures/attestations, and explicit approvals |
| Performance and failure recovery | Partial | Smoke benchmarks, transaction/recovery tests, stale-transition regression coverage, and failed-edit retry/discard slices | Reviewed source/package budgets plus complete crash, disk-full, corrupt-index, bounded-resource, rollback, duplicate-writer, and installed recovery evidence |

## Explicitly deferred beyond V1.0

The following are **Deferred**, not missing V1.0 work:

- database list, board, calendar, gallery, timeline, chart, feed, map, form,
  dashboard, and canvas views or products;
- sync, collaboration, accounts, sharing, comments, presence, permissions, and
  public publishing;
- third-party integrations, AI, MCP, connectors, automations, webhooks, and public
  APIs;
- Windows, macOS, mobile, hosted service, browser-as-product distribution,
  separate mail/calendar products, and application-level encrypted vaults;
- broad Notion parity not needed for dependable included page, linking, and table
  workflows.

These deferrals do not reduce data-integrity, offline, backup/recovery, migration,
security, accessibility, provenance, or Linux package acceptance requirements.

## Current critical path

1. Close remaining integrity evidence: stale authority/import paths, bounded
   resources, atomic rollback, Node 22+ runtime behavior, and fail-fast
   single-writer ownership.
2. Complete stable page/database/record links and relation-style table linking.
3. Deliver the dependable Markdown-focused production editor.
4. Complete all intended table datatypes and applicable filter/sort semantics.
5. Complete interchange, installed offline package, accessibility, recovery,
   security, and provenance acceptance on one frozen commit.

## Monitoring cadence

- Update a status only from implementation plus exercised evidence on the named
  commit.
- Re-run coordinate-sensitive security and complete test-selection gates after
  integrating changes.
- Keep competitor monitoring separate from V1.0 acceptance; comparable Notion
  breadth beyond `V1_SCOPE.md` does not silently expand this release.
- Route every V1.0 scope change through Jake's explicit approval process in
  `V1_SCOPE.md`.
