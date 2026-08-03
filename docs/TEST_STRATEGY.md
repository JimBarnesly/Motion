# Test Strategy

## Layers

- Unit: domain commands, ordering, links/backlinks, property/filter/sort/formula evaluation, serialisation, operation application, permissions, hashing, and conversion.
- Property-based: sync convergence/idempotence, ordering keys, formula invariants, relation integrity, and import/export round trips.
- Integration: SQLite transactions/migrations, FTS indexing, attachment storage, editor persistence, crash recovery, backup/restore, authentication, sync, permissions, and encryption boundaries.
- End-to-end: create/reopen local workspace; nested pages and blocks; links/backlinks; title/body search; attachments; collections/filter/sort; export/restore; network-blocked use; later two-replica edits and self-host deployment.

CI must run formatting/type checks, unit/integration tests, production builds, licence/dependency checks, and a smoke E2E path. Release gates add migration fixtures, backup restore comparison, accessibility/manual checklists, security review, and reproducible packaging.

Tests use real temporary stores and deterministic fixtures; product UI must not rely on fake content. Failures and skipped suites remain visible.

Current packages contain focused tests for core, web, storage, search, formula, backup, and observability. Full desktop E2E, Playwright, property-based convergence, failure injection, accessibility, and release matrices are not complete.
