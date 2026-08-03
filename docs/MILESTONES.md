# Motion Delivery Milestones

Each milestone is complete only when its acceptance criteria pass in a packaged Linux desktop build with networking disabled, unless explicitly marked as a later server milestone. Requirement IDs refer to [REQUIREMENTS.md](REQUIREMENTS.md).

## M0 — Durable local foundation

- A workspace can be created, reopened after process termination, migrated, backed up, and restored with stable IDs (`LOCAL-001`–`LOCAL-004`).
- Page and block repositories enforce hierarchy invariants and atomic mutation/operation-log writes (`PAGE-001`, `PAGE-004`, `BLOCK-001`).
- Unknown block fixtures survive load/save/export byte-equivalently at the payload level (`BLOCK-007`).
- The materialized link index can be discarded, rebuilt, and verified against canonical blocks (`LINK-004`, `LINK-006`).
- Automated tests cover power-loss/restart boundaries, migrations, and export/restore equivalence.

## M1 — Trustworthy documents and navigation

- Users can create, rename, nest, reorder, move, archive, restore, favourite, and delete pages (`PAGE-002`, `PAGE-003`).
- The editor supports all initial block types, deterministic serialization, stable anchors, and honest unsupported placeholders (`BLOCK-002`, `BLOCK-006`, `BLOCK-007`).
- Single/multi-block selection, reorder, nesting, cross-page move, duplicate, delete, transform, copy/paste, Markdown copy, undo, and redo work by keyboard (`BLOCK-004`, `BLOCK-005`).
- Page and block drag operations work and every action has an equivalent keyboard path (`A11Y-004`, `A11Y-005`).
- Shortcut reference and automated keyboard/focus tests cover all initial commands (`A11Y-001`–`A11Y-003`, `A11Y-006`).

## M2 — Linked knowledge and attachments

- `@` mentions and `[[...]]` entry create stable-ID links; rename/move changes presentation without breaking targets (`LINK-001`–`LINK-003`).
- Backlinks and incoming/outgoing searches use the materialized index and do not scan all page documents (`LINK-004`, `LINK-006`).
- Archived targets, broken targets, previews, block deep links, and copyable internal URLs have tested states (`LINK-005`).
- File drop and keyboard file selection ingest durable attachments, expose failures honestly, and restore from a full export (`BLOCK-009`, `LOCAL-003`).

## M3 — Collection table and list

- Records are pages with normal block content and all initial property types validate, persist, reorder, and export (`COLL-001`–`COLL-003`).
- Table and list views share record data while independently saving visible properties, property order, widths, filters, and sorts (`VIEW-001`–`VIEW-003`).
- Nested typed filter ASTs and multi-clause deterministic sorts pass unit and integration tests (`FILTER-001`, `FILTER-002`, `SORT-001`).
- Property/column drag actions and keyboard alternatives produce identical persisted commands (`VIEW-004`, `A11Y-005`).

## M4 — Visual database workflows

- Board, calendar, gallery, and timeline views render and persist their applicable configuration (`VIEW-002`, `VIEW-003`).
- Board cards reorder and move between groups through validated property mutations; equivalent keyboard controls are complete (`VIEW-004`).
- Empty, null, deleted, filtered, and large-dataset behavior is deterministic and tested.
- Chart and form contracts are documented and schema-compatible; their UI implementation may remain for M5.

## M5 — Relations and advanced views

- One-way and reciprocal relations enforce configured cardinality/limits and handle deleted targets explicitly (`REL-001`–`REL-004`).
- Relation filters work in the typed filter AST; relation data survives CSV companion metadata and full JSON export (`FILTER-002`, `LOCAL-003`).
- Rollups have explicit aggregation and missing-target semantics with deterministic results (`REL-005`).
- Chart and form views are implemented as saved configurations over the same records (`VIEW-001`, `VIEW-002`).

## M6 — Optional private multi-device sync

- Two offline replicas reconcile page trees, block edits/order, links, relations, and reciprocal updates deterministically without requiring wall-clock agreement.
- Unknown blocks and fields pass through replicas unchanged (`BLOCK-007`).
- Conflicts are explicit and recoverable; convergence, reconnect, duplicate-delivery, and interrupted-transfer tests pass.
- The local application remains fully useful when the sync server is absent.

## M7 — Optional collaborative self-hosting

- The published self-hosted server and documented protocol support workspace membership, permissions, comments, history, and presence without changing local storage authority.
- Client-side encrypted workspaces do not require server plaintext access.
- Presence is ephemeral; content/history durability and authorization are tested separately.
- A fresh self-hosted deployment, backup, and restore are documented and verified.
