# Development guide

## Requirements

- Node.js 22 or newer
- npm 10 or newer

Install dependencies with `npm install`, then run `npm test`, `npm run
typecheck`, and `npm run build`. The workspaces are intentionally small and do
not require Docker, a database server, or internet access at runtime.

## Boundaries

`packages/core` owns persisted types, mutations, migrations, search, and
exports. `apps/web` owns rendering and browser interaction. UI code should not
invent persisted fields or modify stored structures without passing through the
core package.

Networked services must be optional adapters. Any new outbound request requires
a visible user action, documentation, a timeout, and a usable offline failure
mode. Remote fonts, analytics, and telemetry are prohibited.

## Definition of done

- Persisted structures are versioned and migratable.
- Core behaviour has automated tests.
- Export output is deterministic and documented.
- The application builds without remote runtime assets.
- Offline local use remains complete.
- Security- or protocol-significant decisions have an ADR.
