# Motion

Motion is an original, open, local-first personal knowledge workspace. It
combines nested rich documents, linked knowledge, tasks, lightweight relational
databases, search, attachments, and portable exports without requiring an
account or network connection.

This repository currently contains the first vertical slice: create and nest
pages, edit typed block content with keyboard operations, create database
tables, search, inspect stable-ID links/backlinks, and export workspace data.
The core also defines records-as-pages, typed filter/sort trees, materialised
link indexing, unknown-block preservation, and schema migration. Local storage is authoritative. Sync, collaboration,
encryption, and AI integrations are optional layers and are documented as
future protocol-compatible services rather than dependencies of local mode.

## Development

```sh
npm install
npm test
npm run build
npm run dev
```

The development server prints the local URL. It does not require an account or
contact an external service.

## Repository map

- `apps/web` — offline-capable browser application
- `packages/core` — versioned domain model, persistence, search, and export
- `docs` — product, architecture, protocols, security, and decisions

## Data portability

Motion supports structured JSON workspace export, Markdown page export, CSV
database export, and a manifest suitable for bundling attachment files. Export
formats and compatibility rules are documented in `docs/`.

## Status

Motion is early-stage software. The local vertical slice is intended to be a
real foundation, not a compatibility clone or a hosted-service mock-up.
