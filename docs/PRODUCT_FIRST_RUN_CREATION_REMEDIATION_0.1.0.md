# Motion first-run table creation remediation

Owner: Product Director  
Reviewed: 2026-08-06  
Defect: MOTION-UX-008  
Priority: P0 first-run usability

## Selected defect

**The table creation route disappears after a new user creates their first
page.**

On a clean profile the central empty state offers **New page** and **New
table**. Choosing the natural **New page** route creates durable useful page
content, but removes the only **New table** action. The persistent sidebar `+`
and every child `+` create documents only. The Motion/Home button keeps the
active page open. Restart preserves both the page and the missing route.

This is the highest-impact verified first-run defect because a page-first user
cannot reach the must-ship table workflow at all by pointer or keyboard. Search,
save/restart, Trash discovery, backup discovery, and block-type selection are
reachable; the shipped table capability is healthy when selected before the
first page. The defect is therefore one missing persistent creation action,
not a need for broad onboarding.

## Reproduction evidence

Focused Playwright checks started with separate clean browser profiles.

### Page-first path

1. First launch shows `Your workspace is ready`, **New page**, and **New
   table**. Trash visibly reports `Trash is empty`.
2. Activate **New page** with the keyboard, title it `First durable note`, add
   `Pump inspection completed and saved locally.`, and change the initial block
   to Heading 1 through its visible block-type control.
3. Wait for the confirmed saved state. Search for `inspection`; the saved page
   is returned.
4. Inspect every page-creation control. Only root **Add page** and **Add page
   inside First durable note** exist. **New table** count is zero.
5. Activate **Open workspace home**. The active page remains; **New table** is
   still absent.
6. Close and launch a new page in the same profile. Title, block text, and
   Heading 1 type survive; **New table** remains absent.
7. At 640 x 800 (equivalent-200%), open navigation. Search, page actions,
   Export/Restore, native backup controls, and Trash remain represented; no
   table action exists.

### Control path

On another clean profile, choosing **New table** first, naming it
`Commissioning register`, adding a row, and saving `Pump P-101 accepted`
survives relaunch exactly. Root page creation remains available afterwards.

Canonical separate-process restart and verified backup/isolated restore tests
also passed. This isolates the defect to creation-route discovery and
availability rather than table persistence or recovery.

## Bounded implementation brief

Add one persistent, visibly labelled **New table** action beside the existing
root **Add page** action in the **Pages** navigation heading. It creates a root
database page through the existing `addPage(null, "database")` path. Retain the
clean empty state's existing **New page** and **New table** actions.

Use text plus the existing table icon (for example `+ Table` visually, with
accessible name `New table`) rather than an unexplained second `+`. Do not add
a welcome tour, wizard, templates, workspace picker, command palette, creation
menu framework, nested-table feature, or redesigned home page.

### Usability acceptance criteria

- [ ] On pristine first launch, **New page** and **New table** remain equally
  visible in the central empty state and accurately create a document or root
  table respectively.
- [ ] After creating any page, block, table, child page, or restoring content,
  a persistent, visually labelled **New table** action remains in the **Pages**
  navigation without requiring the user to delete content, return to a hidden
  state, or know a shortcut.
- [ ] The persistent action is distinguishable from **Add page** without hover,
  tooltip, source knowledge, or icon interpretation alone.
- [ ] One activation creates exactly one root table with the existing default
  title, one default text column, zero rows, and new stable IDs. It never nests
  beneath the active page or changes the active page's content.
- [ ] After creation, the new table becomes active and its title is selected or
  focused so the user can immediately name it; adding a row and entering a
  value uses the existing table workflow.
- [ ] Page-first and table-first users can both reach page, block, and table
  creation without different hidden prerequisites.
- [ ] Search, Trash, Export JSON, Restore, Attach file, Verified backup, and
  Restore verified remain discoverable and are not displaced or obscured by
  the added action.
- [ ] Creating a table does not add placeholder/sample rows or content.

### Accessibility acceptance criteria

- [ ] The persistent control is a native button with accessible name **New
  table**, a visible text label, and the same meaning at both layouts. Its icon,
  if present, is decorative.
- [ ] Pointer click, `Enter`, and `Space` run the same creation path. Ordinary
  typing, `Delete`, and `Backspace` cannot create a table accidentally.
- [ ] In navigation order, **Add page** and **New table** are adjacent and
  reachable before the page tree. Focus is clearly visible and neither control
  traps focus.
- [ ] Successful activation moves focus to the new table title and the status
  region announces the existing save progression without claiming success
  before persistence confirmation.
- [ ] At equivalent-200%, activating **New table** from the open navigation
  closes the navigation overlay, exposes the new table, and focuses its title;
  focus never remains inside a hidden sidebar.
- [ ] Screen readers announce `New table`, `Database title`, save success/failure,
  Search, Trash, and backup controls with distinct usable names; creation state
  is not conveyed by colour alone.
- [ ] Automated coverage starts from a clean profile and completes both
  page-first and table-first routes using pointer and keyboard at normal and
  equivalent-200% layouts, asserting active-element movement and accessible
  names.

### Persistence acceptance criteria

- [ ] The creation command enters `Saving…` and reaches `Saved to Motion` only
  after the existing native persistence boundary confirms the table.
- [ ] After confirmed save, normal reload, complete application-process
  restart, and forced termination/relaunch restore exactly one table with the
  same table/column IDs, title, row count, values, active selection, and sibling
  ordering.
- [ ] Existing pages, block IDs/types/text, hierarchy, links, table data, and
  active search projections remain unchanged except for adding the new root
  table.
- [ ] Repeated activation is serialized: each deliberate activation creates
  one distinct table, while double events or a pending save cannot create
  accidental duplicate IDs or duplicate saves.
- [ ] A creation save failure announces `Table could not be saved` (or equally
  specific wording), never displays `Saved`, and keeps the unsaved table visibly
  identified with a safe retry path. Relaunch must not present an unconfirmed
  table as durable.
- [ ] Browser-development mode continues to identify IndexedDB honestly;
  packaged native mode continues to identify the Motion-native save path. This
  change introduces no account or network dependency.

### Recovery acceptance criteria

- [ ] Deleting the newly created table after confirmation moves it to Trash;
  Trash restore recovers its title, default property, added rows/values, stable
  IDs, and searchability after relaunch without duplicates.
- [ ] The persistent **New table** action remains available while Trash is
  empty, populated, or contains every prior active page.
- [ ] JSON export and a verified backup created after table save contain the
  new table's stable IDs, column definition, rows, and values. Clean-profile/
  clean-workspace restore reproduces them exactly.
- [ ] Cancelling or failing restore leaves the current first-run workspace and
  creation controls unchanged; restore never removes the persistent table
  action.
- [ ] A backup made before table creation restores without the table, while
  still exposing the persistent **New table** action so the user can create one.
- [ ] Search finds supported saved table content through the existing search
  path after restart and Trash restore. This task does not redesign search
  snippets or routing.

### Normal and equivalent-200% layout acceptance criteria

- [ ] At normal layout, **Add page** and **New table** fit in the **Pages**
  heading without overlapping the heading, page tree, or each other and meet
  existing pointer-target requirements.
- [ ] At 720 px window width and equivalent-200% layout, **Open navigation**
  reveals both creation actions without horizontal sidebar scrolling. The
  footer's Export/Restore/backup actions and Trash remain keyboard reachable.
- [ ] Creating a table from either layout reveals and focuses the title without
  clipped required controls, hidden focus, or simultaneous horizontal and
  vertical page scrolling.
- [ ] The sidebar may scroll vertically at constrained height, but creation,
  Search, Trash, and recovery controls remain reachable by pointer and keyboard
  and are not fixed outside the scrollable area.

## Engineering boundaries

- Reuse the existing `addPage` database branch, default empty table, stable-ID
  generation, save queue, render/focus logic, sidebar, status region, search,
  Trash, export, and backup paths.
- Do not add onboarding steps, sample data, tutorials, templates, nested table
  creation, a slash command, creation modal, general sidebar redesign, or new
  persistence/recovery infrastructure.
- Do not combine this item with multiline-cell, column-deletion, table search,
  packaging, or security remediation.

## Verification handoff

Engineering should return one focused trace showing clean-profile page-first
and table-first creation by pointer and keyboard, normal/equivalent-200%
navigation and focus, save/failure state, restart/forced-restart persistence,
Trash/restore, search, and JSON/verified-backup clean restore. Product verifies
that an unprompted page-first user can discover and create a durable table;
Quality retains broader release regression ownership.

