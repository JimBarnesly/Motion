# Motion 0.1.0 product acceptance checklist

Owner: Product Director  
Decision authority: Managing Director  
Scope frozen: 2026-08-05

## Release intent

Motion 0.1.0 is the smallest valuable single-user Linux desktop release: a
person can create, organise, link, find, attach, export, back up, restore, and
recover a local workspace without an account or network connection.

This checklist freezes product scope. Quality & Release owns execution and
evidence. The separate release security gate in
[`OPERATIONS_SECURITY_REVIEW.md`](OPERATIONS_SECURITY_REVIEW.md) remains
binding and is not repeated here.

## Acceptance rule

Accept the product scope only when every must-ship item below passes against
the same immutable release commit and packaged artefacts. A browser development
build, service-only smoke test, source-tree test, or passing implementation
test is supporting evidence but does not replace the observable packaged-app
criteria.

Run the complete path with networking disabled on representative x86-64 and
ARM64 Linux hosts, using both the AppImage and Debian package. A failure that
loses acknowledged data, requires a network/account, corrupts the workspace,
or falsely reports success blocks 0.1.0. Record lesser defects for explicit
Quality disposition without silently weakening a criterion.

## Must ship

### 1. Installable offline Linux desktop

- [ ] The checksum-verified AppImage launches while the host is offline and
  opens a usable Motion window without downloading a runtime.
- [ ] The Debian package installs, launches from both `motion-desktop` and the
  **Motion** desktop-menu entry, and both paths open the same workspace.
- [ ] The packaged UI identifies a `Local workspace`; it never identifies
  itself as browser development mode and never asks for an account, login,
  subscription, server, or network connection.
- [ ] Normal close and relaunch restore the last selected page and its last
  confirmed content.

### 2. Durable pages and basic block editing

- [ ] A user can create and rename a root page, create a nested child, and
  reorder pages where the UI permits it; hierarchy and order survive relaunch.
- [ ] A user can create and edit the shipped paragraph, heading, task, code,
  and divider blocks, change their order, complete the task, and see the same
  types, content, order, and task state after relaunch.
- [ ] The save indicator progresses from `Saving…` to `Saved to Motion` only
  after the native persistence path confirms the save.
- [ ] Force-terminating Motion after `Saved to Motion`, then relaunching,
  preserves the confirmed state without duplicate pages or blocks.

### 3. Stable links and backlinks

- [ ] Entering a `[[Page title]]` link creates an outgoing link to the selected
  page and a backlink on the target page.
- [ ] Renaming the target page and relaunching preserves link resolution and
  displays the current title, proving that link identity does not depend on
  title or hierarchy.

### 4. Lightweight table data

- [ ] A user can create a table page, add a property, add at least two rows,
  and enter distinct values.
- [ ] Table title, property definition, row count, and values survive relaunch.
- [ ] Search can find a value stored in the table and open the owning content.

### 5. Local search

- [ ] `Ctrl+K` opens search and can find separately identifiable text in a page
  and a table value through the canonical local index while offline.
- [ ] A selected result opens the correct content using keyboard controls.
- [ ] Search still returns the expected results after normal relaunch, forced
  termination after a confirmed save, trash, and restore.

### 6. Confirmed local attachments

- [ ] Attaching a known small file shows its filename, byte count, and hash
  prefix only after durable ingestion is confirmed.
- [ ] The attachment remains associated with the workspace after relaunch.
- [ ] A failed or cancelled attachment action does not report success or leave
  a canonical attachment record presented as confirmed.

### 7. Portable export, verified backup, and restore

- [ ] Exported canonical JSON parses successfully and contains stable IDs,
  page hierarchy, edited blocks, links, and table data created in this test.
- [ ] A verified backup includes a versioned manifest and checksum inventory
  covering the accepted workspace and attachment.
- [ ] After changing the live workspace, restoring that backup **as a new
  workspace** first shows an accurate preview and then reproduces the original
  pages, hierarchy, block content, table data, links, and attachment inventory.
- [ ] Creating a new verified backup from the restored workspace retains the
  attachment entry and checksum, demonstrating reconstructability rather than
  a display-only restore.

### 8. Reversible deletion

- [ ] Deleting a parent page after confirmation moves it and its nested child
  to Trash, removes them from ordinary navigation and search, and survives
  relaunch.
- [ ] Restoring the parent returns the parent, child, content, and searchability
  after relaunch without duplicates.
- [ ] Cancelling deletion leaves the workspace unchanged.

### 9. Minimum operability and accessibility

- [ ] Using only the keyboard, a user can create a page, choose a block type,
  edit and move a block, open search, open a result, cancel deletion, and
  restore from Trash; focus remains visible and no control traps focus.
- [ ] At 200% UI zoom, navigation, editor, table controls, dialogs, status, and
  context panels remain readable and operable without hiding required actions.
- [ ] A Linux screen reader exposes usable names for the tested navigation,
  editor, search, table, Trash, save state, attachment result, and restore
  controls; state is not communicated by colour alone.

### 10. Package lifecycle preserves user data

- [ ] Removing and reinstalling the Debian 0.1.0 package preserves the accepted
  workspace and attachments.
- [ ] Uninstall removes application launchers and binaries but does not
  silently delete the user's workspace data.

## Deferred beyond 0.1.0

The following are explicitly not required to accept 0.1.0:

- Replacing the Web-v1 compatibility editor with React and
  Tiptap/ProseMirror; full rich-block selection, transform, clipboard,
  drag/drop, undo/redo, IME, and long-document depth.
- Full page organisation: arbitrary move, favourites, archive, permanent
  deletion policy, and complete pointer/keyboard parity.
- Collection depth beyond the shipped lightweight table: the full property
  catalogue, record pages, filters, multi-sort, grouping, saved table state,
  list/board/calendar/gallery/timeline/chart/form views, relations, rollups,
  formulas, templates, and large-table virtualisation.
- Search snippets, highlighting, filters, recent-search controls, deep links,
  broken-link UX, graph view, and the strict sub-200 ms representative
  benchmark. The observed 224.36 ms benchmark miss is tracked as
  `MOTION-RC-001`; functional offline search remains must-ship.
- Large-file attachment streaming, media/PDF blocks, scheduled backups,
  encrypted archives/vaults, static HTML export, and general Markdown/CSV or
  third-party import.
- Windows, macOS, mobile, browser-as-product, sync, collaboration, accounts,
  permissions, comments, presence, public publishing, plugins, automations,
  public API, AI, MCP, remote connectors, hosted services, and telemetry.
- Cross-version upgrade/migration acceptance from an older Motion release;
  0.1.0 has no predecessor. Cold-copy rollback documentation remains an
  operational requirement, not a product capability.

These exclusions do not waive data-integrity, offline, packaging, or external
security failures in the must-ship path. Candidate immutability, CI evidence,
artefact provenance, release execution, and rollback procedure remain with
Quality/Release and Operations/Security rather than expanding product scope.

## Decisions requiring Jake

None at scope freeze. The current brief is sufficient to define 0.1.0.

Escalate only if the board proposes one of these scope changes:

- dropping either x86-64 or ARM64 Linux support already represented by the
  release pipeline;
- publishing 0.1.0 with a failed must-ship criterion; or
- promoting any deferred platform, networked, collaborative, or AI capability
  into 0.1.0.

## Release hand-off

Quality & Release should execute this checklist together with the more detailed
host procedure in [`QUALITY_RELEASE_STATUS.md`](QUALITY_RELEASE_STATUS.md),
record results against the frozen commit and exact artefact hashes, and return
a go/no-go recommendation. Product reopens scope only for a demonstrated user
outcome gap, not to absorb unrelated hardening or parity work.
