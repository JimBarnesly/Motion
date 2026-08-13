# Motion — Notion feature-parity target checklist

Status: working product-destination checklist
Owner: Product / Engineering
Last reviewed: 2026-08-13

## Purpose

This checklist describes the broad Notion-style workspace capabilities Motion is aiming to provide. It is a product-destination checklist, not a claim that every listed feature is implemented and not a promise that every item belongs in the next release.

Motion will deliver these capabilities through bounded, dependency-ordered milestones. A checked item requires canonical implementation and exercised evidence; an enum, interface, design document, or UI mock alone is not sufficient.

Motion must remain independently designed. Do not copy Notion branding, assets, wording, proprietary content, or exact interface patterns.

## Status legend

- [x] Implemented and exercised in the repository. Package/release acceptance may still be separately open.
- [~] Partial: a usable or foundational slice exists, but the destination behavior is incomplete.
- [ ] Planned: part of the product destination but not yet complete.
- [!] Explicitly excluded from the parity target.

## Product boundaries

- [x] Offline-first operation without requiring an account, server, internet connection, telemetry, or provider account.
- [x] Canonical, versioned structured workspace data; rendered HTML is never authoritative.
- [x] Linux desktop is the initial supported packaged platform.
- [ ] Optional private multi-device synchronization without weakening local-only operation (V2.0).
- [ ] Optional self-hosted collaboration after local correctness and sync foundations are complete (V2.0).
- [ ] Third-party integrations, connectors, external automations, webhooks, and public integration APIs are a V1.5 destination and are excluded from V1.0.
- [ ] Optional AI writing, search, assistants, agents, and MCP with local/cloud provider choice are a V3.0 destination and are excluded from V1.0–V2.0.
- [!] Separate adjacent products such as an email client or standalone calendar service are excluded; calendar database views remain included.
- [!] Motion will not reproduce Notion branding or its exact interface.

---

## 1. Workspace, pages, and navigation

- [x] Stable page identity independent of title or hierarchy.
- [x] Create and rename pages.
- [x] Nested pages and hierarchical navigation.
- [x] Move and reorder pages without breaking stable links.
- [x] Favourite pages.
- [x] Reversible trash and restore.
- [~] Permanent deletion with explicit consequences and link handling.
- [~] Breadcrumb navigation and recent navigation history.
- [~] Page icons and covers.
- [ ] Custom workspace home/start page.
- [ ] Page templates and template-origin tracking.
- [ ] Duplicate pages and subtrees with deterministic new identities.
- [ ] Lock a page against accidental editing.
- [ ] Archive states distinct from trash where applicable.
- [ ] Sidebar sections for favourites, private/shared areas, templates, and trash.
- [ ] Keyboard-first page switcher and command navigation.
- [ ] Configurable page width, typography, and display preferences.

## 2. Block editor and writing

### Core text blocks

- [x] Paragraphs.
- [x] Heading levels 1–3.
- [x] Bulleted lists.
- [x] Numbered lists.
- [x] Task/checkbox items.
- [x] Quotes.
- [x] Dividers.
- [x] Code blocks.
- [~] Inline code and rich inline marks.
- [~] Links in text.
- [ ] Bold, italic, underline, strikethrough, colour, and highlight.
- [ ] Superscript and subscript where accessible.
- [ ] Equations and mathematical notation.

### Structural and media blocks

- [~] Toggles and nested content.
- [~] Callouts.
- [x] Child-page links.
- [x] Page mentions and stable wiki links.
- [~] Date mentions.
- [~] File attachments.
- [~] Images with durable local storage and alt text.
- [~] Bookmarks with explicit offline-safe preview behavior.
- [~] Simple tables.
- [x] Collection/database view blocks in the canonical model.
- [ ] Audio blocks.
- [ ] Video blocks.
- [ ] PDF/document blocks.
- [ ] Table of contents.
- [ ] Breadcrumb block.
- [ ] Synced/reusable blocks.
- [ ] Template button or repeatable block template.
- [ ] Columns and multi-column page layout.
- [ ] Canvas/freeform spatial content as a later workspace surface.

### Editing behavior

- [x] Stable block identities.
- [x] Create, update, transform, move, indent, outdent, duplicate, and delete through typed canonical commands.
- [x] Markdown shortcuts for common block forms.
- [x] Multiline Markdown paste into structured blocks.
- [x] Undo and redo for canonical editor changes.
- [~] Slash-command block insertion.
- [~] Drag-and-drop block reordering with keyboard alternatives.
- [~] Multi-block selection.
- [~] Copy, cut, paste, and duplicate multi-block selections.
- [ ] Copy selected content as Markdown.
- [ ] Move selected blocks between pages.
- [ ] Dependable IME/composition editing.
- [ ] Large-document virtualization without losing selection or accessibility.
- [x] Unknown/imported block payloads survive round trips without silent loss.
- [x] Honest unsupported-block placeholders.

## 3. Links, mentions, and knowledge graph

- [x] Stable-ID page links that survive rename and move.
- [x] `@` page mention selection.
- [x] `[[wiki link]]` entry resolved to stable identities.
- [x] Outgoing links.
- [x] Backlinks.
- [x] Block-level deep links and copyable internal URLs.
- [x] Live, trashed, and missing-target states.
- [~] Link previews.
- [~] Links between pages, databases, and record pages.
- [ ] Unlinked mention discovery.
- [ ] Page aliases.
- [ ] Block references/transclusion.
- [ ] Graph view over the local link index.
- [ ] Reusable synced blocks with stable source identity.

## 4. Search and discovery

- [x] Local indexed search across page titles and body blocks.
- [x] Search record property values.
- [x] Search attachment filenames.
- [x] Deterministic result ordering and stable navigation targets.
- [~] Snippets and highlighted matches.
- [~] Full keyboard result navigation.
- [ ] Filters by workspace, content type, collection, property, date, and link direction.
- [ ] Recent-search history that is local, optional, disableable, and clearable.
- [ ] Saved searches.
- [ ] Search index diagnostics, integrity verification, and user-invoked rebuild.
- [ ] Large-workspace performance evidence against published fixtures.

## 5. Databases and records

- [x] Every record is also a normal page with block content.
- [x] Stable collection, record, property, and view identities.
- [x] Shared canonical records across saved views.
- [x] Create and edit records through typed commands.
- [x] Reversible record trash.
- [~] Property creation, rename, visibility, column width, and per-view order.
- [ ] Canonical property-definition reorder.
- [ ] Property validation metadata.
- [ ] Property tombstones preserving historic interpretation after deletion.
- [ ] Populated type-conversion preview and explicit consequences.
- [ ] Property deletion preview and recoverable consequences.
- [ ] Record/page templates.
- [ ] Default values where type-safe and deterministic.
- [ ] Required-property and validation-rule configuration.
- [ ] Bulk record editing.
- [ ] Duplicate records with new stable identities.
- [ ] Import records from CSV using staged preflight.
- [~] Export records to CSV plus reconstruction metadata.

### Initial property types

- [x] Title identity and canonical record title.
- [~] Plain text.
- [~] Rich text.
- [x] Number validation and editing.
- [x] Checkbox validation and editing.
- [~] Select options and option membership validation.
- [~] Multi-select options and membership validation.
- [~] Status options and membership validation.
- [~] Date.
- [~] Date range.
- [~] URL with safe semantic validation.
- [~] Email with semantic validation.
- [~] Phone with semantic validation.
- [~] Files backed by canonical attachment identities.
- [ ] Created time as system-managed metadata.
- [ ] Updated time as system-managed metadata.
- [ ] Created by as system-managed metadata.
- [ ] Updated by as system-managed metadata.

### Extended property types

- [ ] Person/member.
- [ ] Relation.
- [ ] Rollup.
- [~] Formula parser/evaluator foundation.
- [ ] Formula property integrated into records, views, filters, and sorts.
- [ ] Unique identifier.
- [ ] Location with explicit coordinates and optional label.
- [ ] Duration.
- [ ] Progress.
- [ ] Dependency.
- [ ] Action/button property using bounded local commands only.
- [ ] Computed backlinks.

## 6. Saved database views

### Shared lifecycle and configuration

- [x] Create saved views.
- [x] Select and persist the active view locally.
- [x] Rename/update saved views through canonical commands.
- [x] Duplicate saved views.
- [x] Reorder and delete saved views.
- [x] Protect the final renderable view from deletion.
- [x] Independently persist visible properties and property order.
- [x] Independently persist column widths.
- [x] Independently persist filters and sorts.
- [x] Nested typed `AND`/`OR`/`NOT` filter representation.
- [x] Deterministic multi-clause sorting foundation.
- [~] Type-aware operators across every applicable property type.
- [~] Empty/not-empty and explicit null positioning.
- [ ] Relative-date filters.
- [ ] Manual record order.
- [ ] Grouping and subgrouping.
- [ ] View permissions and personal/shared view scope when collaboration exists.
- [ ] Large-view virtualization and deterministic limits.

### View types

- [x] Table renderer.
- [x] List renderer.
- [ ] Board renderer with grouping, card order, and validated group moves.
- [ ] Calendar renderer with configured date property and deterministic undated records.
- [ ] Gallery renderer with card preview and property configuration.
- [ ] Timeline renderer with validated start/end ranges and resize/move controls.
- [ ] Chart renderer with an accessible source-data alternative.
- [ ] Feed renderer as a deterministic local record presentation.
- [ ] Map renderer using explicit stored coordinates, no silent tile/geocoding request, and an equivalent list/table path.
- [ ] Form view for validated local record submission.

### Pointer and keyboard parity

- [x] Column keyboard reordering.
- [x] Column drag reordering through the same saved-view command.
- [~] Property-definition drag and keyboard reordering.
- [ ] Board card drag and keyboard moves through the same property mutation.
- [ ] Calendar/timeline drag and keyboard date changes through the same validated mutation.
- [ ] Discoverable drop targets and assistive-technology announcements.

## 7. Advanced database workflows

- [ ] One-way relations using stable record identities.
- [ ] Optional reciprocal relations updated atomically.
- [ ] One-to-one, one-to-many, and many-to-many limits.
- [ ] Explicit deleted/unavailable relation-target states.
- [ ] Relation filters and sorts.
- [ ] Rollup count, count values, count unique, sum, average, min, max, earliest/latest, percent checked, and original values.
- [ ] Rollup missing/deleted-target semantics.
- [ ] Relation/rollup dependency cycle detection.
- [ ] Versioned formula language with explicit null/error semantics.
- [ ] Numeric, string, Boolean, and date formula operations.
- [ ] Stable property-ID references in formulas.
- [ ] Formula dependency graph and cycle handling.
- [ ] Database templates.
- [ ] Linked views of an existing database.
- [ ] Filtered linked views embedded on other pages.

## 8. Templates and repeatable workflows

- [ ] Page templates.
- [ ] Database record templates.
- [ ] Default database template.
- [ ] Template galleries stored locally.
- [ ] Duplicate template content with deterministic identity remapping.
- [ ] Recurring/repeating template creation using local schedules.
- [ ] Buttons that create or update bounded local content with a visible preview.
- [ ] Third-party automation actions through the explicit V1.5 connector permission boundary.

## 9. Files and media

- [x] Content-addressed local attachment storage.
- [x] Bounded file ingestion with integrity hashes.
- [x] Keyboard selection and file-drop ingestion share one canonical path.
- [x] Missing/corrupt file states are explicit.
- [x] Attachments survive verified backup and restore.
- [~] Save/download a verified local copy.
- [~] Image/file blocks integrated with ordinary editing.
- [ ] Image captions, alt text, sizing, and alignment.
- [ ] Local audio/video playback.
- [ ] PDF/document preview without remote fetches.
- [ ] Attachment replacement preserving explicit history/provenance.
- [ ] Large-file streaming rather than full memory buffering.

## 10. Import, export, and portability

- [x] Deterministic structured workspace JSON export.
- [x] Page Markdown export.
- [~] Database CSV export from canonical record pages.
- [x] Attachment-complete verified backup format.
- [x] Restore integrity verification and rollback-safe staging foundations.
- [~] Restore into a new workspace with deterministic identity remapping.
- [ ] Markdown page/subtree import.
- [ ] CSV database import.
- [ ] HTML/static-page export.
- [ ] Database CSV companion schema metadata containing property IDs, types, options, and tombstones.
- [ ] Staged import preflight showing warnings, conflicts, unsupported content, skipped items, and resource limits.
- [ ] Cancellable, transactional import.
- [ ] Deterministic rerun/deduplication behavior.
- [ ] Import/export equivalence tests for all included entities and attachments.
- [ ] Compatibility reporting for unsupported external content.

## 11. History, recovery, and local integrity

- [x] Atomic canonical mutations and revisions.
- [x] Recoverable failed-edit state with retry/discard.
- [x] SQLite-backed restart persistence.
- [x] Single-writer data-root ownership and duplicate-writer rejection.
- [x] Rebuildable link and search indexes.
- [x] Manual verified backups with checksums.
- [~] Editor undo/redo.
- [ ] Page/database version history.
- [ ] Restore an earlier page version without replacing unrelated workspace state.
- [ ] Scheduled local backups and retention.
- [ ] User-visible database integrity diagnostics.
- [ ] Corrupt-index repair workflow.
- [ ] Disk-full, interruption, and process-termination recovery acceptance across all major workflows.
- [ ] Optional authenticated backup encryption without requiring a service.

## 12. Sharing, collaboration, and publishing

These are later optional capabilities. They must never become prerequisites for local-only use.

- [ ] Workspace members and roles.
- [ ] Page/database permissions.
- [ ] Share to selected members.
- [ ] Comments on pages and blocks.
- [ ] Text-range comments.
- [ ] Mentions of collaborators.
- [ ] Resolved comment threads.
- [ ] Edit history with actor attribution.
- [ ] Presence indicators as ephemeral state.
- [ ] Deterministic multi-user conflict handling.
- [ ] Private multi-device sync with offline edits.
- [ ] Self-hosted collaboration server.
- [ ] Public read-only page publishing.
- [ ] Public site navigation and metadata controls.
- [ ] Duplicate a published template into a local workspace.
- [!] Vendor-hosted service dependence is excluded from ordinary local use.

## 13. Notifications and inbox

- [ ] Local inbox for mentions, comments, assignments, and reminders when those features exist.
- [ ] Read/unread and archive state.
- [ ] Local reminders attached to pages, blocks, dates, and records.
- [ ] Notification preferences.
- [ ] Optional desktop notifications with explicit permission.
- [!] Marketing, analytics, and telemetry notifications are excluded.

## 14. Accessibility and keyboard operation

- [~] Semantic headings and labelled controls.
- [~] Logical focus order and visible focus.
- [~] Keyboard page, block, table, search, and view operations.
- [~] Every implemented drag action has an equivalent keyboard command.
- [~] Responsive/equivalent-200%-zoom layouts.
- [ ] WCAG 2.2 AA acceptance for the complete included workflow.
- [ ] Reduced-motion support.
- [ ] High-contrast compatibility.
- [ ] Linux screen-reader acceptance.
- [ ] Accessible virtualized editor/database reading order.
- [ ] Announced selection, drop-target, error, save, and completion states.
- [ ] User-configurable shortcuts architecture.

## 15. Appearance and personalization

- [~] Responsive desktop layout.
- [ ] Light and dark themes.
- [ ] System-theme following.
- [ ] Accessible colour and contrast tokens.
- [ ] Reduced motion.
- [ ] Adjustable text size and interface density.
- [ ] Per-page font/width preferences where they do not alter canonical content.
- [ ] User-configurable start page and sidebar ordering.

## 16. Performance and scale

- [~] Bounded validation and hostile-input limits.
- [~] Incremental SQLite persistence and indexes.
- [~] Deterministic large link/reference tests.
- [ ] Collection virtualization for 50,000-record fixtures.
- [ ] Long-page virtualization for 100,000-block fixtures.
- [ ] 10,000-page navigation/search fixture.
- [ ] Thousands-of-attachments streaming fixture.
- [ ] Reproducible cold/warm launch benchmarks.
- [ ] Reproducible typing, search, scrolling, collection, attachment, and recovery benchmarks.
- [ ] Visible performance regression reports in CI.

## 17. Privacy, security, and observability

- [x] No telemetry by default.
- [x] No silent remote resource fetching.
- [x] Closed-shape, allowlisted native IPC commands.
- [x] Fail-closed source security analysis and governance.
- [x] Hostile import/restore and path handling tests.
- [x] Local content remains usable with networking denied.
- [~] Redacted local logs.
- [ ] User-invoked support bundle with exact-content preview.
- [ ] Local crash reports by default.
- [ ] Database/index diagnostics exposed safely in the product.
- [ ] Signed/checksummed release artifacts and immutable provenance acceptance.
- [ ] Optional application-level encrypted workspace/vault.
- [!] Remote crash reporting without separate, transparent opt-in is excluded.

## 18. Platforms and packaging

- [x] Linux x86-64 package pipeline.
- [x] Linux aarch64 package pipeline.
- [x] AppImage and Debian package production.
- [~] Installed/offline workflow acceptance on exact candidate artifacts.
- [ ] Automatic update mechanism with signed metadata and explicit user control.
- [ ] Windows desktop after Linux reliability targets are met.
- [ ] macOS desktop after Linux reliability targets are met.
- [ ] Mobile clients only after sync and permission models are mature.
- [ ] Browser-hosted product only if it does not weaken the local-first authority model.

---

## Milestone mapping

- **M1–M2:** Local workspace, editor, links, search, attachments, persistence, backup, and Linux package foundations.
- **M3:** Complete table/list collections, initial property contracts, nested filters/sorts, canonical exports, and property ordering/tombstones.
- **M4:** Board, calendar, gallery, and timeline workflows; deterministic edge and large-data behavior.
- **M5:** Relations, rollups, formulas, chart, and form views.
- **M5.5:** Reliability, performance, diagnostics, interchange, recovery, and operational release gate.
- **M6:** Optional private multi-device sync.
- **M7 / V2.0:** Optional collaborative self-hosting, permissions, comments, history, presence, and publishing.
- **V1.5:** Third-party connector framework, integrations, and bounded automation.
- **V3.0:** Optional provider-neutral AI with local and cloud model paths.

## Completion rule

An item may move to `[x]` only when all applicable layers agree:

1. canonical model and validation;
2. domain behavior and invariants;
3. application-service command/query path;
4. fail-closed native IPC boundary;
5. usable accessible UI and keyboard alternative;
6. persistence and restart behavior;
7. export, restore, and migration behavior;
8. focused unit/integration/browser evidence;
9. exact-commit CI evidence; and
10. packaged/offline acceptance when the item is release-facing.

## Review questions for Jake

- Does this checklist capture the intended product destination?
- Should optional self-hosted collaboration and public publishing remain in scope after local parity?
- Should Windows, macOS, mobile, and browser-hosted clients remain later targets?
- Are application-level encrypted workspaces part of the desired V2.0 self-hosting target?
- Are canvas, dashboard, feed, map, and form surfaces desired, or should any be explicitly excluded?
- Which integrations should define the first V1.5 connector acceptance slice?
- Should Tailscale/Headscale be the recommended V2.0 deployment profile while standard hardened HTTPS remains supported?
