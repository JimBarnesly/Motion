# Product Requirements Document

Motion is an original, open, local-first workspace for documents, nested pages, linked knowledge, tasks, attachments, search, and lightweight databases. The local workspace is complete without an account, subscription, server, or network.

## Users and outcomes

- Individuals can capture, structure, find, link, export, and restore their knowledge offline.
- Self-hosters can later synchronise devices without adopting a proprietary service.
- Teams can later collaborate through the same documented, self-hostable protocol.

## First release

The first release is a single-user Linux desktop application. Its acceptance path is: create a workspace; create and nest pages; edit and reorder stable-ID blocks; link pages and inspect backlinks; create a table collection; search; attach a file; restart without loss; export; and restore into a new workspace. Network denial must not affect this path.

## Requirements

- Local durable storage, explicit migrations, tombstones, and transaction-confirmed save state.
- Structured, versioned page, block, collection, view, relation, and attachment data.
- Stable-ID links unaffected by titles or hierarchy changes, with a materialised link index.
- Keyboard-complete, WCAG 2.2 AA-oriented interaction and accessible drag alternatives.
- Markdown, CSV, attachment, and lossless canonical JSON exports.
- No telemetry, external fetching, remote AI, or remote services by default.
- Unknown future blocks and metadata survive read/write and export.

## Deferred

Multi-device sync, collaboration, mobile clients, plugin execution, hosted accounts, and AI are later milestones. They must remain optional. See `PRODUCT.md`, `ROADMAP.md`, and the specifications for detail.
