# Motion agent instructions

- Preserve a complete offline local mode with no account or network dependency.
- Do not copy Notion branding, assets, wording, or exact interface patterns.
- Persist versioned structured data; never make rendered HTML the source of truth.
- Keep optional sync, collaboration, encryption, and AI behind documented interfaces.
- Never add telemetry or silent remote resource fetching.
- Add migrations for persisted schema changes and tests for domain behaviour.
- Exports must retain enough information to reconstruct a workspace.

## Autonomous project-office runs

When assigned a task from `.project-office/queue.json`, also read and obey `../OFFICE_OPERATING_CONTRACT.md`. Do not broaden the task or edit a shared checkout concurrently.
