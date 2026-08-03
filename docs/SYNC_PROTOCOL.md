# Motion Sync Protocol

Status: design contract for the optional sync implementation. Local-only operation does not instantiate this protocol.

## Goals

Replicas accept writes offline, later converge without a central writer, retry safely, and retain enough information to explain conflicts. Transport is HTTPS/WebSocket, but correctness is defined by operation envelopes rather than connection state.

## Replica model

Each installation has a random `replicaId` and persistent signing/device identity. Sequence numbers increase transactionally with the local mutation. Duplicate operation IDs are idempotent.

Every durable structured-data operation uses this versioned envelope:

```json
{
  "envelopeVersion": "motion.operation/1",
  "operationId": "019...",
  "workspaceId": "019...",
  "replicaId": "019...",
  "replicaSequence": 42,
  "actorId": null,
  "entityType": "page",
  "entityId": "019...",
  "operationType": "page.rename",
  "logicalTimestamp": { "counter": 91, "replicaId": "019..." },
  "dependencies": { "019...": 41 },
  "payloadSchemaVersion": 1,
  "payload": {},
  "integrity": { "algorithm": "sha256", "digest": "...", "signature": null },
  "encryption": null
}
```

`actorId` is optional in single-user mode. Dependencies are a compact causal frontier, not wall-clock ordering. Integrity covers the immutable envelope and payload. When encrypted, the payload is ciphertext and routing fields are authenticated associated data. Validators reject malformed identities, sequence reuse with different bytes, invalid payload versions, unauthorized mutations, and integrity failures before application. Unknown valid operation types are retained durably for a newer client.

The initial merge model uses operation-based CRDT rules:

- entity existence uses add/tombstone records;
- scalar fields use causally ordered last-writer registers with operation ID as deterministic tie-breaker;
- ordered children use stable fractional position identifiers;
- sets use observed-remove semantics;
- document bodies use Yjs updates behind the domain API; structured entities do not use Yjs as a replacement for typed operations;
- schema changes are normal operations, and incompatible property edits preserve both values for user resolution.

No merge rule may discard an attachment blob or unrecognized payload silently.

## Document body updates

Each document has a stable `documentId`, document schema version, append-only Yjs update records, and periodic snapshots. An update record carries its update ID, document/workspace IDs, origin replica and optional actor, Yjs state-vector context, update bytes or encrypted bytes, creation metadata, and integrity metadata. Updates are idempotent and commutative; receiving order must not affect the resulting Yjs document.

Snapshots contain a full Yjs state update plus the state vector and the durable operation frontier included. They accelerate bootstrap but do not become a second source of truth. Block IDs remain stable attributes in the editor schema, and conversion between editor state and domain references must preserve unknown nodes.

Compaction may remove superseded update records only when a snapshot has been verified by reconstruction and every replica covered by the retention policy has acknowledged a checkpoint at or beyond that snapshot. Offline or retired replicas require an explicit administrative retirement record; elapsed time alone is not proof that an update is safe to discard. A replica behind the retained frontier receives a complete snapshot and then post-checkpoint updates. Failed verification leaves the original updates untouched.

## Deterministic conflict rules

Conflict behavior is versioned and fixture-tested:

- **Concurrent rename or scalar edit:** causally later value wins; concurrent values use logical timestamp then operation ID as a stable tie-breaker. The losing value is retained in revision/conflict metadata.
- **Concurrent moves:** resolve parent and sibling position independently using causal order and stable tie-breakers; reject cycles, then place a rejected cyclic move at the nearest valid prior parent and record a conflict.
- **Delete versus edit:** tombstone wins for visibility; edits remain attached to the tombstoned entity so restore can recover them.
- **Collection schema versus property values:** values remain keyed by property ID. Incompatible concurrent type changes do not coerce destructively; preserve the original typed value and create a `ConflictRecord`.
- **Select option deletion versus assignment:** deletion hides the option but does not erase assignments; the value is marked unavailable until restored or explicitly replaced.
- **Relation changes:** observed-remove set semantics apply. Reciprocal repair is deterministic and cardinality violations produce explicit conflicts rather than silently dropping arbitrary targets.
- **Attachment metadata and blobs:** metadata conflicts follow scalar rules; distinct hashes are distinct immutable blobs and are never overwritten.

Conflicts which cannot be resolved without loss remain queryable `ConflictRecord` entities. User resolution is itself an ordinary operation.

## Exchange

1. Client authenticates and sends protocol version, workspace ID, replica ID, and acknowledged causal frontier.
2. Server returns authorized protocol range, missing operation envelopes, required blob hashes, and its receipt frontier.
3. Client validates signatures/schema, stores operations durably, applies them transactionally, and returns acknowledgement.
4. Client uploads its missing envelopes in bounded batches; blobs use resumable hash-addressed transfer.
5. Both sides repeat until frontiers match. Presence uses a separate ephemeral channel and is never part of durable convergence.

An envelope is versioned independently from its encrypted payload. With client-side encryption enabled, routing fields are minimized and authenticated as associated data; the server stores ciphertext and cannot merge content. Clients perform merge after decryption.

## Compatibility and recovery

- Protocol versions use `major.minor`; major mismatch refuses sync without altering local data.
- Unknown operation kinds are stored but not acknowledged as applied until a compatible client exists.
- A corrupt signature, sequence reuse, hash mismatch, or unauthorized workspace causes quarantine and an audit event.
- Snapshot bootstrap includes a signed snapshot frontier; subsequent operations replay after that frontier.
- Server loss is recoverable by seeding a new server from any complete replica. Server state is not the sole source of truth.

## Permissions

Authorization is checked when accepting and serving operations. Membership/role changes are signed administrative operations. Revocation stops future access but cannot erase plaintext already present on an authorized device. E2EE group-key rotation is required after membership removal.

## Required tests

Property tests randomly reorder, duplicate, batch, and delay operations and assert convergence. Integration tests cover concurrent text edits, moves, deletes, property-schema changes, interrupted blob upload, revoked devices, server replacement, protocol mismatch, and encrypted relay mode.
