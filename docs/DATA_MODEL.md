# Motion Data Model

## Versioning and conventions

The initial logical schema is `motion.workspace/1.0`. Persisted databases also carry an integer migration level. Every entity has `id`, `workspaceId`, `createdAt`, `updatedAt`, and optional `deletedAt`. IDs are UUIDv7 strings. Extension fields must be namespaced; unknown fields survive JSON round trips where practical.

## Core entities

- **Workspace:** name, settings, encryption metadata, schema version.
- **Page:** parent page (nullable), title, icon/cover references, ordered root blocks, archived state.
- **Block:** page, parent block (nullable), type, fractional/order key, typed JSON payload. Initial types: paragraph, headings, list item, task, quote, code, divider, image/file, database reference.
- **Database:** title and ordered property definitions.
- **PropertyDefinition:** stable ID, name, type, options. Initial types: text, number, boolean, date, select, multi-select, page relation, attachment.
- **Row:** database ID, optional page ID, ordered typed values keyed by property ID.
- **View:** database ID, type (`table` initially), visible properties, filters, sorts, grouping and presentation settings.
- **Link:** source entity/block, target page, optional display text; backlinks are a query over links.
- **Attachment:** content hash, byte size, MIME type, original filename, storage key, encryption metadata.
- **Comment:** thread, target entity/range, author identity when collaboration is enabled, body, resolved state.
- **Operation:** actor ID, monotonic actor sequence, operation ID, dependency/vector summary, kind, payload, timestamp.

Deletion is tombstoned while operations may still reference an entity. Compaction may physically remove tombstones only after all known replicas acknowledge the containing frontier or an explicit single-device retention policy permits it.

## Invariants

- A page parent is either null or a live page in the same workspace; cycles are rejected.
- Block parents belong to the same page, and block trees are acyclic.
- Order keys are unique within a sibling collection; rebalance is represented as ordinary operations.
- Property values are validated against definitions. Removing a property tombstones its definition so old operations remain interpretable.
- Relations target stable IDs, never titles or paths.
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
