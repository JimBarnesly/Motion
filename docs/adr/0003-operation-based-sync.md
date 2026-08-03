# ADR 0003: Operation-based optional sync

- Status: Accepted
- Date: 2026-08-04

## Decision

Record domain mutations as idempotent, causally described operations and reconcile replicas using documented CRDT merge rules. The optional server relays and durably stores operations/blobs; it is not the authoritative document database. Presence remains ephemeral and separate.

## Consequences

Offline writes and multi-device convergence are possible without a central lock. Operations, tombstones, compaction frontiers, and compatibility rules increase complexity, so randomized convergence tests are release requirements. Local-only builds retain the log for history but require no server.
