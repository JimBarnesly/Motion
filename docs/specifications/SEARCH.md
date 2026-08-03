# Local Search Specification

Status: design contract; the complete search system is not yet implemented.

## Indexed content

Desktop search uses SQLite FTS5 as a derived local index. It covers page titles and aliases, body/headings/block text, collection and property names, textual property values, select/status labels, attachment filenames, and materialized incoming/outgoing page links. Canonical records, not the FTS tables, remain the source of truth.

Indexing is incremental and transactionally queued with each canonical mutation. A background worker applies durable index jobs; queries may expose that indexing is catching up. Rename, move, tombstone, restore, attachment, schema, and link-index changes all have explicit index actions. No external search service or network request is required.

## Query behavior

Quick search and the full search screen share one query service. Results provide stable target IDs, kind, title, contextual snippet, highlighted match ranges, score, and modification metadata. Ranking combines normalized text relevance, title/heading weighting, recency, and optional local usage signals with deterministic tie-breaking by stable ID.

Keyboard navigation, recent searches, and filters for workspace, page/content type, collection, date range, property, and incoming/outgoing links are required. Search history is local, can be disabled, and can be cleared without changing content. Disabling history prevents future query persistence.

## Integrity, privacy, and recovery

The index contains no content that is not already available to the local authorized profile. Locking an encrypted workspace closes its index connection and removes decrypted temporary state according to the encryption design. Snippets escape markup and never fetch remote resources.

A reindex command builds new FTS tables beside the active index, compares source/index counts and sampled hashes, then swaps atomically. Integrity checks detect missing, stale, duplicate, and orphan documents. Interrupted rebuilds leave the previous index usable. Tests cover Unicode, punctuation, ranking stability, tombstones, rename/update/delete, backlinks, disabled history, rebuild after corruption, empty workspaces, and offline operation.
