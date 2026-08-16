# Notion product review and Motion implementation target

Status: source-grounded product and interaction audit

Owner: Product / Engineering

Research date: 2026-08-16

Scope: Notion's core workspace product, separated from Notion AI, Mail, Calendar, hosted collaboration, and third-party connections

## Executive conclusion

Notion is not primarily a conventional document editor or spreadsheet. Its core is a composable workspace with four mutually reinforcing ideas:

1. **Every workspace object is navigable like a page.** Pages can contain content, nested pages, or inline databases, and the sidebar exposes the same hierarchy.[1][2]
2. **Every piece of page content is a movable typed block.** Text, lists, tasks, media, databases, equations, breadcrumbs, and table-of-contents elements share one editing surface and common lifecycle operations.[3][4]
3. **Every database item is itself a page.** Database properties provide typed metadata while the record retains ordinary page content.[1]
4. **A database view is a saved projection, not another copy of the data.** Table, board, timeline, calendar, list, gallery, chart, and form surfaces share records while independently configuring layout, visibility, filters, sorts, groups, and page-opening behavior.[5]

The result feels coherent because navigation, content, structured data, search, and linking all use the same identities. Motion should reproduce that product model and interaction quality while retaining its independently designed visual identity, offline-first architecture, strict canonical commands, and stronger local ownership guarantees. It must not copy Notion branding, assets, wording, or proprietary layouts.

Broad parity cannot be achieved by adding isolated renderers. Each capability must close a vertical lifecycle: create, edit, move/reorder, persist, restart, search/link, export, restore, accessible keyboard use, pointer use where applicable, failure recovery, and packaged offline acceptance.

---

## 1. What Notion is

### 1.1 A workspace shell

The application shell combines:

- a collapsible and resizable sidebar;
- nested page navigation with effectively unbounded depth;
- drag-and-drop hierarchy editing;
- search and recent-page switching;
- favourites, private/shared/team sections, templates, and trash;
- quick creation next to sections and pages;
- a central page canvas;
- lightweight top-level page actions and contextual overlays.[2]

Notion's current hosted product also exposes Home, Inbox, meetings, AI conversations, teamspaces, permissions, and multi-workspace switching.[2] Those are not all V1 Motion requirements. Motion V1 should implement the complete local single-user shell: workspace home, recents, favourites, pages, nested databases/views, templates, trash, search, settings, local diagnostics, and backup/export. Membership, shared/team areas, notifications, comments, presence, and permissions belong behind the optional V2 collaboration boundary.

### 1.2 A page system

A page is simultaneously:

- a titled destination with stable identity;
- a container of ordered blocks;
- a parent of nested pages;
- a possible database or database record;
- a link target with backlinks;
- a unit of templates, duplication, locking, history, export, and sharing.

Notion supports icon and cover treatment, Default/Serif/Mono page typography, small-text and full-width preferences, colours and highlights, backlinks/comments display choices, and page-level customization.[6]

### 1.3 A block editor

Notion's documented basic blocks include text, page, to-do, headings, bulleted and numbered lists, toggles, quotes, dividers, and callouts. Media includes images, bookmarks, videos, audio, code, and files. Advanced blocks include equations, template buttons, breadcrumbs, and table of contents.[3]

The important interaction model is as significant as the block list:

- plain text is the default;
- `/` opens a searchable insertion and transformation menu;
- text selection opens a compact rich-text toolbar;
- a contextual `+` inserts content beside the current position;
- a contextual six-dot handle drags or opens block actions;
- block chrome appears on hover/focus rather than occupying a permanent column;
- blocks can be dragged, duplicated, converted, coloured, commented on, deleted, and moved to another page;
- dragging blocks beside one another creates columns.[3][4][6]

This is the decisive lesson from Jake's screenshot: a persistent 140px block-type dropdown—even reduced to 76px—still makes editor mechanics compete with the document. Motion should expose type through content semantics and contextual block chrome. The accessible control must remain keyboard discoverable and announce the current type, but it should only gain visible weight when the row is hovered, focused, selected, or its menu is open.

### 1.4 A typed database system

A Notion database is a collection of pages, not a separate row-only object model. A record opens as a page, displays properties at the top, and accepts arbitrary blocks below.[1]

Notion currently documents these property classes: rich text, number, select, status, multi-select, date/range, formula, relation, rollup, person, file, checkbox, URL, email, phone, created time/by, last-edited time/by, button, unique ID, and place.[7]

Properties participate in:

- record editing and layouts;
- per-view visibility and order;
- type-aware filters, sorts, groups, and subgroups;
- search;
- formulas and rollups;
- forms and templates;
- board/calendar/timeline/chart behavior.

Motion's canonical decision that records are pages is therefore correct and must remain the foundation.

### 1.5 A saved-view system

Notion documents these core database presentations:[5]

| View | Primary job | Canonical configuration Motion needs |
| --- | --- | --- |
| Table | dense editing and comparison | property order/visibility/width, frozen columns, row order |
| List | minimal scanning | shown properties, grouping, compactness |
| Board | grouped workflow | group/subgroup properties, group order/visibility, card properties, card order, validated moves |
| Calendar | date-based planning | date property, month/week state, undated behavior, date moves |
| Timeline | duration and dependency planning | start/end properties, scale, grouping, resize/move semantics |
| Gallery | visual catalog | preview source, card size, fit, shown properties |
| Chart | aggregate analysis | chart type, dimensions, aggregation, sorting, accessible source table |
| Form | validated data collection | question/property mapping, required fields, descriptions, option presentation, submission behavior |
| Dashboard | at-a-glance composition | widget identities, source views, layout, refresh/empty/error states |

Notion also supports linked views/data sources, view tabs, per-view settings, direct links to views, side/center/full-page record opening, advanced nested filters, multiple type-aware sorts, groups and subgroups, per-database search, and frozen columns.[5]

Motion's feed and offline map are independent product extensions rather than baseline Notion view types. They can remain V1 targets if Jake wants them, but they must not displace closure of Notion's documented form and dashboard workflows.

### 1.6 A relation and computation system

Relations connect pages across databases. They are one-way by default, can expose a reciprocal property, and can limit a relation to one page or permit many. Reciprocal edits must remain synchronized.[8] Rollups aggregate properties through relations. Formulas compute typed values from properties.[9]

For Motion this implies:

- relation values are stable page IDs, never titles;
- target database and cardinality are validated in the property definition;
- reciprocal updates are one atomic command;
- missing, trashed, and deleted targets have explicit semantics;
- rollup and formula dependencies need a versioned graph and cycle policy;
- derived values are rebuilt/verified, not accepted as caller authority;
- filters, sorts, grouping, export, restore, and search consume the same semantics.

### 1.7 A repeatable-workflow system

Notion database templates define default property values plus arbitrary page content, then clone that structure into records. Templates can be duplicated, edited, deleted, selected as defaults, and scheduled to repeat daily, weekly, monthly, or yearly.[10]

Buttons and database automations add actions such as creating pages and editing properties.[11][12] Motion V1 should implement bounded local templates and buttons with preview, explicit affected objects, canonical commands, and undo. Provider-connected actions remain V1.5 integrations.

### 1.8 A linked knowledge system

Notion's page model supports page mentions, links, backlinks, deep navigation, search, and connected database records. The product relies on stable targets so rename and movement do not invalidate links.

Motion already has the stronger canonical basis: stable IDs, link indexes, outgoing links, backlinks, deep block URLs, and live/trashed/missing states. The `[[title` chooser must offer existing stable targets and an explicit **Create page “title”** action. Completing `[[title]]` as plain text must never be mistaken for a successful link.

### 1.9 A collaboration and publishing system

Notion includes sharing levels, guest/member access, database-specific `Can edit content`, comments and mentions, notifications, version history, public sites, and collaborative editing.[1][13][14]

Motion must not fake these in single-user V1. They require V2 identity, sync, conflict, authorization, audit, encryption, and self-hosted transport foundations. V1 can still provide local version history, reminders, and export without inventing collaborator identities.

### 1.10 A hosted automation and AI platform

Current Notion markets AI writing/search, meeting notes, agents, connectors, automations, Mail, and Calendar alongside the workspace. These are adjacent or network-dependent capabilities, not prerequisites for high-quality pages and databases.

Motion's roadmap remains appropriate:

- **V1.0:** complete local workspace, editor, database, templates, history, and portability;
- **V1.5:** explicit third-party connector and automation permissions;
- **V2.0:** optional self-hosted sync/collaboration;
- **V3.0:** optional local/cloud AI provider choice.

---

## 2. What Notion looks and feels like

### 2.1 Product principle: content first, chrome on demand

Notion's most important visual behavior is not a colour value. It is **progressive disclosure**:

- page content owns the visual hierarchy;
- toolbar and block actions are quiet until relevant;
- inline database controls are hidden until hover;[1]
- block insertion/type controls are contextual;[4][6]
- details live in popovers, side peeks, center peeks, or menus rather than permanent inspector rails;[5]
- destructive actions are separated from ordinary editing.

Motion currently violates this in three places visible in the supplied screenshot:

1. every block permanently reserves a wide type-selector column;
2. the permanent right context rail removes nearly a quarter of the editor width despite being mostly empty;
3. backup/export operations occupy a persistent button grid at the bottom of the primary navigation.

### 2.2 Independent Motion design tokens

Motion should use a warm, paper-like neutral system without copying Notion's exact brand palette:

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `canvas` | `#ffffff` | `#20211f` | document surface |
| `sidebar` | `#f5f4f1` | `#191a18` | navigation surface |
| `surface-raised` | `#ffffff` | `#282a27` | menus/dialogs |
| `text` | `#252622` | `#ecece8` | primary text |
| `text-muted` | `#72746d` | `#a7aaa2` | metadata/chrome |
| `line` | `rgba(32,33,29,.10)` | `rgba(255,255,255,.12)` | whisper separators |
| `hover` | `rgba(32,33,29,.055)` | `rgba(255,255,255,.06)` | transient row state |
| `accent` | Motion green, AA contrast | lighter Motion green | focus/confirmation only |
| `danger` | muted red, AA contrast | lighter muted red | destructive/error only |

Rules:

- 1px low-opacity separators, not boxed sections everywhere;
- 4–6px radii for controls and rows, 8–12px for menus/dialogs;
- restrained shadows only for floating layers;
- no saturated accent on ordinary navigation or content;
- focus rings remain clearly visible and are never replaced by hover alone.

### 2.3 Typography

- UI and document body: locally bundled/system sans stack; no remote font dependency.
- Body: 16px, line-height 1.5–1.65.
- Page title: 40px desktop, 32px compact, 700 weight, tight tracking.
- H1/H2/H3: approximately 30/24/20px with clear but not theatrical weight.
- Navigation and tool chrome: 14px.
- Metadata: 12px; uppercase only for short section labels.
- Code: local system monospace.
- Serif/mono page preferences should be optional local UI state unless exported as page presentation metadata by an explicit product decision.

### 2.4 Geometry

- Sidebar default width: 240px, resizable and collapsible.
- Page reading width: 700–760px; full-width preference for databases and selected pages.
- Topbar: 44–48px, borderless or whisper-separated.
- Document top padding: enough for icon/cover/title hierarchy, normally 64–96px.
- Block row: no permanent mechanics column; controls overlay into the left gutter.
- Block body minimum height: approximately one text line plus 6–8px vertical padding, not 39px for every type.
- Context/backlinks: collapsed by default into a page-top disclosure or overlay; never a permanent empty rail.
- Menus: searchable when the option set is large; support arrows, Home/End, Enter/Space, Escape, and focus return.

### 2.5 Core components

#### Sidebar

- workspace identity and collapse control;
- Search / quick switcher;
- Home/recents/favourites;
- nested pages and database-view children;
- hover-revealed `+` and action menu;
- Templates, Trash, Settings/Utilities at the bottom;
- backup/export inside a utilities menu, not six equal persistent buttons;
- row height around 28–32px with truncation and stable icons.

#### Page header

- breadcrumb in topbar;
- optional cover and icon;
- editable title;
- quiet actions (`Favourite`, `•••`) in topbar/header;
- properties as borderless name/value rows for records;
- backlinks as a compact disclosure near the title.

#### Block row

Default: content only.

Hover/focus/selection: left-gutter `+` and six-dot type/action handle.

Menu open: searchable type/action menu with current type announced.

Keyboard: shortcut opens the menu; Tab order does not trap ordinary writing.

Touch/narrow layouts: explicit selected-block toolbar rather than hover dependence.

#### Slash menu

- opens adjacent to the caret;
- searchable categories and aliases;
- selected option preview/description where useful;
- transforms empty current block or inserts after non-empty content according to command semantics;
- fully keyboard operable;
- never performs a client-only visual conversion before canonical confirmation.

#### Database toolbar

- view tabs first;
- compact filter/sort/group/search controls;
- primary `New` action at the far edge;
- per-view settings in a menu;
- controls reflect active configuration with restrained badges;
- records open in a side peek by default where width allows, with full-page escalation.[5]

#### Menus, dialogs, and recovery

- ordinary choices use lightweight menus;
- destructive consequences use explicit confirmation with object count;
- unresolved saves remain visible with Retry and Discard;
- error copy says what was preserved and what was not applied;
- loading, empty, offline, locked, missing-target, and unsupported states are distinct.

### 2.6 Accessibility contract

Notion-like visual quietness must not mean hidden functionality:

- contextual controls appear on keyboard focus as well as pointer hover;
- every drag action has the same canonical keyboard command;
- menus use listbox/menu semantics and deterministic focus return;
- state changes are announced without making the whole canvas an overactive live region;
- 200% zoom produces an equivalent single-column layout;
- colour is never the only status signal;
- selected blocks, drop targets, save failures, and completion states are announced;
- reduced motion and system high contrast are respected.

---

## 3. Top user journeys Motion must close

1. Create a workspace and land on a useful local Home.
2. Create a page from the sidebar, title it, add icon/cover, and reopen it after restart.
3. Create/nest/reorder/move/favourite/trash/restore/duplicate/lock a page.
4. Write naturally without persistent block mechanics distracting from content.
5. Insert or transform any supported block through `/` or contextual `+`.
6. Apply inline rich-text marks through selection toolbar and keyboard shortcuts.
7. Select multiple blocks and move, duplicate, delete, indent, or copy as Markdown.
8. Drag blocks into order or columns with equivalent keyboard operations.
9. Type `@` or `[[` to select an existing page by stable identity.
10. Type `[[New page` and explicitly create and link a canonical page.
11. Follow links, inspect backlinks, preview targets, and recover from trashed/missing targets.
12. Search titles, blocks, properties, and attachment names entirely offline.
13. Create a database where every new record opens as a normal page.
14. Add, configure, reorder, convert, and tombstone typed properties safely.
15. Create/rename/duplicate/reorder/delete saved views without copying records.
16. Filter with nested type-aware logic; multi-sort stably; group and subgroup.
17. Use table/list for dense editing and scanning.
18. Use board and move cards between valid groups by pointer or keyboard.
19. Use calendar/timeline and change dates/durations safely.
20. Use gallery previews with local files and alt text.
21. Build a chart with an accessible source-data equivalent.
22. Build a local form whose submissions are validated record creations.
23. Relate databases, use reciprocal relations, rollups, and formulas.
24. Create and repeat page/record templates with deterministic identity remapping.
25. Export/import Markdown, CSV, JSON, and attachment-complete backups with preflight and rollback.
26. Restore page history or a verified backup without damaging unrelated content.
27. Diagnose integrity/storage problems in clear user-facing language.
28. Install and run x86-64 or ARM64 packages with networking disabled.

---

## 4. Motion capability assessment

The detailed row-by-row evidence remains in `NOTION_FEATURE_PARITY_CHECKLIST.md`. The strategic assessment is:

### Strong foundations already present

- canonical structured schema and stable IDs;
- pages/records unified in one model;
- nested page navigation, favourites, trash/restore, breadcrumbs;
- typed block commands, Markdown entry, multiline paste, undo/redo foundation;
- stable mentions/wiki links, link index, backlinks, deep links, target lifecycle states;
- indexed local search;
- canonical attachments, verified backup/restore;
- table/list saved-view lifecycle, typed properties, filter AST, multi-sort;
- strict IPC, atomic browser confirmation/recovery, SQLite persistence;
- Linux x86-64/ARM64 release lanes and fail-closed governance.

### Most visible deficits

- permanent editor mechanics still compete with content;
- no complete slash insertion menu or rich inline formatting system;
- no columns, synced blocks, table of contents, equations, polished media blocks, page templates, or local history UI;
- sidebar/footer and right context rail feel like an admin prototype rather than a calm workspace;
- database configuration is rendered as dense inline panels rather than view tabs and contextual menus;
- board work exists only in an unfinished worktree and is not integrated;
- calendar, gallery, timeline, chart, form, dashboard, feed, and map are incomplete;
- relations, rollups, integrated formulas, templates, and import remain incomplete;
- packaged interaction acceptance is behind the canonical backend quality.

### Documentation deficits

Some status documents predate the implemented M2/M3 evidence, while the V1 plan contradicts the broader roadmap about form/dashboard and the count of required views. These documents must be reconciled before parallel implementation to prevent agents from building different products.

---

## 5. Dependency-ordered implementation program

### Program A — Stabilize the current packaged product

1. Qualify the data-root preflight, compact/contextual block controls, and `[[` create-page workflow on one exact SHA.
2. Run full Node 24, Rust, static/security, Playwright, x86-64, and ARM64 gates.
3. Exercise the actual installed AppImage UI-to-native path, not only extracted service tests.
4. Publish a verified replacement artifact.

### Program B — Notion-like shell and daily writing

1. Contextual block gutter; remove persistent type-selector column.
2. Collapse the permanent context rail into an overlay/disclosure.
3. Simplify sidebar utilities and page header hierarchy.
4. Implement a caret-anchored slash menu over existing canonical block commands.
5. Implement rich inline marks with deterministic structured representation.
6. Complete multi-block selection, copy-as-Markdown, cross-page move, and dependable IME behavior.
7. Add page icon/cover, width/font preferences, duplicate, lock, table of contents, columns, and polished callout/toggle/media blocks.

### Program C — Database interaction completion

1. Integrate and qualify Board over canonical records.
2. Add group/subgroup and persisted manual order shared by board/table/list where applicable.
3. Implement Calendar, Gallery, and Timeline in that order with canonical pointer/keyboard mutations.
4. Implement Chart with accessible source table.
5. Implement Form as validated record creation.
6. Implement Dashboard only after its component views are stable.
7. Keep Feed and offline Map as Motion extensions after core view closure.

### Program D — Relations, computation, and templates

1. One-way relation with stable IDs and explicit deleted targets.
2. Reciprocal relation and cardinality limits atomically.
3. Relation filters/sorts and export metadata.
4. Rollup dependency semantics.
5. Versioned formula properties with cycle/error/null rules.
6. Page and record templates, deterministic cloning, defaults, recurrence.
7. Bounded local buttons with preview and undo.

### Program E — Portability, history, scale, and release

1. Markdown/CSV import preflight and transactional rollback.
2. Complete reconstruction metadata for every property/view/template.
3. Page-level history and scheduled local backups.
4. Integrity diagnostics and index rebuild UI.
5. Long-document and large-database virtualization.
6. WCAG 2.2 AA, Linux screen-reader, keyboard, offline, disk-full, interruption, and package acceptance.

---

## 6. Immediate acceptance decisions

### Block-type control

A 76px persistent dropdown is an improvement over 140px, but it does **not** complete the request. Acceptance requires:

- no persistent selector column in the normal reading state;
- a 28–32px contextual gutter handle on row hover, row focus-within, or block selection;
- current type included in accessible name and transient visible menu/tooltip;
- native/select or custom menu keyboard operation;
- no loss of type conversion capability at 200% zoom or touch-equivalent layout.

### `[[...]]` page creation

Acceptance requires:

- open `[[title` entry searches live pages;
- exact live title is selected without duplication;
- absent exact title offers `Create page “title”`;
- the canonical page is created with a stable ID;
- the source block persists a stable-ID reference;
- failure never reports false success;
- duplicate titles retain chosen identities;
- blank, overlong, pasted closed, and hostile titles fail safely;
- a follow-up service transaction should remove the current two-command orphan-page window.

### Context rail

Acceptance requires:

- hidden by default on ordinary pages;
- accessible from a labelled topbar/page action;
- overlay/peek behavior with Escape and deterministic focus return;
- backlinks and attachments remain available without consuming permanent canvas width.

---

## Sources

1. [Intro to databases](https://www.notion.com/help/intro-to-databases)
2. [Navigate with the sidebar](https://www.notion.com/help/navigate-with-the-sidebar)
3. [Types of content blocks](https://www.notion.com/help/guides/types-of-content-blocks)
4. [Writing and editing basics](https://www.notion.com/help/guides/writing-and-editing-basics)
5. [Views, filters, sorts and groups](https://www.notion.com/help/views-filters-and-sorts)
6. [Customize and style content](https://www.notion.com/help/customize-and-style-your-content)
7. [Database properties](https://www.notion.com/help/database-properties)
8. [Relations and rollups](https://www.notion.com/help/relations-and-rollups)
9. [Formulas](https://www.notion.com/help/formulas)
10. [Database templates](https://www.notion.com/help/database-templates)
11. [Buttons](https://www.notion.com/help/buttons)
12. [Database automations](https://www.notion.com/help/database-automations)
13. [Sharing and permissions](https://www.notion.com/help/sharing-and-permissions)
14. [Comments, mentions and reminders](https://www.notion.com/help/comments-mentions-and-reminders)
15. [Boards](https://www.notion.com/help/boards)
16. [Timelines](https://www.notion.com/help/timelines)
17. [Charts](https://www.notion.com/help/charts)
18. [Forms](https://www.notion.com/help/forms)
19. [Dashboards](https://www.notion.com/help/dashboards)
20. [Synced blocks](https://www.notion.com/help/synced-blocks)
21. [Use pages offline](https://www.notion.com/help/use-pages-offline)
22. [Export your content](https://www.notion.com/help/export-your-content)
23. [Import data](https://www.notion.com/help/import-data-into-notion)
