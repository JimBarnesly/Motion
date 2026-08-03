# ADR 0011: Rebuildable incremental SQLite FTS5 search

- Status: Accepted for desktop foundation; performance thresholds provisional
- Date: 2026-08-04

## Context

Search must work instantly offline across canonical local content. It must update incrementally but remain repairable after corruption or migration.

## Decision

Use SQLite FTS5 as a denormalized, rebuildable projection. Update canonical searchable metadata and FTS rows in the same transaction. When Yjs materialization cannot complete synchronously, commit a durable reindex job and its source document checkpoint in that same transaction; startup and foreground workers resume idempotently. Search results expose an indexing status until the queue reaches the committed checkpoint. Tombstones delete or suppress FTS rows transactionally. Store stable entity IDs and fields needed for filters outside or alongside the FTS text. Expose integrity-check and full-reindex commands. Ranking and snippets belong to the search adapter, while UI rendering escapes all returned text.

## Alternatives considered

- Scan all pages on query: rejected for target workspace sizes and backlinks/search latency.
- In-memory index only: rejected because restart would require full rebuilding before useful search.
- External search service: rejected because offline local mode must be complete.

## Consequences

Index schema and tokenizer changes require rebuild migrations. Search correctness tests must compare canonical entities with indexed results and cover deletion/tombstones.

## Security implications

FTS queries must be safely constructed; snippets are untrusted display data. Search indexes contain workspace-derived content and inherit vault file protections.

## Data portability implications

FTS tables are omitted from canonical exports because they are reproducible from exported content.

## Revisit conditions

Revisit tokenizer/ranking and possibly the engine after benchmarks on 10,000 pages/100,000 blocks; retain the rebuildable-projection rule.

## Spike evidence

- `spikes/003-sqlite-fts/spike.test.mjs` inserts `Replace mechanical seal offline` and verifies an FTS query for `mechanical` returns the stable page ID.
- `spikes/003-sqlite-fts/README.md` reports ranked lookup with snippets but explicitly notes that target-scale performance is not benchmarked.
