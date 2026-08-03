# Motion Architecture

## System shape

Motion uses a local application core with optional network adapters:

```text
UI -> application services -> domain model -> SQLite + attachment store
                         |-> search index
                         |-> export/import
                         |-> operation log -> optional sync client -> self-hosted server
```

The UI never writes storage directly. Application services enforce invariants and commit a domain change plus its operation-log entry in one local transaction. Network availability is never on the local write path.

## Local runtime

- **Domain layer:** workspace, page, block, database, row, view, relation, comment, and attachment rules.
- **Application services:** commands, queries, transactions, authorization hooks, backlink maintenance, export/import, and migrations.
- **SQLite repository:** canonical local metadata/content, foreign keys enabled, WAL mode, and transactional migrations.
- **Attachment store:** content-addressed blobs below the workspace data directory; SQLite stores metadata and references.
- **Search:** SQLite FTS index derived from canonical records and rebuildable at any time.
- **Operation log:** durable, ordered local mutations for history and later sync. Snapshots are derived optimization artifacts.

## Optional server

The self-hosted server stores workspace membership, encrypted operation envelopes/blobs where client-side encryption is enabled, acknowledgements, and ephemeral presence. It must not be needed to open or edit a local replica. A future hosted service must run this same published server and protocol.

Collaboration transport, identity providers, and AI providers are adapters behind explicit interfaces. Disabling an adapter removes its network activity without changing the core data model.

## Repository boundaries

Recommended top-level ownership:

```text
apps/desktop       local desktop/web-shell UI
apps/server        optional self-hosted sync service
packages/domain    types, invariants, commands, operations
packages/storage   SQLite, files, migrations, search
packages/sync      protocol and reconciliation
packages/export    versioned import/export
docs               product, protocol, security, ADRs
```

Shared packages must not import UI or server code. The local application must build and test without the server package running.

## Reliability rules

- All identifiers are stable UUIDv7 values generated on the client.
- Timestamps are ISO 8601 UTC for interchange; ordering relies on operation identity/logical metadata, not wall clocks alone.
- Database and filesystem updates use a staged attachment write followed by a database commit; orphan staging files are recoverable and garbage-collected.
- Migrations are ordered, checksummed, forward-only scripts. A backup is created before destructive migrations.
- Unknown newer schema versions fail read-only with a clear message; they are never silently rewritten.
- Derived indexes and caches can be deleted and rebuilt from canonical data.

## Verification targets

Contract tests run each domain command against the local repository. Integration tests cover restart durability, forced-offline use, migration from every supported schema, attachment integrity, export/restore equivalence, and two-replica convergence when sync is introduced.
