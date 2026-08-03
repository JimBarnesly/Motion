# Motion Data Model

## Versioning and conventions

The initial logical schema is `motion.workspace/1.0`. Persisted databases also carry an integer migration level. Every entity has `id`, `workspaceId`, `createdAt`, `updatedAt`, and optional `deletedAt`. IDs are UUIDv7 strings. Extension fields must be namespaced; unknown fields survive JSON round trips where practical.

## Core entities

- **Workspace:** name, settings, encryption metadata, schema version.
- **Page:** parent page (nullable), title, icon/cover references, ordered root blocks, archived state.
- **Block:** page, parent block (nullable), type, payload schema version, fractional/order key, typed JSON payload. Unknown types are opaque canonical records whose discriminator, version, and payload must survive round trips unchanged.
- **Database:** title and ordered property definitions.
- **PropertyDefinition:** stable ID, name, type, options. Initial types: text, number, boolean, date, select, multi-select, page relation, attachment.
- **Row:** database ID, optional page ID, ordered typed values keyed by property ID.
- **View:** database ID, type (`table` initially), visible properties, filters, sorts, grouping and presentation settings.
- **Link:** materialized index row containing source page and optional source block, target page, link kind, optional target block, and optional display text. Link identity uses stable IDs; backlinks query this index rather than scanning documents. Link rows are transactionally derived from canonical block payloads and can be rebuilt.
- **Attachment:** content hash, byte size, MIME type, original filename, storage key, encryption metadata.
- **Comment:** thread, target entity/range, author identity when collaboration is enabled, body, resolved state.
- **Operation:** actor ID, monotonic actor sequence, operation ID, dependency/vector summary, kind, payload, timestamp.

## Formal entity catalogue

The storage schema is divided into bounded groups while domain DTOs remain independent of table layout:

- **Identity/workspace:** `User`, `Device`, `Workspace`, `WorkspaceMember`, `Role`, `Permission`, `Invitation`, `EncryptionKeyEnvelope`.
- **Content:** `Page`, `PageTreePosition`, `Document`, `DocumentUpdate`, `DocumentSnapshot`, `BlockReference`, `PageLink`, `Attachment`, `AttachmentReference`, `Tag`, `Favourite`, `Template`.
- **Collections:** `Collection`, `CollectionProperty`, `CollectionRecord`, `PropertyValue`, `CollectionView`, `Relation`, `RollupDefinition`, `FormulaDefinition`.
- **Collaboration:** `CommentThread`, `Comment`, `Mention`, `Notification`, `PresenceState`, `Revision`, `AuditEntry`.
- **Synchronization:** `Replica`, `Operation`, `OperationCursor`, `OutboxEntry`, `InboxEntry`, `Tombstone`, `SyncCheckpoint`, `ConflictRecord`.

Every persistent entity has a globally unique stable ID, creation and modification metadata, tombstone semantics, workspace scope where applicable, schema version where its payload can evolve, and deterministic serialization tests. Actor fields are optional where local-only mode has no user identity. `PresenceState` is ephemeral and is not exported as durable workspace history. Storage rows are mapped through repositories/application services; the UI never receives storage-layer entities directly.

Deletion is tombstoned while operations may still reference an entity. Compaction may physically remove tombstones only after all known replicas acknowledge the containing frontier or an explicit single-device retention policy permits it.

## Invariants

- A page parent is either null or a live page in the same workspace; cycles are rejected.
- Block parents belong to the same page, and block trees are acyclic.
- Order keys are unique within a sibling collection; rebalance is represented as ordinary operations.
- Property values are validated against definitions. Removing a property tombstones its definition so old operations remain interpretable.
- Relations target stable IDs, never titles or paths.
- Renaming or moving a page does not rewrite link identity; display titles are resolved from the target page.
- Unknown block payloads are not normalized, stripped, or rewritten by clients that do not understand their type.
- Attachment references target a verified content hash; missing blobs are represented explicitly, not as successful uploads.
- Requested output state and confirmed external state are distinct if automation integrations are added later.

## JSON interchange example

```json
{
  "schemaVersion": "motion.workspace/1.0",
  "workspace": { "id": "019...", "name": "Personal" },
  "pages": [],
  "blocks": [],
  "databases": [],
  "rows": [],
  "views": [],
  "links": [],
  "comments": [],
  "attachments": []
}
```

## Full export bundle

```text
manifest.json                 schema, app version, created time, checksums
workspace.json                lossless structured model
markdown/<page-id>.md         readable page exports
csv/<database-id>.csv         database values
csv/<database-id>.schema.json property IDs/types/options
attachments/<sha256>          original bytes
attachments/manifest.json     filenames, MIME types, references, checksums
```

`manifest.json` states whether comments/history are included. Secrets, access tokens, device keys, search indexes, and caches are excluded. Import verifies every checksum before mutation, imports into staging tables, validates all references, then commits atomically.

## Migrations

Each release declares supported input versions and deterministic transforms. Migration records contain source/target versions, migration ID, checksum, application version, start/end times, and result. Export migrations operate on a copy. Database migrations are transactional where SQLite permits; filesystem transforms use staging and a resumable journal. Restore tests compare entity counts, stable IDs, hierarchy, block payloads, typed values, relations, views, and attachment hashes.
