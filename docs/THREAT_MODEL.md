# Motion Threat Model

Status: required design gate; this document does not claim that mitigations are implemented.

## Scope and security objectives

This model covers the local desktop application, local vault and attachment store, imports and previews, optional plugins, optional AI/MCP integrations, and the future self-hosted sync service. Motion must protect content confidentiality, integrity, availability, authorization boundaries, recoverability, and the user's ability to operate locally without a vendor.

The local-only application is the first security boundary. Remote collaboration must not begin until the remote-specific acceptance gates below are satisfied.

## Assets and trust boundaries

Protected assets include workspace content, attachments, credentials, encryption and recovery keys, operation history, permissions, backups, exports, search indexes, and metadata that reveals workspace activity.

Trust boundaries are:

- the locked device versus the unlocked user session;
- canonical storage versus imported or downloaded content;
- the client versus an optional sync server and its administrator;
- one workspace member versus another;
- core code versus dependencies and plugins;
- Motion versus AI providers and MCP clients;
- plaintext processing versus encrypted storage and transport.

Workspace content, imported documents, embeds, AI output, and MCP-returned content are always untrusted data, never executable instructions.

## Threats and required mitigations

| Threat | Abuse or failure | Required mitigations |
|---|---|---|
| Lost or stolen device | Offline access to a local vault, tokens, or cached keys | Recommend OS disk encryption; optional application passphrase with a memory-hard KDF; OS credential store for secrets; short-lived sessions; explicit lock; documented remote-token revocation; encrypted backups. State clearly that an unlocked session can access plaintext. |
| Stolen local vault | Database or attachment files are copied and inspected or altered | Authenticated encryption when enabled; independently authenticated attachment chunks; integrity-checked manifests; no keys beside ciphertext; fail closed on authentication errors; do not leak plaintext into logs, temporary files, or crash bundles. |
| Malicious sync server | Server reads content, rewrites history, drops or replays operations, or withholds data | Optional client-side encryption; authenticated operations and monotonic/checkpoint validation; idempotency and replay detection; local authoritative copy; visible sync/conflict state; export independent of server; never treat server acknowledgement as local durability. Metadata leakage must be documented. |
| Compromised server administrator | Administrator accesses database, object storage, backups, credentials, or audit data | Least-privilege service identities; encrypted secrets; tenant/workspace isolation; client-side encryption option; security audit records; backup encryption; key rotation; no plaintext document content in operational logs. |
| Malicious workspace member | Unauthorized reads/writes, permission escalation, destructive bulk edits, poisoned comments or links | Authorize every operation against workspace and object scope; separate read/write/admin capabilities; validate membership changes; immutable actor attribution; rate limits; recoverable history/tombstones; hostile-member integration tests. |
| Malicious imported document | Active content executes, formulas or links escape the importer, or crafted input corrupts data | Parse as data; prohibit script execution and JavaScript `eval`; sanitize HTML/SVG/Markdown; preserve unsupported content inertly; resource limits and fuzz tests; staged transactional import with preview and rollback. |
| Script injection through embeds or previews | HTML, SVG, Markdown, URLs, or media run script or navigate privileged contexts | No automatic remote fetch; strict sanitization and CSP; sandbox preview processes/origins; block active SVG/HTML by default; safe URL schemes; no privileged application bridge in preview contexts. |
| Path traversal and unsafe filenames | Attachment/import paths overwrite arbitrary files or escape an export root | Generate internal content-addressed names; retain display names as metadata; canonicalize and validate extraction paths; reject absolute paths, parent traversal, device names, links, and archive entries escaping the staging root. |
| Oversized files or decompression bombs | Memory, disk, CPU, or inode exhaustion | Configurable compressed/uncompressed size, ratio, count, depth, time, and memory limits; stream large files; preflight free space; cancellable staging; atomic cleanup on failure. |
| Dependency or build compromise | Malicious package, update, installer, or artifact gains code execution | Lock dependencies; review licences and provenance; minimal dependency set; CI vulnerability/secret scanning; reproducible build metadata and checksums; signed releases when distribution starts; documented update trust path. |
| Plugin abuse | Plugin reads unrelated content/files, performs network access, or bypasses domain validation | Plugins disabled by default; signed/identified packages; capability manifest; per-workspace grants; process/WebAssembly sandbox where practical; domain-command-only writes; network and filesystem denied unless separately granted; revocation and audit. |
| AI prompt injection | Page text instructs an agent to disclose data, use tools, or bypass approval | Treat retrieved text as quoted untrusted content; explicit context selection; provider/domain allow-list; separate model output from tool authorization; preview mutations; user approval; scoped, revocable credentials; never send a whole workspace implicitly. |
| MCP tool abuse | A client enumerates all content, mutates broadly, or reaches the filesystem | Separate read/write scopes; narrow workspace/page/tool grants; local authenticated transport; explicit revocation; argument validation; pagination and rate limits; domain commands for writes; no generic shell or filesystem tools; audit actor and affected objects. |
| Secret leakage | Tokens, keys, page content, filenames, or prompts enter logs, exports, support bundles, clipboard, or telemetry | Central redaction; secret scanning; no telemetry by default; preview support-bundle contents; exclude credential stores from exports; explicit plaintext warnings; clipboard actions initiated by users; test fixtures containing canary secrets. |
| Backup or migration failure | Corruption or a bad migration destroys the only good copy | Transactional migrations; pre-migration recovery copy; versioned/checksummed backups; restore into staging or a new workspace; automated restore-and-compare tests; never overwrite the sole verified backup. |

## Security acceptance gates

### Before a local desktop release

- Import and archive traversal, script injection, malformed data, and resource-exhaustion fixtures fail safely without modifying canonical data.
- Secrets and representative page content do not appear in default logs, crash reports, or support bundles.
- Backup restore is automated and compares hierarchy, blocks, collections, links, metadata, unknown fields, and attachment hashes.
- Encrypted-vault authentication failure is fail-closed and recovery/key-loss behavior is documented.
- Dependency, licence, secret, and static checks run in CI with triage rules.
- Network-denied tests prove that local creation, editing, search, attachments, export, backup, and restore remain functional.

### Before plugins, AI, or MCP ship

- Capability grants are explicit, scoped, inspectable, and revocable.
- Read and write permissions are separate; all writes use validated, undoable domain commands.
- Prompt-injection fixtures cannot expand selected context, invoke unapproved tools, or bypass mutation approval.
- Plugin and MCP processes cannot access arbitrary local files or networks under default permissions.
- Audit records identify the integration, actor, command, and affected object IDs without recording document bodies or secrets.

### Before any remote collaboration implementation is released

- The sync protocol and cryptographic format receive independent review and have versioned interoperability fixtures.
- Authorization-boundary tests cover cross-workspace IDs, revoked members/devices, stale sessions, object storage, comments, presence, and bulk operations.
- Replay, duplicate, reordering, truncation, rollback, offline conflict, and malicious-server tests produce deterministic, visible outcomes without silent data loss.
- TLS is mandatory beyond loopback; session, origin, CSRF, rate-limit, and credential-rotation controls are tested.
- Client-side encryption tests prove the server can reconcile/store ciphertext without workspace plaintext, while documenting unavoidable metadata leakage.
- Server backup and restore, disaster recovery, key rotation, and replica checkpoint/compaction safety are exercised end to end.

## Review triggers

Review this model whenever a new network destination, parser, previewer, property language, plugin capability, AI provider, MCP tool, encryption format, sync operation, permission, import format, or executable updater is introduced.
