# Status

Updated: 2026-08-04

## Working foundation

- Monorepo, development scripts, product/architecture/data/sync/security documentation, and initial ADRs exist.
- `packages/core`: versioned workspace/page/block/collection/view/attachment models, hierarchy cycle prevention, links/backlinks, ranked in-memory search, persistence abstraction, and JSON/Markdown/CSV export primitives.
- `apps/web`: runnable offline-oriented vertical slice with nested navigation, editable blocks/tables, keyboard quick search, wiki links/backlinks, versioned browser persistence, and responsive light/dark UI.
- Storage, search, formula, backup, and observability packages have initial implementations and focused tests.

## Not yet a release

- **Critical integration gap:** `apps/web` still persists its own schema-v1
  localStorage model and does not call the core, SQLite storage, search, formula,
  or verified-backup packages. Those packages are tested foundations, not an
  integrated application vertical slice.
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
