# Motion Product Definition

Motion is an original, open, local-first workspace for documents, nested pages, linked knowledge, tasks, attachments, and lightweight relational databases. It borrows general interaction concepts common to modern workspace tools, but uses its own identity, implementation, language, and visual design.

## Required operating modes

1. **Local-only (baseline):** one device, no account, server, internet, or degraded features.
2. **Private multi-device:** an optional user-operated sync server and offline reconciliation.
3. **Collaborative self-hosted:** optional users, permissions, comments, presence, and history using the same documented server and protocol as any future hosted service.

The first shippable vertical slice is local-only: create a workspace; create, nest, edit, move, and link pages; edit block content; create a table database and rows; search; attach files; show backlinks; and export/restore the workspace.

## Product requirements

- The local database is authoritative and complete, not a remote cache.
- Page editing and search work with networking disabled.
- A workspace may contain pages, ordered blocks, databases, rows, typed properties, views, relations, tasks, comments, and attachments.
- Internal links are stable across page moves and title changes.
- All remote services, telemetry, external resource fetching, AI, and collaboration are opt-in.
- AI actions require explicit selection of content and provider; provider configuration is user-owned.
- Controls remain calm, keyboard-friendly, accessible, and responsive without copying another product's layout or wording.

## Ownership and portability

Motion provides versioned exports:

- Markdown per page, with front matter and relative attachment links.
- Structured JSON preserving identifiers, hierarchy, blocks, views, relations, metadata, and requested comments.
- CSV per database view/table, plus a property manifest for types that CSV cannot preserve.
- Attachments with original filenames plus a checksum manifest.
- A full workspace bundle containing all of the above, `manifest.json`, schema versions, checksums, and migration provenance.

Import and restore must be testable in a new empty workspace. Export formats and migration rules are documentation, not implementation details.

## Explicit non-goals for the first slice

Real-time collaboration, hosted accounts, mobile-native clients, plugin execution, public publishing, and embedded AI are later capabilities. Their future addition must not weaken local-only operation or portability.

## Acceptance criteria

- The vertical slice can be run and exercised entirely offline.
- Restarting preserves all local content and attachments.
- Search returns local page, block, and database-row content.
- Export followed by restore into an empty workspace reconstructs the required structure.
- Automated tests cover persistence, schema migration, export/restore, and offline operation.
