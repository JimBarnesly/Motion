# Motion 0.1.1 product backlog

Owner: Ashkay Lothari, Product Director

Requested by: Iman Chao, Managing Director

Defined: 2026-08-05

## Release intent

Motion 0.1.1 should turn the 0.1.0 local foundation into a more credible daily
workspace for writing, organising, finding, and structuring personal knowledge.
It is an improvement release, not a collaboration or platform expansion.

The ranking is based on the shipped 0.1.0 behaviour in `README.md`,
`docs/RELEASE.md`, the Web UI, and its automated tests. Version 0.1.0 already
provides local workspaces, nested pages, a basic typed-block editor, table
pages, search, links/backlinks, trash/restore, attachments, JSON
export/restore, and native backup/restore. The main product limitation is that
these capabilities remain shallow or fragmented in the Web-v1 compatibility
UI.

## Ranked top five

### 1. Daily-writing editor

**User outcome:** I can write and restructure a substantial document with
predictable keyboard behaviour, without fighting the editor or losing block
identity.

**Scope boundary:** Complete the initial document-editing experience over the
canonical service boundary: paragraph, headings, bulleted and numbered lists,
tasks, toggles, quotes, callouts, divider, code, links, undo/redo, block
selection, duplicate, transform, indent/outdent, reorder, and cross-page move.
Use the accepted Tiptap/ProseMirror direction. Exclude comments, live
collaboration, AI writing, synced blocks, equations, and third-party embeds.

**Acceptance criteria:**

- Every included block type creates, edits, saves, reloads, exports, and
  restores without changing its stable ID or type.
- Keyboard users can select one or more blocks, move, indent/outdent,
  duplicate, delete, transform, undo, and redo without a pointer.
- Copy/paste within Motion and copy as Markdown preserve supported structure;
  unsupported imported blocks remain visible and lossless.
- IME composition, multiline paste, selection across blocks, and 10,000-word
  documents have automated browser coverage with no acknowledged lost edit.
- The compatibility editor is not retained as a second authoritative editing
  path.

### 2. Complete page organisation

**User outcome:** I can keep a growing workspace navigable by arranging pages
quickly and returning to important content.

**Scope boundary:** Complete create, rename, nest, reorder, move, favourite,
trash, and restore interactions in the sidebar, including keyboard
alternatives and clear empty states. Exclude sharing, permissions, teamspaces,
published sites, and permanent-delete policy.

**Acceptance criteria:**

- Pages can be moved and reordered at root or within a parent using pointer and
  keyboard paths that issue the same validated domain command.
- Favourite/unfavourite persists across restart and does not duplicate or move
  the canonical page.
- Moving or renaming a page preserves stable links, backlinks, attachments,
  blocks, and descendants.
- Invalid self/descendant moves are rejected with an actionable message and no
  partial hierarchy change.
- Trash and restore cover nested pages predictably and retain the previously
  selected page where it still exists.

### 3. Useful collection table

**User outcome:** I can manage a small structured dataset, not merely edit a
grid of untyped text.

**Scope boundary:** Make the table view complete for title, text, number,
checkbox, select, multi-select, status, date, URL, email, and phone properties;
include property editing, column ordering/widths, typed filters, multi-sort,
and saved view state. Exclude relations, rollups, formulas, board/calendar/
gallery/timeline/chart/form views, database automations, and templates.

**Acceptance criteria:**

- Users can add, rename, reorder, configure, and remove included properties,
  with invalid existing values handled explicitly before a type change.
- Records remain normal pages with stable IDs and editable page content.
- Nested `AND`/`OR`/`NOT` filters and multiple sorts persist and produce
  deterministic results after restart.
- Column order and widths persist per view without duplicating record data.
- A 5,000-record fixture remains operable through bounded or virtualised
  rendering, with the measured result recorded.

### 4. Find and follow knowledge

**User outcome:** I can find content quickly and trust links after pages are
renamed, moved, trashed, or restored.

**Scope boundary:** Finish quick search and linked-knowledge UX: snippets,
highlighted matches, keyboard result navigation, page/content filters,
`@` mentions, `[[...]]` links, backlinks, broken/trashed states, and block deep
links. Exclude graph visualisation, semantic/AI search, external connectors,
unlinked mentions, and block transclusion.

**Acceptance criteria:**

- Search covers titles, supported block text, table values, and attachment
  filenames through the canonical local index.
- Results provide snippets, highlights, deterministic ordering, keyboard
  navigation, and filters for page, table record, and attachment content.
- `@` and `[[...]]` select a stable page ID; rename or move changes display text
  without breaking the target.
- Backlink and outgoing-link views update transactionally with edits and expose
  broken, trashed, and restored targets honestly.
- Quick search meets the existing sub-200 ms moderate-workspace target on the
  documented benchmark fixture.

### 5. Reliable workspace interchange

**User outcome:** I can bring existing notes into Motion and take my complete
workspace back out without manual reconstruction.

**Scope boundary:** Add a staged Markdown/CSV import flow and complete the
existing structured JSON export/restore experience, including hierarchy,
supported blocks, collection schemas, records, links, and attachments. Include
an explicit compatibility report. Exclude proprietary Notion API access,
cloud import, scheduled backup policy, encrypted archives, and pixel-identical
HTML reproduction.

**Acceptance criteria:**

- Import preflight reports pages/records/files to add, warnings, unsupported
  content, conflicts, and limits before any canonical mutation.
- Cancel or failed import leaves the destination workspace unchanged; rerunning
  the same import does not silently duplicate content.
- Markdown folders preserve hierarchy and local links where resolvable; CSV
  imports create a collection only after property-type confirmation.
- Full structured export followed by restore into a new workspace reproduces
  canonical IDs, hierarchy, supported blocks, collection data, links, and
  attachment hashes.
- Unsupported content is retained as an explicit placeholder or reported as
  skipped; it is never silently discarded.

## Explicitly excluded from 0.1.1

- Release approval, signing, supply-chain controls, security gates, deployment,
  and rollback work owned by Iman.
- Sync, multi-user collaboration, comments, presence, sharing, permissions, and
  accounts.
- AI, MCP, external connectors, automations, webhooks, public API, mobile apps,
  Calendar, Mail, and enterprise administration.
- Additional collection views, relations, rollups, and formulas; these follow
  after the table foundation is complete.

## Release decision rule

The five items are ordered. If capacity cannot complete all five to their
acceptance criteria, reduce the 0.1.1 commitment from the bottom upward rather
than shipping partial slices of every item. Product recommends committing
items 1–3 first, with items 4–5 as the next pull order after Engineering sizes
the work and identifies dependencies.
