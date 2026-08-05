# Notion feature-parity register

Owner: Product Director

Decision authority: Managing Director

Last reviewed: 2026-08-05

## Purpose

This register tracks whether Motion covers the user outcomes available in
Notion without copying Notion branding, wording, assets, or interface patterns.
Parity means comparable capability, not identical implementation. Motion's
offline local mode, structured portable data, and no-account baseline remain
product constraints even where Notion takes a cloud-first approach.

Statuses:

- **Implemented** — working code exists, with repository evidence.
- **Partial** — a usable slice exists but the outcome is incomplete.
- **Specified** — requirements or architecture exist; the capability is not shipped.
- **Untracked** — no sufficient Motion requirement or implementation was found.
- **Out of baseline** — deliberately excluded from the local-first baseline; reconsider only by Managing Director decision.

## Current register

| Capability area | Motion status | Repository evidence | Product gap / next decision |
| --- | --- | --- | --- |
| Nested pages and navigation | Partial | `PAGE-001`–`PAGE-004`; Web vertical slice in `STATUS.md` | Complete reorder, move, archive/delete UX and packaged persistence acceptance. |
| Rich block editor | Partial | `BLOCK-001`–`BLOCK-009`; editor ADR 0006 | Replace the Web-v1 compatibility editor with React + Tiptap/ProseMirror and complete the initial block set, selection, clipboard, drag, IME, and accessibility. |
| Links, mentions, backlinks, deep links | Partial | `LINK-001`–`LINK-007`; canonical link-index service | Finish mention entry, broken/archived states, previews, and block deep-link UX. |
| Search | Partial | `SEARCH-001`–`SEARCH-004`; SQLite FTS package | Add full filters, snippets/highlighting, recent-search controls, and packaged performance evidence. |
| Files and media | Partial | `BLOCK-003`, `BLOCK-009`; content-addressed attachment storage | Stream large files, enforce limits, and implement media/PDF blocks and interruption UX. |
| Databases and records-as-pages | Partial | `COLL-001`–`COLL-005`; table slice | Complete property types, record-page UX, schema editing, ordering, and deletion semantics. |
| Table, list, board, calendar, gallery, timeline views | Partial | `VIEW-001`–`VIEW-004`; milestones M3–M4 | Table is partial; list/board/calendar/gallery/timeline require complete saved-view UI and tests. |
| Chart, form, and dashboard views | Specified | `VIEW-002`; milestones M4–M5 cover chart/form contracts | Add dashboard view to requirements; decide priority after core views. Current Notion documentation treats dashboards as a view composed of widgets. |
| Filters, sorts, groups, formulas | Partial | `FILTER-001`–`FILTER-002`, `SORT-001`, `FORM-001`–`FORM-004`; formula package | Connect the typed engines to complete view UX; add formula-result filters and grouping acceptance. |
| Relations and rollups | Specified | `REL-001`–`REL-007`; milestone M5 | Implement after collection/view foundations; preserve deterministic local semantics. |
| Templates and reusable page/database structures | Untracked | Template origin exists in `PAGE-002`, but no complete template workflow requirement | Product requirement needed for creation, application, editing, and export of templates. |
| Comments, discussions, history, and presence | Specified | Roadmap stage 4; milestones M6–M7 | Define local comments/history before optional live collaboration; presence remains remote-only. |
| Sharing, guests, teams, and permissions | Specified | `PAGE-005`, `PERMISSIONS.md`, roadmap stage 4 | Requires Managing Director scope decision because accounts and remote authorization cannot weaken local-only mode. |
| Projects, tasks, dependencies, and workload | Partial | Task blocks and future dependency/progress properties are specified | Define first-class project/task views and dependency/workload outcomes rather than relying only on generic databases. |
| Database automations, buttons, and webhooks | Untracked | AI/agent mutation controls exist, but no user automation model | Architecture and safety requirements needed before implementation. Keep outbound actions explicit and disabled by default. |
| Import from Notion and other tools | Specified | `PORT-001`–`PORT-004`; import pipeline design | Add a Notion import compatibility matrix and fixtures; do not claim import parity until round-trip evidence exists. |
| Export, backup, and restore | Partial | Structured JSON/Markdown/CSV export and verified backup service | Finish end-user flows, attachments/static HTML, hostile-input coverage, and packaged restore drills. |
| Offline desktop use | Partial, Motion differentiator | Tauri shell, canonical SQLite service, `LOCAL-001`–`LOCAL-004` | Pass installed-package launch/restart/network-denied acceptance on supported hosts. |
| Mobile apps | Out of baseline | No mobile milestone | Managing Director decision required before adding a client platform. |
| Calendar and mail products | Out of baseline | No product requirements | Treat as separate products/integrations, not automatic workspace parity. |
| AI writing, research, connectors, and agents | Specified | `AGENT-001`–`AGENT-005`; milestone M8 | Optional only; require explicit consent, bounded context, preview/approval, and provider isolation. |
| Integrations, public API, embeds, and MCP | Partial | Optional MCP contract exists; bookmark/local-file extensions specified | Define API/integration scope and offline behaviour. Remote embeds must never load silently. |
| Enterprise administration, audit, SSO, and compliance | Out of baseline | Permissions/security foundations only | Separate enterprise programme requiring Managing Director approval. |

## Product priorities proposed for approval

1. **P0 — close the trustworthy local workspace loop:** packaged durability,
   React/Tiptap editor, complete page/block interaction, search, attachments,
   export, and restore (M0–M2).
2. **P1 — reach database workflow parity:** complete collection properties,
   table/list/board/calendar/gallery/timeline, filters/sorts/groups, relations,
   rollups, formulas, templates, and import compatibility (M3–M5).
3. **P2 — add team outcomes without compromising local mode:** comments,
   history, permissions, optional sync/collaboration, and project/task workflows.
4. **P3 — separately approve expansion areas:** automations, dashboard/form/chart,
   AI/connectors, mobile, enterprise administration, Calendar, and Mail.

Managing Director decision requested: approve this sequencing and confirm that
"feature parity with Notion" targets the core workspace product first, while
Notion Calendar, Notion Mail, enterprise administration, and cloud-only AI
connectors remain separate scope decisions.

The first release-level application of this sequence is the ranked
[`BACKLOG_0.1.1.md`](BACKLOG_0.1.1.md) backlog.

## Monitoring cadence

- Review Notion's official help centre and release notes monthly.
- Add or revise one row for each material competitor capability change.
- Link every Motion status change to implementation and test evidence.
- Route scope, priority, or local-first conflicts to the Managing Director.
- Product may open discovery/definition work; implementation ownership must be
  assigned through the project office to avoid duplicating another director.

## Competitor evidence checked

Checked 2026-08-05 against Notion's public Help Center:

- Database views: <https://www.notion.com/help/category/database-views>
- Charts and dashboard views: <https://www.notion.com/help/charts>
- Forms: <https://www.notion.com/help/forms>
- Database automations: <https://www.notion.com/help/database-automations>
- Enterprise search: <https://www.notion.com/help/enterprise-search>
- AI connectors: <https://www.notion.com/help/notion-ai-connectors>

This is a capability baseline, not a claim that every Notion feature has been
exhaustively enumerated. The Notion connector was not installed, so the review
used public documentation only.
