# ADR 0010: Content-addressed attachment files with transactional metadata

- Status: Provisional; buffered staging/recovery implemented, streaming and fsync hardening pending
- Date: 2026-08-04

## Context

Attachments must survive restart, deduplicate safely, stream at useful sizes, export cleanly, and avoid bloating SQLite. A filesystem write and database commit are not naturally atomic together.

## Decision

Store attachment bytes outside SQLite under a SHA-256 content address; store original display name, media type, byte length, hash, stable attachment-reference identity, and lifecycle state in SQLite. The current write path creates a private same-root staging file, validates its hash, commits metadata referencing the final hash path, then atomically renames staging to that path. If promotion is interrupted after metadata commit, the next attachment operation scans all workspace references and promotes matching staging. Rolled-back/unreferenced staging is removed deterministically. Referenced missing blobs and unreferenced final blobs are reported; final blobs are not automatically deleted until retention and concurrent-process rules exist. Never use user file names as storage paths.

The current API buffers bytes in memory. The storage package is an internal same-process component, not a supported multi-process writer API. Production access is through the desktop service, which acquires exclusive data-root ownership before constructing SQLite, attachment, or UI-state stores and retains that ownership for their complete lifetime. A second service process is rejected before it can dispatch attachment put or promotion work. Cross-process locking must remain at this integrated service boundary rather than being duplicated or weakened inside attachment storage.

Staged attachment objects are opaque, store-bound, single-use capabilities. Promotion or discard consumes the capability synchronously before publication queues or filesystem access. Publication continues from an immutable internal record detached from the caller's token; concurrent reuse receives the stable capability error without disclosing the staging pathname. Once consumed, a token is never restored. Interrupted bytes remain authenticated staging evidence for service recovery; pre-consumption failures may be cleaned up by a best-effort discard.

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

Accept fully only after interruption tests cover process termination at every staging/publication/commit boundary, fsync/no-follow handling is verified on supported filesystems, and large files are streamed without full buffering. Multi-process coordination is defined only for the production desktop-service ownership boundary; direct multi-process storage-package use remains unsupported.

## Spike evidence

- `spikes/003-sqlite-fts/spike.test.mjs` writes a binary payload through `putAttachment`, reads it by hash, and proves byte equality.
- `spikes/003-sqlite-fts/README.md` explicitly identifies the unproven atomicity of metadata and filesystem creation, making this decision provisional.
- `packages/storage/src/test/storage.test.ts` proves referenced-stage promotion, abandoned-stage removal, missing-reference reporting, and conservative orphan reporting.
- `packages/app-service/src/test/app-service.test.ts` injects failure after metadata commit and proves the next operation recovers and reads the attachment.
