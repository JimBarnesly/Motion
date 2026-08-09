# Status

Updated: 2026-08-09

## Pages and tables usability increment

- The native Web UI now loads canonical schema-v2 workspaces and sends
  fine-grained, revisioned page/database commands instead of round-tripping
  normal edits through the Web-v1 compatibility document.
- Sidebar navigation supports root/child creation, table creation, rename,
  move, sibling reorder, expand/collapse, favourites, trash/restore, persisted
  expansion state, breadcrumbs, and back navigation. Stable page IDs and
  descendants are retained.
- Tables support title, text, number, checkbox, select, multi-select, status,
  date, URL, email, and phone properties. Property names, types, option
  definitions, visibility, order, and widths are editable and saved in the
  canonical table view.
- Records are canonical pages. Clicking a title opens the same page used by the
  table, with editable properties and normal stable-ID block content.
- Saved views support nested one-level AND/OR/NOT filter groups, the full
  initial comparison operator set, and deterministic multi-column sorts.
- SQLite restart coverage exercises hierarchy, favourites, typed properties,
  record content, filters, sorts, column configuration, and links. Browser E2E
  covers a typed table-to-record-page workflow and reload.
- The 5,000-record table path bounds DOM output to 500 rows. The reproducible
  fixture/benchmark is available through `npm run benchmark:pages-tables -- 5000`.

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
- Native CI tests the Rust shell and builds `.deb` and AppImage artifacts on
  native x86-64 and ARM64 Ubuntu runners. Run `30876348219` passed both native
  jobs and uploaded architecture-specific package artifacts.
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

- Native Tauri packages now build successfully in CI for x86-64 and ARM64.
  Installed-package launch, restart, and offline smoke tests remain outstanding;
  this host still lacks the GTK/WebKit development packages required for local
  native compilation and launch.
- The UI remains vanilla JavaScript rather than the accepted React plus
  Tiptap/ProseMirror editor. Page/table mutations now use fine-grained typed
  commands in native mode; browser development retains its IndexedDB adapter.
- The canonical SQLite service has a separate-process offline restart test, but
  packaged desktop restart/crash durability and packaged native UI E2E remain
  unverified. Browser Playwright E2E does not close this gate.
- Attachments are currently read and transported as complete in-memory byte
  arrays; streaming and large-file limits are not implemented.
- List indent/outdent, multi-block selection, clipboard/IME hardening, drag and
  drop, and full Tiptap/ProseMirror editing remain incomplete.
- Table rendering is bounded rather than virtualised and currently shows the
  first 500 matching records. Full windowed scrolling is still required.
- Property type changes clear incompatible existing values. A preview/conversion
  flow would be better for large populated properties.
- Native packaged UI E2E is still required; current native restart evidence is
  at the SQLite service boundary and browser Playwright covers the interaction.
- Sync server, multi-user collaboration, permissions, encryption, AI, and MCP are designed/deferred, not shipped.
- Full E2E, accessibility, security, failure-injection, migration, and representative performance evidence is incomplete.

## Next vertical slice

Smoke-test the uploaded x86-64 and ARM64 packages on representative Linux hosts,
including create/edit/link/search/attach, terminate/restart, export, restore into
a new workspace, and operation with networking blocked. Then replace the Web-v1
compatibility editor with the React plus Tiptap/ProseMirror editor over the same
typed service boundary.

See `RISKS.md`, `ROADMAP.md`, and `TEST_STRATEGY.md` for gates and dependencies.

## Evidence baseline

- Editor spike: `spikes/002-editor-yjs`, 4/4 tests pass for block types/IDs,
  versioned offline reload, undo/redo, and unknown-node preservation.
- SQLite/FTS spike: `spikes/003-sqlite-fts`, 3/3 tests pass for migrations,
  document updates, FTS5, attachment hashing, rollback, restart, and WAL recovery.
- Tauri spike: `spikes/001-tauri-linux`, 2/2 boundary tests and the offline web
  build pass. The typed shell, verified bundled runtime, icon, and native CI
  matrix now exist. CI run `30876348219` built and uploaded x86-64 and ARM64
  packages; installed-artifact behavior remains unverified.
