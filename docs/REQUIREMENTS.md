# Motion Product Requirements

Requirement IDs are stable references for implementation, tests, release notes, and architecture decisions. “Initial” means the first substantial local-only desktop release; later capabilities remain extension contracts unless promoted by a milestone.

## Pages

- **PAGE-001:** Every page has a stable ID independent of its title, hierarchy, or collection membership.
- **PAGE-002:** A page stores an editable title, optional icon and cover, nullable parent, explicit child ordering, created/updated timestamps, optional creator/updater identities, archived and tombstoned states, favourite state, optional template origin, optional collection membership, and optional typed properties.
- **PAGE-003:** Users can create, rename, reorder, nest, move, archive, restore, favourite, and delete pages without breaking ID-based links.
- **PAGE-004:** Page hierarchy rejects cycles and cross-workspace parents.
- **PAGE-005:** Collaboration-capable schemas can attach permissions to pages without making identity or a server mandatory in local-only mode.

## Blocks and editing

- **BLOCK-001:** Every block has a stable ID, page ID, optional parent block ID, deterministic sibling order, type, typed payload, and versioned serialization.
- **BLOCK-002:** Initial block types are paragraph, headings 1–3, bulleted list item, numbered list item, task/checkbox item, toggle, quote, callout, divider, code block, inline code, image, file attachment, bookmark, child-page link, page mention, date mention, simple table, collection view, and unsupported/imported placeholder.
- **BLOCK-003:** The type registry supports later audio, video, PDF, equation, diagram, embedded local file, synced block, table of contents, breadcrumb, template button, canvas, chart, form, and plugin blocks without changing the base block identity contract.
- **BLOCK-004:** Users can select one or many blocks, duplicate, delete, move, copy/paste, copy as Markdown, transform compatible types, nest/outdent, reorder, and move blocks between pages.
- **BLOCK-005:** Editing supports undo and redo for local document mutations.
- **BLOCK-006:** Blocks expose stable anchors and copyable deep links.
- **BLOCK-007:** Unknown block types and their complete payloads are retained losslessly through load, edit of surrounding content, save, sync, and structured export. The UI renders an honest unsupported-block placeholder and never silently discards them.
- **BLOCK-008:** Future comments may target a block or text range without changing the block ID.
- **BLOCK-009:** Dropped files create attachment records and blocks only after durable local ingestion; missing or failed files are explicit states.

## Links and knowledge graph

- **LINK-001:** Page mentions, child-page links, wiki links, and internal URLs resolve through stable page IDs, not titles or paths.
- **LINK-002:** Typing `@` opens page mention selection; `[[Page name]]` supports wiki-link entry and resolves the selected page to its ID.
- **LINK-003:** Renaming or moving a page updates displayed titles without rewriting link identity.
- **LINK-004:** A transactional, materialized link index records source page/block, target page and link kind. Backlinks and incoming/outgoing-link search query this index without scanning all documents when a page opens.
- **LINK-005:** Link previews, links to archived pages, broken-link states, and deep links to blocks are represented explicitly.
- **LINK-006:** The link index is derived from canonical blocks, is updated in the same transaction as content, and can be fully rebuilt and consistency-checked.
- **LINK-007:** Later extensions may add unlinked mentions, graph view, aliases, transclusion, synced blocks, and block references without replacing stable page-link semantics.

## Collections, records, and properties

- **COLL-001:** A collection is a schema-driven set of records; each record is also a page and may contain normal blocks beneath its properties.
- **COLL-002:** Initial property types are title, plain text, rich text, number, checkbox, select, multi-select, status, date, date range, URL, email, phone, files, created time, updated time, created by, and updated by.
- **COLL-003:** Property definitions have stable IDs, explicit types, ordering, validation metadata, and tombstones so rename/reorder/delete does not reinterpret historic values.
- **COLL-004:** Later property extensions include relation, rollup, formula, person, unique identifier, action, geolocation, duration, progress, dependency, and computed backlinks.
- **COLL-005:** Property and record changes serialize deterministically and preserve unknown future definitions/values where possible.

## Views, filters, and sorting

- **VIEW-001:** Every view is saved configuration over shared collection records; a view does not duplicate record data.
- **VIEW-002:** Views are implemented in this order: table, list, board, calendar, gallery, timeline, chart, then form.
- **VIEW-003:** A view stores stable view and collection IDs, type, name, visible properties, property order, column widths, filters, sorts, grouping/subgrouping, layout, card preview, calendar date property, timeline start/end properties, permissions, and personal/shared state as applicable.
- **FILTER-001:** Filters use a typed abstract syntax tree with nested `AND`, `OR`, and `NOT`; raw SQL fragments are forbidden in persisted view configuration.
- **FILTER-002:** Operators are type-aware and support relative dates, empty/not-empty, and relation conditions; formula-result conditions are an extension.
- **SORT-001:** Views support multiple ascending/descending clauses, deterministic stable ordering, manual ordering, explicit null positioning, type-aware comparison, and locale-aware text comparison.
- **VIEW-004:** Reordering properties, columns, and cards updates saved ordering; moving a board card between groups updates the grouped property through the same validated command path as direct editing.

## Relations

- **REL-001:** Relations reference stable record/page and property IDs and support one-way plus optional reciprocal definitions.
- **REL-002:** The model supports one-to-one, one-to-many, and many-to-many cardinality with enforceable relation limits.
- **REL-003:** Deleted or unavailable related records remain distinguishable from an empty relation and never silently retarget.
- **REL-004:** Reciprocal updates are atomic locally and reconcile deterministically when sync is introduced.
- **REL-005:** Rollups are derived from relation targets and specify aggregation, missing/deleted-target handling, and result type.
- **REL-006:** Rollups support count, count values, count unique, sum, average, minimum, maximum, earliest/latest date, percent checked, and show original values, with cross-collection type validation.
- **REL-007:** Rollup/relation dependency cycles are detected before evaluation and cannot cause uncontrolled recursion.

## Formulas

- **FORM-001:** Formulas use a versioned lexer, parser, typed AST, evaluator, explicit null/error semantics, and stable property-ID references; JavaScript `eval` is forbidden.
- **FORM-002:** Numeric, string, Boolean, and date operations evaluate deterministically from explicit workspace locale/time-zone context.
- **FORM-003:** A dependency graph drives incremental invalidation and rejects direct or indirect cycles with a visible error value.
- **FORM-004:** Formula source and language version are persisted and unknown newer versions survive round trips unchanged.

## Search

- **SEARCH-001:** Local search indexes page titles/aliases, body and heading text, collection/property names, textual/select values, attachment filenames, and incoming/outgoing links using rebuildable SQLite FTS5 indexes.
- **SEARCH-002:** Quick and full search provide keyboard navigation, snippets, highlighted matches, deterministic ranking, and filters by workspace, content type, collection, date, property, and links.
- **SEARCH-003:** Index updates are incrementally queued with canonical mutations; reindex and integrity-check operations recover missing, stale, duplicate, or orphan entries without network access.
- **SEARCH-004:** Recent-search history is local, optional, disableable, and clearable.

## Keyboard and accessible interaction

- **A11Y-001:** Initial documented shortcuts cover command/search, page creation, page switching, block selection/multi-selection, block movement, indent/outdent, duplicate, delete, undo/redo, task completion, link opening, escape, arrow navigation, and visible-focus Tab navigation.
- **A11Y-002:** Keyboard behavior is deterministic for the same editor state and never depends on network availability.
- **A11Y-003:** Shortcut handling avoids trapping focus, respects platform conventions, and is architected for later user configuration.
- **A11Y-004:** Drag-and-drop supports pages, blocks, files, database properties/columns, and board cards as applicable.
- **A11Y-005:** Every drag operation has a discoverable keyboard alternative that produces the same domain command and validation result.
- **A11Y-006:** Menus, selections, drop targets, errors, focus, and completion state are exposed to assistive technology; colour alone does not communicate state.

## Local-first integrity

- **LOCAL-001:** All requirements above function in local-only desktop mode without login, server, internet, telemetry, or provider account.
- **LOCAL-002:** Canonical content and its operation entry commit atomically; derived indexes are rebuildable.
- **LOCAL-003:** Markdown, structured JSON, database CSV, attachments, and full-workspace export preserve the reconstruction contract, including hierarchy, blocks, views, relations, links, metadata, and unknown blocks.
- **LOCAL-004:** Tests cover deterministic serialization, restart durability, index rebuilding, unknown-block round trips, and export/restore equivalence.
