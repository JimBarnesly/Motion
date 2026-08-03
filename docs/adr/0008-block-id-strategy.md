# ADR 0008: Application-assigned stable block IDs

- Status: Accepted
- Date: 2026-08-04

## Context

Blocks need stable anchors for links, comments, sync operations, selection, and export. IDs must survive edits, Yjs encoding, reload, and schema evolution.

## Decision

Assign every new persisted block a UUIDv7 and treat it as an opaque application ID. Store it as a node attribute and preserve it through transforms. Because ProseMirror requires generatable nodes in required positions, the schema attribute is nullable; Motion's command/import boundary rejects or repairs missing and duplicate IDs before persistence. Imported legacy IDs may be retained when unique and safely formatted, with an explicit mapping recorded during import. IDs never derive from position, content, or title and are not reused after deletion.

## Alternatives considered

- Position- or content-derived IDs: rejected because moves and edits would break references.
- Required non-default ProseMirror attributes: rejected because required content nodes cease to be generatable.
- Yjs-internal item identity: rejected as an application-facing anchor and export identifier.

## Consequences

All creation, paste, duplicate, split, merge, import, and migration paths need explicit ID policy and collision tests.

## Security implications

Imported IDs require format and uniqueness validation; IDs convey identity, not authorization.

## Data portability implications

Stable IDs appear in structured exports so links and block anchors can be reconstructed after restore or migration.

## Revisit conditions

Revisit UUIDv7 only through a migration ADR if measured storage/index costs justify another globally unique scheme; do not revisit stability semantics.

## Spike evidence

- `spikes/002-editor-yjs/test/editor.test.mjs`, `several block types and stable IDs survive Yjs save/reload`, verifies exact IDs after encoding and reload.
- `spikes/002-editor-yjs/README.md` records the nullable-default/generative-node constraint and requires application-boundary validation.
