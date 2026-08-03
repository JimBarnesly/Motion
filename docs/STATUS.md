# Status

Updated: 2026-08-04

## Working foundation

- Monorepo, development scripts, product/architecture/data/sync/security documentation, and initial ADRs exist.
- `packages/core`: versioned workspace/page/block/collection/view/attachment models, hierarchy cycle prevention, links/backlinks, ranked in-memory search, persistence abstraction, and JSON/Markdown/CSV export primitives.
- `apps/web`: runnable offline-oriented vertical slice with nested navigation,
  editable blocks/tables, keyboard quick search, wiki links/backlinks, and
  responsive light/dark UI. It uses IndexedDB in browser development and an
  allowlisted Tauri IPC adapter when hosted by the desktop shell; schema-v1
  imports are validated and migrated into the canonical service.
- Storage, search, formula, backup, and observability packages have initial implementations and focused tests.
- `packages/app-service` now proves a canonical command/query path through
  validation, domain mutations, SQLite revision commits, FTS, restart, search,
  backlinks, trash/restore, attachments, verified backup/restore into a new
  workspace, export, and explicit Web-v1 migration.
- `apps/desktop`: typed Tauri 2 commands expose UI load/save and the canonical
  application-service command/query lanes without exposing SQL or arbitrary
  filesystem access.
- `npm run test:offline` proves the canonical SQLite vertical slice survives a
  restart in a separate Node process while outbound networking is denied, then
  runs the offline-asset scan.
- Native CI is configured to test the Rust shell and build `.deb` and AppImage
  artifacts on native x86-64 and ARM64 Ubuntu runners.
- Foundational spike verdicts are now recorded in ADRs 0006-0012:
  editor/Yjs behavior and SQLite/FTS5 primitives are validated; stable block IDs,
  versioned logical documents with Yjs persistence, and rebuildable local search
  are accepted. Self-contained Tauri packaging and crash-safe attachment
  staging retain explicit validation gates.

## Not yet a release

- No locally verified packaged Tauri desktop application or completed rich
  ProseMirror/Tiptap editor. Rust is installed on this host, but the required
  GTK/WebKit development packages are missing and require administrator access.
- The current desktop bridge requires an external Node 24 executable and starts
  a fresh service process for every IPC request. It is therefore not yet a
  self-contained or suitably efficient production desktop package.
- The canonical SQLite service has a separate-process offline restart test, but
  packaged desktop restart/crash durability and full UI E2E remain unverified.
- Required block behaviours, collection views, relations/rollups, attachments UI, full import/export UX, and complete restore workflow remain partial.
- Sync server, multi-user collaboration, permissions, encryption, AI, and MCP are designed/deferred, not shipped.
- Full E2E, accessibility, security, failure-injection, migration, and representative performance evidence is incomplete.

## Next vertical slice

Replace the external process-per-request Node bridge with a bundled persistent
runtime or measured Rust-owned service, then package it for Linux desktop and prove:
create/edit/link/search/attach, terminate/restart, export, restore into a new
workspace, and run with networking blocked.

See `RISKS.md`, `ROADMAP.md`, and `TEST_STRATEGY.md` for gates and dependencies.

## Evidence baseline

- Editor spike: `spikes/002-editor-yjs`, 4/4 tests pass for block types/IDs,
  versioned offline reload, undo/redo, and unknown-node preservation.
- SQLite/FTS spike: `spikes/003-sqlite-fts`, 3/3 tests pass for migrations,
  document updates, FTS5, attachment hashing, rollback, restart, and WAL recovery.
- Tauri spike: `spikes/001-tauri-linux`, 2/2 boundary tests and the offline web
  build pass. The typed shell and native CI matrix now exist; local native
  compilation/launch/package remains unverified because this host lacks the
  GTK/WebKit development packages.
