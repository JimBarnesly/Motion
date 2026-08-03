# ADR 0005: Validated desktop technical baseline

- Status: Accepted direction; native database adapter ownership remains provisional
- Date: 2026-08-04

## Context

Motion needs a Linux-first desktop runtime with later Windows/macOS portability, a responsive accessible UI, durable local storage, local full-text search, and filesystem-efficient attachments. Local editing must not depend on a server or vendor service.

## Decision

Use Tauri 2 for the intended desktop shell; React with strict TypeScript, Vite, CSS variables/design tokens, and accessible headless primitives for the UI; SQLite with explicit migrations and FTS5 for canonical local records and rebuildable search; and content-addressed attachment files with hashes and metadata stored in SQLite. Whether production SQLite ownership is implemented in Rust or behind another measured native adapter remains open until packaged benchmarks and supportability tests resolve ADR 0009.

Tauri commands expose narrow application-service APIs rather than raw SQL or unrestricted filesystem access. The UI remains separable enough for a later browser client, but desktop durability and integration take priority. Dependencies must use current compatible stable releases, have acceptable licenses, and be pinned through lockfiles and documented toolchain versions.

## Validation gates

Before declaring the baseline production-ready, prove on supported Ubuntu that Tauri packaging works, required SQLite includes FTS5, migrations and crash recovery pass, attachment staging survives interruption, keyboard/accessibility behavior is testable, and idle/local-only operation makes no undocumented network requests. Windows and macOS builds require their own packaging and filesystem tests before support claims.

## Consequences

Rust adds a toolchain and an IPC boundary but centralizes durable mutations and native file handling. React/Tauri are implementation choices, not export or protocol dependencies. SQLite and attachment directories require coordinated backup/restore and integrity checks. Optional collaboration, AI, and remote services remain adapters and are excluded from the local write path.
