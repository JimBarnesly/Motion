# ADR 0002: SQLite with a typed block model

- Status: Accepted
- Date: 2026-08-04

## Decision

Use normalized SQLite records for identities, hierarchy, references, indexes, and typed database properties. Store type-specific block/view payloads as schema-validated JSON. Store attachment bytes outside SQLite by content hash. Use SQLite FTS for a rebuildable search index.

## Consequences

Transactions and relational integrity cover the core model while JSON permits measured evolution. Validation and explicit schema migrations are mandatory; arbitrary unversioned JSON blobs are not allowed. Files avoid database bloat but require staged writes and integrity checks.
