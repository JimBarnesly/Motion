# Risks

| Risk | State | Mitigation / next evidence |
|---|---|---|
| Desktop shell depends on an external Node 24 executable and starts a process per IPC request | Open, critical | Bundle a persistent runtime or implement the service in Rust; benchmark repeated commands and remove the external deployment dependency before accepting the desktop milestone. |
| Browser and Tauri adapters still translate schema-v1 UI documents rather than using typed domain commands directly | Open, high | Keep validation/migration at the boundary, then move UI operations onto typed app-service commands and add packaged behavioural E2E coverage. |
| Native Linux desktop package is not locally verified | Open, high | Rust is installed, but this host lacks GTK/WebKit development packages. Install them with administrator access, then run locked Rust tests and package/restart/offline checks; native x86-64/ARM64 CI is configured as independent evidence. |
| Browser editor behavior remains unvalidated despite the headless editor model passing | Open, high | ADRs 0006-0008 settle Tiptap/ProseMirror, Yjs, and IDs; add IME, clipboard, keyboard, selection, drag/drop, migration, and accessibility tests. |
| Packaged UI-to-SQLite restart and crash recovery remain unverified | Open, high | The Tauri adapter reaches the canonical SQLite service and the canonical separate-process offline restart test passes; add packaged UI restart, concurrency, disk-full, and forced-termination tests. |
| Attachment database/file commit can tear across a crash | Mitigated, medium | Private same-root staging, metadata-first commit, atomic promotion, deterministic recovery, and promotion-failure injection are implemented. ADR 0010 remains provisional pending real process-termination coverage, fsync/no-follow hardening, multi-process rules, and streaming limits. |
| FTS5 correctness and latency are unmeasured at target scale | Open, medium | ADR 0011 accepts a rebuildable projection; benchmark 10,000 pages/100,000 blocks and test tombstones, reindex, tokenizer migrations, and index integrity. |
| Backup/export foundations may omit edge metadata at scale | Open, high | Publish canonical schema fixtures and compare full restore equivalence including attachments. |
| Sync design is unimplemented and convergence is unproven | Deferred, high | Do not ship sync until operation/Yjs property tests and checkpoints pass. |
| Encryption/key recovery is unimplemented | Deferred, high | Complete encryption ADR, prototype, threat-model review, rotation/recovery tests. |
| Permissions and malicious-member boundaries are unimplemented | Deferred, high | Central evaluator, denial tests, audit operations, conservative conflicts. |
| Accessibility has no full audit | Open, medium | Manual keyboard/screen-reader matrix plus automated checks. |
| Performance evidence may reflect toy fixtures | Open, medium | Run documented stress fixtures on representative packaged builds. |
| Dependency/licence and update supply-chain policy incomplete | Open, medium | Pin toolchains, generate SBOM, review licences, sign artifacts, document rollback. |
| Large attachments/imports can exhaust resources or traverse paths | Open, high | Streaming, quotas, canonical paths, archive limits, sanitisation tests. |
| Filesystem blob promotion and SQLite metadata commit are not fully atomic | Mitigated, medium | Committed metadata can be repaired from matching staging; rolled-back staging is removed, missing references and final orphans are reported. Final orphan deletion awaits an explicit retention/concurrency policy. |
| Naming collision with existing products may affect release | Open, medium | Perform legal/trademark review before public branding investment. |

Risks close only with measured evidence or an accepted ADR, not implementation claims.
