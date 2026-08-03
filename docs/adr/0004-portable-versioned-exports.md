# ADR 0004: Portable, versioned exports

- Status: Accepted
- Date: 2026-08-04

## Decision

Treat a versioned full workspace bundle as a supported compatibility surface. It contains lossless structured JSON, readable Markdown, database CSV plus type manifests, attachment bytes, checksums, and reconstruction metadata. Imports validate and stage before committing.

## Consequences

Users can leave, audit backups, and restore without vendor infrastructure. Export schemas need documentation, fixtures, deterministic migrations, and round-trip tests. Markdown and CSV are readable projections; JSON is the lossless reconstruction format.
