# ADR 0012: Tauri desktop shell with a narrow portable client boundary

- Status: Provisional pending native Ubuntu build and package
- Date: 2026-08-04

## Context

Motion prioritizes Linux desktop while preserving a later browser client. The UI must not gain raw filesystem or database access, and browser preview/testing should not require the native shell.

## Decision

Use Tauri 2 as the intended desktop shell and expose `MotionAppService.execute(command)` and `MotionAppService.query(query)` through allowlisted, size-limited IPC envelopes owned by `packages/app-service`. Keep a browser adapter implementing the same typed contract for web development and later PWA storage. One contract suite must run against both adapters. The production frontend remains React/strict TypeScript/Vite per ADR 0005, but the spike validates only dependency injection around a native boundary—not the full contract, React, SQLite ownership, or native packaging. Browser localStorage is a preview/migration source, never desktop authority.

## Alternatives considered

- Electron/Node authority: broader bundled runtime but higher footprint and not yet shown to improve Motion's boundary.
- Browser-only/PWA first: conflicts with the Linux desktop and SQLite durability milestone.
- UI access to raw SQL/filesystem APIs: rejected for security and portability.

## Consequences

Every command needs typed request/result contracts and equivalent behavioral tests across adapters. Desktop-only capability failures require honest browser states.

## Security implications

The native allowlist remains minimal; validate all paths and payloads at the command boundary. Browser adapters receive no ambient filesystem capability.

## Data portability implications

Domain schemas and export formats stay independent of Tauri. Browser/mobile adapters can change storage without changing portable workspace data.

## Revisit conditions

Accept after a supported Ubuntu runner compiles, launches, and packages Tauri 2 offline and boundary tests run against the real native command. Revisit Tauri if supportable packaging fails.

## Spike evidence

- `spikes/001-tauri-linux/test/boundary.test.mjs` proves browser fallback and that the UI calls only `runtime_label` through an injectable boundary.
- `spikes/001-tauri-linux/README.md` records a **PARTIAL** verdict: offline web build and boundary tests pass, while native build fails because Rust and GTK/WebKit dependencies are absent on the aarch64 Debian host.
