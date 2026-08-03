# Development guide

## Requirements

- Node.js 22 or newer
- npm 10 or newer

Native desktop work additionally requires Rust 1.97.1 and the Linux development
libraries used by Tauri 2. On Debian/Ubuntu install:

```sh
sudo apt-get install --no-install-recommends \
  build-essential file libayatana-appindicator3-dev libgtk-3-dev \
  librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev
```

Install dependencies with `npm install`, then run `npm test`, `npm run
typecheck`, and `npm run build`. The workspaces are intentionally small and do
not require Docker, a database server, or internet access at runtime.

Validate the desktop boundary and native shell with:

```sh
npm run typecheck --workspace @motion/desktop
npm run test --workspace @motion/desktop
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run tauri:build --workspace @motion/desktop -- --bundles deb,appimage
```

CI runs those checks and builds `.deb` and AppImage packages natively on both
x86-64 (`ubuntu-24.04`) and ARM64 (`ubuntu-24.04-arm`). This is a native runner
matrix, not cross-compilation, so GTK/WebKit linking and architecture-specific
Tauri tooling are exercised on each target architecture. The package currently
expects a compatible `node` executable at runtime for the local service runner;
removing that deployment dependency remains separate packaging work.

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
