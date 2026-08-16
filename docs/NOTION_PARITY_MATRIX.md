# Motion → Notion parity matrix

Status: implementation control document

As-of candidate: `feat/notion-editor-chrome` at `1b49f3e` plus this document

Research basis: [Notion product review](./NOTION_PRODUCT_REVIEW.md)

## Status vocabulary

- **Complete**: durable canonical model, native and browser command boundaries, restart persistence, production UI, accessibility path, and automated verification exist.
- **Partial**: useful behavior exists but one or more required layers or core interactions are absent.
- **Model only**: canonical schema accepts the object, but the product does not expose a complete creation/editing/rendering workflow.
- **Candidate**: implemented and locally verified on this branch; exact-SHA CI and packaged graphical verification still required.
- **Absent**: no honest end-to-end implementation.
- **Later**: intentionally assigned to the collaboration, integration, self-hosting, or AI milestone rather than silently counted as V1 parity.

A permissive type union or migration field is not a shipped feature.

## Workspace shell and navigation

| Notion capability | Motion status | Evidence / gap | Delivery slice |
|---|---|---|---|
| Persistent workspace sidebar | Complete | Local page tree, favourites and Trash | shipped |
| Nested pages and disclosure | Complete | Stable parent IDs; expandable tree | shipped |
| Breadcrumbs and back navigation | Complete | Stable page navigation | shipped |
| Quick search / command search | Complete | `Ctrl/Cmd+K`; canonical native search and browser fallback | shipped |
| Create page from sidebar | Complete | Root and child creation with truthful failure recovery | shipped |
| Favourite pages | Complete | Canonical favourite state | shipped |
| Trash and restore | Complete | Cascading reversible trash | shipped |
| Quiet two-column shell | Candidate | 240 px sidebar; context is on-demand overlay | Slice UI-1 |
| Compact utility disclosure | Candidate | Backup/restore tools collapse into a workspace menu | Slice UI-1 |
| Resizable/collapsible desktop sidebar | Absent | Mobile drawer exists; desktop width is fixed | Slice UI-2 |
| Recent pages | Absent | No recency section | Slice NAV-1 |
| Workspace switcher | Partial | Canonical multi-workspace support exists below UI; no Notion-like switcher | Slice NAV-2 |
| Settings hub | Absent | Native tools are a disclosure menu, not a settings surface | Slice NAV-2 |
| Shared/team/private sections | Later | Requires collaboration and permission semantics | V2 collaboration |
| Inbox/activity | Later | Requires collaboration event model | V2 collaboration |

## Pages

| Notion capability | Motion status | Evidence / gap | Delivery slice |
|---|---|---|---|
| Page is universal content container | Complete | Pages own blocks; database records are pages | shipped |
| Nested page hierarchy | Complete | Canonical stable parent IDs | shipped |
| Page rename | Complete | Canonical command and native persistence | shipped |
| Page move and reorder | Complete | Pointer actions plus labelled keyboard alternatives | shipped |
| Stable internal page links | Complete | Page-ID links survive rename and move | shipped |
| Backlinks and outgoing links | Complete | Lifecycle-aware link context and deep block targets | shipped |
| Create missing page from `[[…]]` | Complete | Exact-title de-duplication, canonical root page, stable-ID reference | shipped |
| Page icon | Absent | No model or UI | Slice PAGE-1 |
| Page cover | Absent | No model or UI | Slice PAGE-1 |
| Font / small text / full width controls | Absent | Reading width is currently global | Slice PAGE-1 |
| Page templates | Absent | `templateOriginId` is not an authoring/apply workflow | Slice TEMPLATE-1 |
| Page lock | Absent | No editable lock contract | Slice PAGE-2 |
| Duplicate page | Absent | Blocks duplicate; pages do not | Slice PAGE-2 |
| Export page as Markdown/PDF | Partial | Canonical Markdown/CSV export exists below UI; no page-format chooser or PDF | Slice EXPORT-1 |
| Comments, discussions, activity | Later | Collaboration milestone | V2 collaboration |
| Share/publish/guest access | Later | Secure multi-user permissions and transport required | V2 collaboration |

## Document editor and blocks

| Notion capability | Motion status | Evidence / gap | Delivery slice |
|---|---|---|---|
| Paragraph, H1–H3 | Complete | Canonical transform and renderer | shipped |
| Bulleted/numbered lists | Complete | Canonical types and continuation behavior | shipped |
| To-do blocks | Complete | Checked state and list exit behavior | shipped |
| Quote, code, divider | Complete | Canonical typed payloads | shipped |
| Nested blocks / indent / outdent | Complete | Stable nested model and non-trapping shortcuts | shipped |
| Split, merge, duplicate and move blocks | Complete | Canonical batch operations and history | shipped |
| Multiline Markdown paste | Complete | One validated canonical batch | shipped |
| Markdown typing shortcuts | Complete | Headings, lists, task, quote, code and divider | shipped |
| `@` page mentions and `[[…]]` links | Complete | Stable ID references; duplicate-title safe | shipped |
| File block | Complete | Native canonical attachment identity and restart-safe access | shipped |
| Contextual block gutter | Candidate | Type control is a 28 px six-dot target outside reading flow, shown on hover/focus | Slice UI-1 |
| Slash command menu | Candidate | Filtered accessible listbox; selected transform and query removal use one `block.batch` | Slice EDIT-1 |
| Toggle block | Model only | Core type exists; no production authoring/rendering behavior | Slice BLOCK-1 |
| Callout block | Model only | Core type exists; no product UI | Slice BLOCK-1 |
| Image block | Model only | Attachment payload exists; no image authoring/rendering workflow | Slice BLOCK-2 |
| Bookmark block | Model only | URL payload validation exists; no preview UI | Slice BLOCK-2 |
| Child-page block | Model only | Core payload exists; sidebar child pages are separate | Slice BLOCK-2 |
| Simple table block | Model only | Core type exists; no cell model/editor | Slice BLOCK-3 |
| Collection view block | Model only | Stable `viewId` exists; no inline linked-view workflow | Slice DB-5 |
| Date mention | Model only | Payload validation exists; no chooser/rendering | Slice INLINE-2 |
| Inline bold/italic/underline/strike/code | Absent | Block content is plain text plus stable references | Slice INLINE-1 |
| Inline hyperlinks | Absent | Internal page references exist; arbitrary rich-text links do not | Slice INLINE-1 |
| Inline color and background | Absent | No rich-text mark schema | Slice INLINE-1 |
| Selection toolbar | Absent | No rich-text selection UI | Slice INLINE-1 |
| Columns | Absent | Nested tree has no horizontal layout schema | Slice BLOCK-4 |
| Table of contents | Absent | No derived heading index block | Slice BLOCK-4 |
| Synced blocks | Absent | No shared block-source identity | Slice BLOCK-5 |
| Buttons | Absent | No action schema or safe execution UI | Slice AUTOMATION-1 |
| Equations | Absent | No math payload/renderer | Slice BLOCK-6 |
| Audio/video/embed | Absent | Files can be attached but no specialized player/embed blocks | Slice BLOCK-6 |

## Database model and properties

| Notion capability | Motion status | Evidence / gap | Delivery slice |
|---|---|---|---|
| Database records are pages | Complete | One canonical page identity per record | shipped |
| Title property | Complete | Immutable identity property | shipped |
| Text / rich-text-shaped property | Complete | Safe text control; rich formatting inside the value is not yet implemented | shipped / INLINE-1 |
| Number | Complete | Finite numeric validation and editor | shipped |
| Checkbox | Complete | Typed validation and native control | shipped |
| Select / multi-select / status | Complete | Stable option IDs and editing | shipped |
| Date and date range | Complete | Ordered closed ranges and rollback-safe UI | shipped |
| URL / email / phone | Complete | Typed controls and safe URL validation | shipped |
| Files | Complete | Canonical attachment IDs | shipped |
| Created/updated time and by | Complete | Read-only metadata projections | shipped |
| Property create/rename/reorder/delete | Complete | Tombstoned definitions preserve historic values | shipped |
| Relation | Model only | Core relation config and value validation exist; no creation/editor/filter UI | Slice DB-3 |
| Rollup | Absent | No canonical rollup property/aggregator | Slice DB-3 |
| Formula | Absent | No canonical formula AST/evaluator in current exact tree | Slice DB-4 |
| Unique ID | Absent | Stable page ID is internal, not a configurable property | Slice DB-4 |
| Person | Later | Requires user/identity model | V2 collaboration |
| Button property | Absent | Requires safe action model | Slice AUTOMATION-1 |
| Property validation options | Partial | Core min/max/required fields exist; no complete authoring UI | Slice DB-2 |
| Populated type conversion preview | Absent | Unsafe conversion is correctly rejected; preview/migration UI missing | Slice DB-2 |

## Database views and operations

| Notion capability | Motion status | Evidence / gap | Delivery slice |
|---|---|---|---|
| Table view | Complete | Editing, widths, column order, visible properties | shipped |
| List view | Complete | Saved view sharing same record identities | shipped |
| Saved view create/duplicate/delete/select | Complete | Stable saved-view IDs and canonical persistence | shipped |
| Nested AND/OR/NOT filters | Partial | Model supports nesting; UI builds one group of conditions | Slice DB-1 |
| Multi-sort | Complete | Ordered stable clauses | shipped |
| Relative-date filters | Model only | Operator accepted; runtime evaluation incomplete | Slice DB-1 |
| Manual record ordering | Absent | Unsorted order follows canonical record ID list without reorder UI | Slice DB-1 |
| Group/subgroup configuration | Model only | View fields exist; no complete UI/runtime | Slice BOARD-1 |
| Board view | Candidate elsewhere | Implemented in isolated `/root/motion-m4-board`, not reviewed/integrated | Slice BOARD-1 |
| Calendar view | Absent | Type accepted but no renderer/interaction | Slice CALENDAR-1 |
| Gallery view | Absent | Type accepted but no renderer/card configuration | Slice GALLERY-1 |
| Timeline view | Absent | Type accepted but no date-range renderer | Slice TIMELINE-1 |
| Chart view | Absent | Type accepted but no chart model/rendering | Slice CHART-1 |
| Form view | Absent | Type accepted but no question/submission workflow | Slice FORM-1 |
| Dashboard view | Absent | Not yet represented in canonical view union | Slice DASHBOARD-1 |
| Per-view property visibility/order | Complete | Stable IDs and persistence | shipped |
| Per-view layout settings | Model only | Opaque `layout` exists; no bounded typed contract | Each view slice |
| Database templates | Absent | No template authoring/default/repeat workflow | Slice TEMPLATE-1 |
| Relations in filters/sorts/groups | Absent | Depends on relation UI and deterministic projection | Slice DB-3 |
| Bulk actions | Absent | No multi-row selection/action surface | Slice DB-2 |
| Import CSV | Absent | Export exists; validated CSV import absent | Slice IMPORT-1 |

## Reliability, accessibility and platform quality

| Requirement | Status | Evidence / gap |
|---|---|---|
| Local-first canonical persistence | Complete | SQLite native authority; browser development adapter is explicit |
| Native typed mutation boundary | Complete | Revisioned exact-shape commands |
| Atomic browser mutation rollback | Complete | Failed browser saves restore exact confirmed state |
| Durable attachment identity | Complete | Hash, length and canonical object path |
| Backup/restore | Complete | Versioned verified native backup lane |
| Search after restart | Complete | Canonical native index and startup verification |
| Unknown future block preservation | Complete | Open block type and `unknownData` round trip |
| Architecture-isolated ARM validation | Complete at stabilization SHA | Fail-closed isolated Rust/Tauri job; lock fingerprint updated |
| Keyboard alternatives | Partial | Core editor and ordering covered; every future view must add equivalents |
| Screen-reader semantics | Partial | Existing controls labelled; candidate chooser uses listbox/option semantics; full browser audit remains CI-only |
| Reduced-motion support | Complete | Global reduced-motion rule |
| Focus-visible consistency | Partial | Most controls covered; complete focus traversal audit still required |
| Large-workspace stress | Partial | Storage/performance tests exist; historical 100k rollback defect remains unresolved |
| Packaged graphical acceptance | Pending | Replacement AppImage must exercise actual UI → Tauri → native service path |

## Dependency-ordered delivery graph

1. **Stabilization:** exact-SHA green CI, artifact qualification and graphical AppImage startup.
2. **UI-1 + EDIT-1:** contextual editor chrome, quiet shell, utility disclosure and slash menu (current candidate).
3. **DB-1:** relative-date evaluation, manual order and honest nested filter builder.
4. **BOARD-1:** integrate and independently review the isolated Board candidate.
5. **INLINE-1:** canonical rich-text mark spans, selection toolbar, paste/export and migration behavior.
6. **BLOCK-1/2:** toggle, callout, image and bookmark through validated payloads.
7. **DB-2/3:** bulk/property conversion, relations and rollups.
8. **CALENDAR/GALLERY/TIMELINE:** one renderer at a time on saved-view contracts.
9. **TEMPLATE/FORM/CHART/DASHBOARD:** creation workflows and derived presentation.
10. **Completeness pass:** page presentation, remaining blocks, import/export and accessibility/performance qualification.

No slice is complete until its canonical model, typed application/native commands, browser fallback, persistence, backup/export behavior, accessibility contract, tests, exact-SHA CI and packaged behavior agree.
