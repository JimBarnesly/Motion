# Motion Sync Protocol

Status: design contract for the optional sync implementation. Local-only operation does not instantiate this protocol.

## Goals

Replicas accept writes offline, later converge without a central writer, retry safely, and retain enough information to explain conflicts. Transport is HTTPS/WebSocket, but correctness is defined by operation envelopes rather than connection state.

## Replica model

Each installation has a random `replicaId` and persistent signing/device identity. Each operation has `(replicaId, sequence)`, a UUID operation ID, workspace ID, causal summary, operation kind, and payload. Sequence numbers increase transactionally with the local mutation. Duplicate operation IDs are idempotent.

The initial merge model uses operation-based CRDT rules:

- entity existence uses add/tombstone records;
- scalar fields use causally ordered last-writer registers with operation ID as deterministic tie-breaker;
- ordered children use stable fractional position identifiers;
- sets use observed-remove semantics;
- rich text uses a sequence CRDT boundary hidden behind the domain API;
- schema changes are normal operations, and incompatible property edits preserve both values for user resolution.

No merge rule may discard an attachment blob or unrecognized payload silently.

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
