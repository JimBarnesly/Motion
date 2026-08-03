# Node SQLite + FTS5 spike

## Verdict: VALIDATED

Question: Can Node 24's built-in `node:sqlite` provide the minimum local storage primitives for Motion: migrations, page metadata, durable document updates, FTS5, attachments, rollback, and restart integrity?

Run:

```sh
npm test
npm run demo
```

This is disposable feasibility code, not a production storage layer.

Evidence captured on Node `v24.18.0`:

```text
✔ migration, metadata, updates, FTS5, attachments and rollback
✔ committed state survives a complete process restart
✔ WAL recovery discards an uncommitted transaction after SIGKILL
tests 3; pass 3; fail 0
```

What worked:

- Idempotent schema migration and version tracking.
- Transactional page metadata, binary document updates, and FTS5 indexing.
- Ranked FTS5 lookup with snippets.
- SHA-256-addressed attachment write/read with byte equality.
- Explicit rollback removed all partial changes.
- A committed update was read by a fresh Node process.
- After a process was killed during an open WAL transaction, reopening discarded the uncommitted row and `PRAGMA integrity_check` returned `ok`.

Limitations and surprises:

- `DatabaseSync` is synchronous, so production code must keep database work off latency-sensitive UI/typing paths or bound transaction size carefully.
- This spike does not benchmark large workspaces, test migration upgrades beyond version 1, coordinate concurrent writers, or make attachment metadata/file creation atomic across the SQLite/filesystem boundary.
- `node:sqlite` currently emits an experimental warning on some Node 24 builds; this host did not emit one.

Recommendation: proceed with a Node built-in SQLite adapter for further prototyping. Before production commitment, benchmark FTS5 and write latency at target scale, design crash-safe attachment staging, and test real multi-version migrations and concurrent access.
