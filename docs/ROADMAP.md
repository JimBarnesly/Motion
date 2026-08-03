# Roadmap

## Stage 1 — local foundation

- Versioned page, block, database, view, relation, and attachment models
- Authoritative local persistence with migrations
- Nested pages, block editing, links, backlinks, and full-text search
- Table database view
- JSON, Markdown, CSV, attachment, and full-workspace export
- Automated round-trip and restore tests

## Stage 2 — desktop-grade storage

- Package the web client with a native shell
- Replace browser storage with SQLite plus content-addressed attachment files
- Crash-safe transactions, snapshots, incremental backups, and restore drills
- Additional database views: board, list, calendar, gallery, and timeline
- Importers with explicit compatibility reports

## Stage 3 — private multi-device

- Publish and implement the documented operation-log sync protocol
- User-operated reference sync server
- End-to-end encrypted workspace mode with client-held recovery material
- Device enrolment, key rotation, compaction, and conflict inspection

## Stage 4 — collaborative self-hosting

- Workspace membership and role-based permissions
- Comments, presence, history, and auditable sharing
- Conflict-safe real-time editing
- The same documented server and protocol for hosted and self-hosted deployments

## Stage 5 — optional private automation

- Explicit per-action AI consent and visible provider routing
- Local model support and user-supplied remote providers
- Agent permission scopes, dry runs, audit history, and revocation
- No document content leaves the device without an explicit action

Each stage must leave local-only operation complete and usable. Remote features
are additive and cannot become prerequisites for editing or export.
