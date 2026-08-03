# ADR 0009: SQLite authority with FTS5 and a replaceable access adapter

- Status: Accepted architecture; production adapter selection provisional
- Date: 2026-08-04

## Context

The desktop client needs transactional local authority, explicit migrations, durable binary document updates, crash recovery, and fast local full-text search without network access.

## Decision

Use one workspace-local SQLite database in WAL mode as authoritative metadata/operation storage, with explicit ordered migrations and FTS5 as a rebuildable search projection. Access it only through a narrow asynchronous application-service/storage adapter so the UI never receives SQL or performs synchronous database work in the typing path. Use Node 24 `node:sqlite` for continuing prototypes; production desktop ownership remains with the Tauri/Rust boundary unless benchmarks and packaging evidence justify otherwise.

## Alternatives considered

- Browser localStorage/IndexedDB as desktop authority: rejected for the desktop milestone's transaction, migration, FTS5, and integrity requirements.
- Serialize the whole workspace as files: rejected for transactional cross-entity updates and indexed queries.
- Commit permanently to synchronous `node:sqlite`: deferred because latency and native desktop ownership are not yet measured.

## Consequences

SQLite and FTS must share transactional update rules; FTS can be rebuilt from canonical records. Multi-version migrations, concurrency, disk-full behavior, and representative-scale latency remain gates.

## Security implications

Use parameterized statements, narrow commands, least-privilege filesystem permissions, and integrity checks. Search snippets must be escaped before display.

## Data portability implications

SQLite is an implementation store, not the export contract. Versioned JSON/Markdown/CSV plus attachments remain canonical portability surfaces.

## Revisit conditions

Revisit the access implementation after Rust and Node adapters are benchmarked in a packaged Ubuntu build; revisit SQLite only if it fails measured durability or scale targets.

## Spike evidence

- `spikes/003-sqlite-fts/spike.test.mjs`, `migration, metadata, updates, FTS5, attachments and rollback`, proves migrations, blobs, ranked lookup, rollback, and integrity checking.
- `committed state survives a complete process restart` proves durable reopen behavior.
- `WAL recovery discards an uncommitted transaction after SIGKILL` proves tested recovery and `PRAGMA integrity_check = ok`.
- `spikes/003-sqlite-fts/README.md` flags `DatabaseSync` latency, scale, upgrade migration, and concurrent-writer gaps.
