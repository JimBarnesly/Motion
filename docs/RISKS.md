# Risks

| Risk | State | Mitigation / next evidence |
|---|---|---|
| Web UI is a parallel schema-v1 localStorage application disconnected from core/storage/search/backup | Open, critical | Stop feature expansion; introduce one application-service contract, migrate browser data explicitly, and run behavioural persistence tests through it. |
| Imported web backup fields are only shallowly validated before HTML rendering | Open, critical | Reject invalid IDs/types/hierarchies, avoid string-built attribute markup, add hostile-backup/XSS fixtures before exposing restore. |
| Browser slice and core are not yet a packaged Linux desktop app | Open, high | ADR 0012 is provisional: run the Tauri spike on supported Ubuntu with Rust/WebKit prerequisites, then test packaged offline persistence. |
| Browser editor behavior remains unvalidated despite the headless editor model passing | Open, high | ADRs 0006-0008 settle Tiptap/ProseMirror, Yjs, and IDs; add IME, clipboard, keyboard, selection, drag/drop, migration, and accessibility tests. |
| SQLite/storage packages may not yet be wired through the UI | Open, high | ADR 0009 makes SQLite authoritative; choose Rust versus Node adapter using packaged benchmarks, then add multi-version migration, concurrency, disk-full, and UI restart tests. |
| Attachment database/file commit can tear across a crash | Open, high | ADR 0010 remains provisional; implement staging, atomic rename, recovery scan, streamed limits, and failure injection at each boundary. |
| FTS5 correctness and latency are unmeasured at target scale | Open, medium | ADR 0011 accepts a rebuildable projection; benchmark 10,000 pages/100,000 blocks and test tombstones, reindex, tokenizer migrations, and index integrity. |
| Backup/export foundations may omit edge metadata at scale | Open, high | Publish canonical schema fixtures and compare full restore equivalence including attachments. |
| Sync design is unimplemented and convergence is unproven | Deferred, high | Do not ship sync until operation/Yjs property tests and checkpoints pass. |
| Encryption/key recovery is unimplemented | Deferred, high | Complete encryption ADR, prototype, threat-model review, rotation/recovery tests. |
| Permissions and malicious-member boundaries are unimplemented | Deferred, high | Central evaluator, denial tests, audit operations, conservative conflicts. |
| Accessibility has no full audit | Open, medium | Manual keyboard/screen-reader matrix plus automated checks. |
| Performance evidence may reflect toy fixtures | Open, medium | Run documented stress fixtures on representative packaged builds. |
| Dependency/licence and update supply-chain policy incomplete | Open, medium | Pin toolchains, generate SBOM, review licences, sign artifacts, document rollback. |
| Large attachments/imports can exhaust resources or traverse paths | Open, high | Streaming, quotas, canonical paths, archive limits, sanitisation tests. |
| Naming collision with existing products may affect release | Open, medium | Perform legal/trademark review before public branding investment. |

Risks close only with measured evidence or an accepted ADR, not implementation claims.
