# ADR 0001: Local authoritative core

- Status: Accepted
- Date: 2026-08-04

## Decision

Every client holds an independently usable local SQLite database and attachment store. UI commands commit locally without contacting a server. Search, export, backup, and restore are local application services. Sync is an optional adapter over a durable operation log.

## Consequences

Offline use is complete and testable, and server failure does not block work. The application must own migrations, reconciliation, and local storage recovery. Server-only features cannot become prerequisites for editing.
