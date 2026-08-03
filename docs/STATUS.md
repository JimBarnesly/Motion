# Status

Updated: 2026-08-04

## Working foundation

- Monorepo, development scripts, product/architecture/data/sync/security documentation, and initial ADRs exist.
- `packages/core`: versioned workspace/page/block/collection/view/attachment models, hierarchy cycle prevention, links/backlinks, ranked in-memory search, persistence abstraction, and JSON/Markdown/CSV export primitives.
- `apps/web`: runnable offline-oriented vertical slice with nested navigation,
  editable blocks/tables, keyboard quick search, wiki links/backlinks, and
  responsive light/dark UI. It uses IndexedDB in browser development and an
  allowlisted Tauri IPC adapter when hosted by the desktop shell; schema-v1
  imports are validated and migrated into the canonical service. Native mode
  uses canonical FTS search and export queries, content-addressed attachment
  ingestion, and verified backup/create/preview/restore operations.
- Storage, search, formula, backup, and observability packages have initial implementations and focused tests.
- `packages/app-service` now proves a canonical command/query path through
  validation, domain mutations, SQLite revision commits, FTS, restart, search,
  backlinks, trash/restore, attachments, verified backup/restore into a new
  workspace, export, and explicit Web-v1 migration.
- `apps/desktop`: typed Tauri 2 commands expose UI load/save and the canonical
  application-service command/query lanes without exposing SQL or arbitrary
  filesystem access. It manages one persistent service process and packages an
  architecture-specific Node 24.18.0 runtime whose archive is pinned and
  SHA-256 verified during build preparation; installed applications do not
  download a runtime.
- `npm run test:offline` proves the canonical SQLite vertical slice survives a
  restart in a separate Node process while outbound networking is denied, then
  runs the offline-asset scan.
- Native CI is configured to test the Rust shell and build `.deb` and AppImage
  artifacts on native x86-64 and ARM64 Ubuntu runners. It is currently rerunning
  after frontend path, application-icon, and offline-source scan gates were fixed;
  packaged artifacts are not yet proven.
- Playwright covers the offline browser create/edit/reload/search/export flow.
- Page trash is reversible and restores affected ancestors/descendants. Attachment
  staging and deterministic recovery mitigate interrupted blob promotion.
- An original Motion application icon and required Tauri Linux derivatives are
  included.
- Foundational spike verdicts are now recorded in ADRs 0006-0012:
  editor/Yjs behavior and SQLite/FTS5 primitives are validated; stable block IDs,
  versioned logical documents with Yjs persistence, and rebuildable local search
  are accepted. Self-contained Tauri packaging and crash-safe attachment
  staging retain explicit validation gates.

## Not yet a release

- No locally or CI-verified packaged Tauri desktop application yet. Rust is
  installed on this host, but the required GTK/WebKit development packages are
  missing and require administrator access; the corrected native CI is rerunning.
- The UI remains vanilla JavaScript and a Web-v1 compatibility document adapter,
  not the required React plus Tiptap/ProseMirror editor. Not every UI mutation
  is expressed as a fine-grained typed domain command.
- The canonical SQLite service has a separate-process offline restart test, but
  packaged desktop restart/crash durability and packaged native UI E2E remain
  unverified. Browser Playwright E2E does not close this gate.
- Attachments are currently read and transported as complete in-memory byte
  arrays; streaming and large-file limits are not implemented.
- Required block behaviours, collection views, relations/rollups, full import/export UX, and complete restore workflow remain partial.
- Sync server, multi-user collaboration, permissions, encryption, AI, and MCP are designed/deferred, not shipped.
- Full E2E, accessibility, security, failure-injection, migration, and representative performance evidence is incomplete.

## Next vertical slice

Get the corrected native CI green, install local GTK/WebKit prerequisites, then
package the bundled persistent-runtime shell for Linux desktop and prove:
create/edit/link/search/attach, terminate/restart, export, restore into a new
workspace, and run with networking blocked.

See `RISKS.md`, `ROADMAP.md`, and `TEST_STRATEGY.md` for gates and dependencies.

## Evidence baseline

- Editor spike: `spikes/002-editor-yjs`, 4/4 tests pass for block types/IDs,
  versioned offline reload, undo/redo, and unknown-node preservation.
- SQLite/FTS spike: `spikes/003-sqlite-fts`, 3/3 tests pass for migrations,
  document updates, FTS5, attachment hashing, rollback, restart, and WAL recovery.
- Tauri spike: `spikes/001-tauri-linux`, 2/2 boundary tests and the offline web
  build pass. The typed shell, verified bundled runtime, icon, and native CI
  matrix now exist; native artifacts remain unproven until CI succeeds, and
  local compilation/launch/package remains blocked by missing GTK/WebKit packages.
