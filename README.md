# Motion

Motion is an original, open, local-first personal knowledge workspace. It
combines nested rich documents, linked knowledge, tasks, lightweight relational
databases, search, attachments, and portable exports without requiring an
account or network connection.

This repository currently contains the first vertical slice: create and nest
pages, edit typed block content with keyboard operations, create database
tables, search, inspect stable-ID links/backlinks, and export workspace data.
The Web UI now selects a persistence adapter: IndexedDB for browser development
and an allowlisted Tauri IPC adapter for the desktop shell. The Tauri path
migrates UI schema v1 into the canonical SQLite application service and uses
native search, export, attachments, and verified backup/restore operations.
The core also defines records-as-pages, typed filter/sort trees, materialised
link indexing, unknown-block preservation, and schema migration. Local storage is authoritative. Sync, collaboration,
encryption, and AI integrations are optional layers and are documented as
future protocol-compatible services rather than dependencies of local mode.

## Install the Linux desktop release

Release packages are staged in `artifacts/release/`. Choose the package matching
your CPU architecture. Motion needs no account, cloud
service, database server, or internet connection at runtime.

For the AppImage:

```sh
chmod +x artifacts/release/Motion_0.1.0_aarch64.AppImage
./artifacts/release/Motion_0.1.0_aarch64.AppImage
```

For the Debian package:

```sh
sudo apt install ./artifacts/release/Motion_0.1.0_arm64.deb
motion-desktop
```

Use the left sidebar to create and organise pages, `Ctrl+K` to search, and the
top-bar export/restore controls for portable JSON or a verified native backup.
Workspace data stays in the current user's local application-data directory.
See [the release guide](docs/RELEASE.md) for verification and uninstall details.

## Development

```sh
npm install
npm test
npm run test:offline
npm run test:e2e
npm run build
npm run dev
```

The development server prints the local URL. It does not require an account or
contact an external service.

## Repository map

- `apps/web` — offline-capable browser application
- `apps/desktop` — typed Tauri 2 shell and allowlisted application-service IPC boundary
- `packages/core` — versioned domain model, persistence, search, and export
- `packages/app-service` — canonical command/query boundary over domain and SQLite
- `packages/storage` — durable SQLite workspace storage and content-addressed files
- `packages/search` — incremental local search with filtered ranked results
- `packages/formula` — versioned parser, typed AST, evaluator, and cycle detection
- `packages/backup` — checksummed canonical backups, preview, verified restore, and exports
- `packages/observability` — redacted local logs, diagnostics, crash records, and support bundles
- `docs` — product, architecture, protocols, security, and decisions

## Data portability

Motion supports structured JSON workspace export, Markdown page export, CSV
database export, and a manifest suitable for bundling attachment files. Export
formats and compatibility rules are documented in `docs/`.

## Status

Motion 0.1.0 is an early Linux desktop release. The local vertical slice is a
real foundation, not a compatibility clone or a hosted-service mock-up. Native
Linux package CI builds x86-64 and ARM64 packages. The shell bundles a pinned,
checksum-verified Node 24 runtime and keeps one local service process alive.
The current UI remains a vanilla Web-v1 compatibility layer rather than the
required React and Tiptap/ProseMirror implementation.
