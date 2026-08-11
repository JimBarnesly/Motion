# Motion V1.0 scope and acceptance contract

Owner: Managing Director  
Implementation authority: Engineering  
Acceptance authorities: Quality & Release and Operations & Security  
Defined: 2026-08-11

## Release outcome

Motion V1.0 is a dependable, offline, single-user Linux knowledge workspace. A
user can create and organise substantial documents, link and find knowledge,
manage typed records in the six core database views, and reconstruct the complete
workspace on another machine without an account or network connection.

A source-tree test, browser-development build, extracted service smoke, schema
declaration, or renderer alone is supporting evidence. It is not V1 acceptance.
Every included outcome must pass through the canonical service and persistence
boundary in packaged AppImage and Debian builds with networking disabled.

## Included outcomes

### Pages and navigation

- Create, rename, nest, move, reorder, favourite, trash, restore, and permanently
  delete pages from Trash.
- Pointer drag-and-drop and equivalent keyboard commands issue the same validated
  domain mutations.
- Stable hierarchy, breadcrumbs, selection, and expanded state survive restart.

### Daily-writing editor

- Paragraphs, headings 1–3, bulleted and numbered lists, tasks, toggles, quotes,
  callouts, dividers, code blocks, images/files, page mentions, and honest
  unsupported placeholders.
- Stable block IDs; single- and multi-block selection; duplicate, delete,
  transform, reorder, indent/outdent, cross-page move, copy/paste, copy as
  Markdown, undo, and redo.
- IME composition, multiline paste, a 10,000-word document, and unknown-block
  preservation have automated evidence.
- React plus Tiptap/ProseMirror is the only authoritative production editing
  path. Rendered HTML is never canonical data.

### Linked knowledge and search

- `@` mentions and `[[...]]` completion select stable page IDs.
- Outgoing links, backlinks, block deep links, previews, and live/trashed/missing
  states remain correct through rename, move, trash, restore, restart, export,
  and backup restore.
- Local search covers titles, supported block text, table values, and attachment
  filenames with snippets, safe highlighting, filters, deterministic ordering,
  and complete keyboard navigation.

### Typed databases and core views

- Records remain normal pages with stable IDs and normal block content.
- Title, text, number, checkbox, select, multi-select, status, date, URL, email,
  phone, files, relation, rollup, and formula properties validate and persist.
- Property creation, rename, reorder, width, visibility, populated type conversion
  with preview, and deletion with consequences are complete.
- Nested filters, deterministic multi-sort, grouping, and saved view lifecycle
  are complete.
- Table, list, board, calendar, gallery, and timeline independently persist
  applicable configuration over shared records. Empty, null, filtered, deleted,
  and large-dataset behavior is deterministic and tested.

### Portability and recovery

- Full structured JSON export/restore, Markdown tree export/import, CSV
  export/import, and attachment-complete verified backup are usable offline.
- Import uses bounded staged preflight, compatibility reporting, cancellation,
  deterministic conflict handling, and transactional rollback.
- Export followed by restore into a new workspace reproduces stable IDs,
  hierarchy, supported and unknown blocks, database schemas/views, records,
  links, relations, formulas, templates, and attachment hashes.

### Release quality

- The complete CI and release-security chain passes against one immutable commit.
- Installed x86-64 and ARM64 AppImage and Debian packages pass the complete
  offline user path.
- WCAG 2.2 AA automation plus recorded keyboard, 200% zoom, and Linux Orca
  screen-reader acceptance pass.
- Representative source and packaged performance, crash-boundary, disk-full,
  corrupt-index, and duplicate-writer evidence pass reviewed budgets.
- Four release artifacts are checksum-bound, signed, attested, and independently
  verifiable against the exact V1 commit.

## Product constraints

- Complete local mode must not depend on an account, network, database server,
  subscription, or hosted service.
- Structured versioned data remains authoritative. Unknown newer blocks and
  fields remain lossless and visibly unsupported.
- No telemetry and no silent remote asset, preview, media, or API fetching.
- Persisted schema changes require forward migrations and restart/export/restore
  tests.
- Every pointer-only workflow requires an equivalent keyboard path.
- Local application data is not described as application-encrypted unless an
  encrypted-vault feature later passes a separately approved release gate.

## Explicitly deferred beyond V1.0

- Sync, collaboration, accounts, sharing, comments, presence, permissions, and
  public publishing.
- AI, MCP, external connectors, automations, webhooks, and public API.
- Windows, macOS, mobile, hosted service, and browser-as-product distribution.
- Chart, form, dashboard, canvas, mail, and separate calendar products.
- Application-level encrypted vaults.

These exclusions do not weaken local confidentiality, path safety, diagnostic
redaction, data-integrity, backup, offline, provenance, or accessibility gates.

## Immutable acceptance rule

1. Freeze one candidate commit and its dependency locks.
2. Run complete CI with no missing, skipped, or no-op gate.
3. Build the four canonical Linux artifacts from that commit.
4. Record complete installed-package acceptance on representative x86-64 and
   ARM64 graphical hosts with networking disabled.
5. Resolve every data-loss, corruption, false-success, offline, security, and P0
   accessibility defect.
6. Obtain explicit Quality and Security approval for the exact hashes.
7. Create `v1.0.0` only after approval; never move or reuse a failed tag.

Scope may change only through an explicit Jake-approved edit to this document.
Incomplete included outcomes must not be silently relabelled as post-V1 work.
