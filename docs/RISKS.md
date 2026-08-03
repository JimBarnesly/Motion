# Risks

| Risk | State | Mitigation / next evidence |
|---|---|---|
| Web UI is a parallel schema-v1 localStorage application disconnected from core/storage/search/backup | Open, critical | Stop feature expansion; introduce one application-service contract, migrate browser data explicitly, and run behavioural persistence tests through it. |
| Imported web backup fields are only shallowly validated before HTML rendering | Open, critical | Reject invalid IDs/types/hierarchies, avoid string-built attribute markup, add hostile-backup/XSS fixtures before exposing restore. |
| Browser slice and core are not yet a packaged Linux desktop app | Open, high | Integrate the validated Tauri baseline and test packaged offline persistence. |
| Lightweight editor lacks the required rich block behaviour | Open, high | Select ProseMirror/Tiptap via ADR; implement schema, commands, IDs, clipboard, and persistence tests. |
| SQLite/storage packages may not yet be wired through the UI | Open, high | Make SQLite authoritative; add restart, crash, migration, and disk-failure tests. |
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
