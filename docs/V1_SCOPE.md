# Motion V1.0 scope and acceptance contract

Owner: Managing Director
Implementation authority: Engineering
Acceptance authorities: Quality & Release and Operations & Security
Defined: 2026-08-11
Scope narrowed by Jake: 2026-08-11

## Release outcome

Motion V1.0 is a dependable, offline, single-user Linux knowledge workspace. A
user can create and organise substantial Markdown-focused documents, link pages,
databases, and records using stable identities, manage typed records in table
databases, and reconstruct the complete workspace on another machine without an
account or network connection.

A source-tree test, browser-development build, extracted service smoke, schema
declaration, or renderer alone is supporting evidence. It is not V1 acceptance.
Every included outcome must pass through the canonical service and persistence
boundary in packaged AppImage and Debian builds with networking disabled.

## Included outcomes

### Pages and navigation

- Create, rename, nest, move, reorder, favourite, trash, restore, and permanently
  delete pages from Trash.
- Pointer interactions and equivalent keyboard commands issue the same validated
  domain mutations.
- Stable hierarchy, breadcrumbs, selection, and expanded state survive restart.

### Markdown-focused page editor

- A decent production-quality editor supports substantial text editing and common
  Markdown structures, including paragraphs, headings, lists, tasks, quotes,
  dividers, code blocks, links, and page/database/record mentions.
- Stable block/content identities, keyboard editing, multiline clipboard/paste,
  undo/redo, and honest preservation of unsupported structured content are
  dependable.
- Editing survives restart and structured export/restore without rendered HTML
  becoming canonical data.
- React with Tiptap/ProseMirror may be used where the repository direction
  requires it, but the acceptance requirement is the dependable editor outcome,
  not a particular framework or broad Notion editor parity.

### Linked knowledge and navigation

- Page-to-page, page-to-database, database-to-page, and database-record links use
  stable identities rather than mutable names or positions.
- Relation-style linking required by the table datatype model uses stable page or
  record targets and preserves applicable reciprocal/index invariants.
- Usable mentions, outgoing links, backlinks, and navigation distinguish live,
  trashed, and missing targets.
- Links remain correct through rename, move, trash/restore, restart, structured
  export, and backup restore.
- Local search supports the included page and table workflows with safe rendering
  and complete keyboard navigation.

### Table databases and typed records

- Records remain normal pages with stable IDs and normal editor content.
- Table is the only required database view for V1.0.
- The complete intended datatype set validates, edits, persists, filters, and
  sorts where applicable. This includes title, text, number, checkbox, select,
  multi-select, status, date, URL, email, phone, files, location, relation,
  rollup, and formula properties.
- Property creation, rename, reorder, width, visibility, populated type conversion
  with preview, and deletion with explicit consequences are complete.
- Nested filters and deterministic multi-sort are complete for applicable table
  datatypes.
- Empty, null, filtered, deleted, invalid, and large-dataset behavior is
  deterministic and tested.

### Portability and recovery

- Full structured JSON export/restore, Markdown-focused export/import sufficient
  for included page content, CSV table export/import, and attachment-complete
  verified backup are usable offline.
- Import uses bounded staged preflight, compatibility reporting, deterministic
  conflict handling, and transactional rollback where a canonical import mutates
  workspace state.
- Export followed by restore into a new workspace reproduces stable IDs,
  hierarchy, supported and unknown content, table schemas and records, links,
  relations, formulas, and attachment hashes.

### Release quality

- The complete relevant CI and release-security chain passes against one immutable
  commit with no skipped or no-op included gate.
- Installed x86-64 and ARM64 AppImage and Debian packages pass the complete
  included offline user path.
- Included workflows meet WCAG 2.2 AA automation targets and have recorded
  keyboard, 200% zoom, and Linux screen-reader acceptance.
- Representative source and packaged performance, crash-boundary, disk-full,
  corrupt-index, duplicate-writer, migration, restart, and recovery evidence pass
  reviewed budgets.
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

- Database list, board, calendar, gallery, timeline, chart, feed, map, form,
  dashboard, and canvas views or products.
- Sync, collaboration, accounts, sharing, comments, presence, permissions, and
  public publishing.
- AI, MCP, external connectors, automations, webhooks, public APIs, and third-party
  integrations.
- Windows, macOS, mobile, hosted service, and browser-as-product distribution.
- Separate calendar and mail products.
- Application-level encrypted vaults.
- Broad Notion parity beyond the dependable page, linking, and table outcomes
  explicitly included above.

These exclusions do not weaken local confidentiality, path safety, diagnostic
redaction, data-integrity, backup, offline, provenance, migration, recovery, or
accessibility gates.

## Immutable acceptance rule

1. Freeze one candidate commit and its dependency locks.
2. Run complete relevant CI with no missing, skipped, or no-op included gate.
3. Build the four canonical Linux artifacts from that commit.
4. Record complete installed-package acceptance on representative x86-64 and
   ARM64 graphical hosts with networking disabled.
5. Resolve every data-loss, corruption, false-success, offline, security, and P0
   accessibility defect in included workflows.
6. Obtain explicit Quality and Security approval for the exact hashes.
7. Create `v1.0.0` only after approval; never move or reuse a failed tag.

Scope may change only through an explicit Jake-approved edit to this document.
Incomplete included outcomes must not be silently relabelled as post-V1 work.
