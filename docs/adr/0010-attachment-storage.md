# ADR 0010: Content-addressed attachment files with transactional metadata

- Status: Provisional pending crash-safe staging tests
- Date: 2026-08-04

## Context

Attachments must survive restart, deduplicate safely, stream at useful sizes, export cleanly, and avoid bloating SQLite. A filesystem write and database commit are not naturally atomic together.

## Decision

Store attachment bytes outside SQLite under a SHA-256 content address; store original display name, media type, byte length, hash, stable attachment-reference identity, and lifecycle state in SQLite. Writes use symlink-safe/no-follow private staging, streamed hashing and size enforcement, file fsync, atomic same-filesystem rename, and containing-directory fsync where the platform supports it, followed by transactional metadata/reference commit. Existing hash-path blobs are opened without following links and rehashed before deduplication reuse. Recovery removes stale staging files and unreferenced rename-success/DB-failure orphans, and reports referenced missing blobs. Never use user file names as storage paths.

## Alternatives considered

- SQLite BLOBs: simpler atomicity but poorer streaming, backup, and large-file behavior.
- Original-name filesystem paths: rejected due to collisions and traversal risk.
- Hash-addressed files without staging/recovery: demonstrated but insufficient for crash consistency.

## Consequences

Backup/restore must coordinate database and blob manifests. Garbage collection needs reachability and retention rules. Deduplication must not leak cross-workspace existence.

## Security implications

Canonicalize paths, reject traversal, limit sizes/archive expansion, do not execute attachments, and verify hashes on read/restore.

## Data portability implications

Full exports include a versioned attachment manifest and original names alongside hash-addressed bytes. Attachment reference IDs remain distinct from blob hashes so restore can reconstruct references without exposing deduplication identity as object identity.

## Revisit conditions

Accept fully only after interruption tests cover every staging/rename/commit boundary and large files are streamed without full buffering.

## Spike evidence

- `spikes/003-sqlite-fts/spike.test.mjs` writes a binary payload through `putAttachment`, reads it by hash, and proves byte equality.
- `spikes/003-sqlite-fts/README.md` explicitly identifies the unproven atomicity of metadata and filesystem creation, making this decision provisional.
