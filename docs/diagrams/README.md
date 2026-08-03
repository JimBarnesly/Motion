# Architecture diagrams

These Mermaid files are editable architecture sources. Keep them aligned with
the ADRs and protocol documents whenever process, storage, trust, or data-flow
boundaries change.

- `local-runtime.mmd` — local-only application data flow
- `desktop-boundaries.mmd` — desktop process and privilege boundaries
- `sync-sequence.mmd` — optional offline-first reconciliation
- `encryption-key-flow.mmd` — optional client-side encryption boundary
- `backup-restore.mmd` — verified backup and restore pipeline
- `permissions.mmd` — command authorization flow
- `import-pipeline.mmd` — untrusted import staging
