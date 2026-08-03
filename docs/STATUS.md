# Status

Updated: 2026-08-04

## Working foundation

- Monorepo, development scripts, product/architecture/data/sync/security documentation, and initial ADRs exist.
- `packages/core`: versioned workspace/page/block/collection/view/attachment models, hierarchy cycle prevention, links/backlinks, ranked in-memory search, persistence abstraction, and JSON/Markdown/CSV export primitives.
- `apps/web`: runnable offline-oriented vertical slice with nested navigation, editable blocks/tables, keyboard quick search, wiki links/backlinks, versioned browser persistence, and responsive light/dark UI.
- Storage, search, formula, backup, and observability packages have initial implementations and focused tests.
- `packages/app-service` now proves a canonical command/query path through
  validation, domain mutations, SQLite revision commits, FTS, restart, search,
  backlinks, trash/restore, attachments, verified backup/restore into a new
  workspace, export, and explicit Web-v1 migration.
- Foundational spike verdicts are now recorded in ADRs 0006-0012:
  editor/Yjs behavior and SQLite/FTS5 primitives are validated; stable block IDs,
  versioned logical documents with Yjs persistence, and rebuildable local search
  are accepted. Tauri packaging, the final production database adapter, and
  crash-safe attachment staging retain explicit validation gates.

## Not yet a release

- **Critical UI integration gap:** `apps/web` still persists its own schema-v1
  localStorage model and does not call the core, SQLite storage, search, formula,
  app-service, or verified-backup packages. The service-level vertical slice is
  integrated and restart-tested, but the runnable UI is not yet connected to it.
- No packaged Tauri desktop application or completed rich ProseMirror/Tiptap editor.
- The web slice is not yet proven to use SQLite as its authoritative store; desktop restart/crash durability is not release-validated.
- Required block behaviours, collection views, relations/rollups, attachments UI, full import/export UX, and complete restore workflow remain partial.
- Sync server, multi-user collaboration, permissions, encryption, AI, and MCP are designed/deferred, not shipped.
- Full E2E, accessibility, security, failure-injection, migration, and representative performance evidence is incomplete.

## Next vertical slice

Create one application-service boundary and wire the UI through the canonical
schema and authoritative SQLite/content-addressed store. Remove or migrate the
parallel browser model. Then package it for Linux desktop and prove:
create/edit/link/search/attach, terminate/restart, export, restore into a new
workspace, and run with networking blocked.

See `RISKS.md`, `ROADMAP.md`, and `TEST_STRATEGY.md` for gates and dependencies.

## Evidence baseline

- Editor spike: `spikes/002-editor-yjs`, 4/4 tests pass for block types/IDs,
  versioned offline reload, undo/redo, and unknown-node preservation.
- SQLite/FTS spike: `spikes/003-sqlite-fts`, 3/3 tests pass for migrations,
  document updates, FTS5, attachment hashing, rollback, restart, and WAL recovery.
- Tauri spike: `spikes/001-tauri-linux`, 2/2 boundary tests and the offline web
  build pass; native compilation/launch/package is unverified because this host
  lacks Rust and Linux WebView development dependencies.
