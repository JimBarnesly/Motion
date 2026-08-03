# ADR 0007: Versioned document envelope with Yjs persistence

- Status: Accepted for the local editor model; collaboration compaction remains provisional
- Date: 2026-08-04

## Context

Motion requires deterministic documents, offline undo/redo, unknown-block preservation, exports, and later concurrent editing. ProseMirror JSON and Yjs solve different parts of that problem.

## Decision

The logical document is a Motion-versioned envelope containing a ProseMirror-compatible block tree. Yjs updates stored in SQLite are the durable editable-state representation for document bodies. Materialized ProseMirror JSON is a read-only projection for validation, rendering, migration, indexing, and export; aggregate workspace JSON must not become a second writable document authority. Persist schema version, ordered Yjs updates, and periodic snapshots/checkpoints.

A local document command commits its metadata change, Yjs update, application operation, and a durable link/search projection update or reindex-queue entry in one SQLite transaction. Search may be temporarily behind only when a committed queue entry makes that state explicit and recoverable at startup. Run explicit migrations and payload-preserving unknown-node wrapping before ProseMirror parsing, with limits on update bytes, decoded nodes, depth, attributes, and opaque payload size.

## Alternatives considered

- Store only ProseMirror JSON: simpler, but unsuitable for offline reconciliation and granular history.
- Store only opaque Yjs bytes: rejected because migrations, inspection, indexing, and portable export need an explicit logical schema.
- Independently write JSON and Yjs state: rejected because they can diverge.

## Consequences

The application needs deterministic materialization, update compaction rules, fixtures for every schema migration, and snapshot/update consistency checks.

## Security implications

Treat decoded updates and imported JSON as untrusted; enforce size, schema, and node/attribute limits before rendering.

## Data portability implications

Canonical exports contain versioned logical JSON, not only Yjs binary updates. Unknown nodes preserve bounded, validated raw JSON payloads as placeholders; fixtures must prove repeated load/edit/export round trips for supported compatibility versions.

## Revisit conditions

Revisit if Yjs update growth, compaction, or cross-version migration cannot meet durability and replica-safety requirements.

## Spike evidence

- `spikes/002-editor-yjs/test/editor.test.mjs`, `versioned envelope round-trips without a server`, proves binary Yjs save/reload and rejects unsupported envelope versions.
- The same file's undo/redo test proves local structured history through `Y.UndoManager`.
- `unknown future nodes are preserved as lossless placeholders` proves raw unknown node data survives a compatibility transform; the README confirms ProseMirror rejects it without that layer.
