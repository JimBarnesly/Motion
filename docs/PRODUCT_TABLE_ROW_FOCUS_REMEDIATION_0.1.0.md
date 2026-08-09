# Motion table row insertion focus remediation

Owner: Product Director  
Reviewed: 2026-08-06  
Defect: MOTION-UX-009  
Priority: P0 editor accessibility/usability

## Selected defect

**Creating a table row discards keyboard focus instead of placing it in the new row.**

Every new table starts with zero rows, so **+ New row** is the required route to
the table's first useful value. Pointer click, Enter, and Space all use the same
handler: it appends a row, persists, and synchronously rerenders the table. The
rerender removes the invoking button without assigning a successor. Focus falls
to `body`; the new row's first cell is neither focused nor announced. Pressing
Tab then restarts near the beginning of the application instead of continuing
in the row.

This is the highest-impact verified remaining editor defect outside
MOTION-UX-005 through UX-008. Current text, Heading 1, completed checklist,
multiline code, table-cell search, reload, and constrained-layout rendering
passed focused inspection. The defect interrupts the mandatory first-data step
of every table and is worse at equivalent-200%, where navigation is collapsed
and the new row may not be near the user's focus or viewport.

## Reproduction evidence

A focused clean-profile Playwright journey passed at 1280 x 800 and 640 x 800
(equivalent-200%) while asserting the current defect:

1. Create and persist a document containing text, Heading 1, a checked
   checklist item, and two-line code.
2. Reload; all four block types, text, code line break, and checked state remain.
3. Create a table using the persistent **New table** action.
4. Focus **+ New row** and press Enter.
5. One row is created, but `document.activeElement` is `BODY`; no cell or stable
   table control owns focus.
6. Enter `Unique row focus marker 731` using direct test targeting, wait for the
   confirmed saved state, and reload. The exact value survives and search for
   `focus marker 731` returns the owning table.

Source inspection confirms pointer and Space activation reach the same click
handler in `apps/web/app.js`. That handler calls `persist(); render();` without
capturing the row ID, awaiting save, scrolling the row, announcing insertion,
or restoring focus. This is an interaction defect, not row-model, search, or
persistence corruption.

## Bounded implementation brief

Change only the existing **+ New row** command. Generate the new stable row ID,
append exactly one row using the current column projection, render it, and move
focus to its first editable cell after the existing persistence boundary
confirms success. Bring that cell into view using the nearest/least disruptive
scroll alignment.

If the save fails, roll back the unconfirmed row, keep the table active, return
focus to **+ New row**, and announce that no row was added. Do not claim a row
is durable before save confirmation.

### Usability and focus acceptance criteria

- [ ] Pointer click, Enter, and Space on **+ New row** each create exactly one
  row through the same command; ordinary typing, Delete, or Backspace do not.
- [ ] After confirmed creation, focus is in the first editable cell of the new
  row, with its value selected only if a non-empty default was intentionally
  supplied. The row is scrolled into view without moving another row.
- [ ] The focused cell's accessible name uses the current first-column name.
  Screen readers announce the cell name and editable role, not `body` or an
  unlabelled input.
- [ ] The status region announces `Row added and saved.` only after persistence
  confirmation. Save progress and failure remain distinguishable.
- [ ] Repeated deliberate activations create distinct rows with stable unique
  IDs. A double event or activation while the command is pending cannot create
  duplicate rows or IDs.
- [ ] After entry, Tab proceeds through that row's remaining cells and row
  actions in the existing logical order; Shift+Tab reaches the preceding table
  control. Focus never restarts at application navigation.
- [ ] With zero columns in an imported legacy table, row creation is disabled
  or rejected with a clear announced reason and stable focus. This task does
  not invent a property or migrate that unsupported table silently.

### Persistence and failure acceptance criteria

- [ ] The committed row contains one key for each current column ID, preserves
  column order, and changes no existing page, block, column, row, cell, ID, or
  sibling order.
- [ ] A value entered in the focused cell survives confirmed save, reload,
  complete application restart, and forced termination/relaunch with the same
  row ID and exact whitespace, LF, Unicode, emoji, punctuation, and HTML-like
  text.
- [ ] Save failure removes the optimistic row from memory and view, never shows
  `Saved`, returns focus to **+ New row**, and announces `Row could not be
  saved. No row was added.` A retry creates one fresh valid row.
- [ ] A revision or schema change while insertion is pending is serialized or
  rejected safely; the row is never saved against a partial/stale column set.
- [ ] Undo after successful insertion removes exactly that row and moves focus
  to **+ New row** or the nearest surviving row. Redo restores the same row ID,
  values, position, and focus destination within the current session.

### Search, Trash, and recovery acceptance criteria

- [ ] After its value is saved, search finds the new row and keyboard or pointer
  activation opens the owning table with focus on the matching row. Before
  confirmation or after failed insertion it produces no stale result.
- [ ] Moving the table to Trash and restoring it preserves the row ID/value and
  searchability after restart. A table in Trash exposes no row-add command.
- [ ] JSON export and a verified backup made after confirmed insertion contain
  the row once. Clean-profile/workspace restore reproduces its exact ID, values,
  column mapping, order, and search result without duplicates.
- [ ] A pre-insertion backup restores without the row. Cancelled or failed
  restore leaves the current table, row, focusable editor, and search index
  unchanged.
- [ ] Deleting the row after insertion removes it and its search projection
  only after confirmed persistence; this task does not change row-deletion UX.

### Normal and equivalent-200% acceptance criteria

- [ ] At normal layout and a 720 px-wide equivalent-200% layout, **+ New row**
  and the new row remain reachable without page-level two-dimensional
  scrolling; the existing table scroller may scroll horizontally.
- [ ] At both layouts, activation brings the first cell fully into the visible
  table viewport, shows an unobscured focus indicator, and does not leave focus
  in a closed navigation overlay or off-screen element.
- [ ] Long column names and enough columns to overflow horizontally do not hide
  the focused first cell or cause simultaneous horizontal page scrolling.
- [ ] Focused automated coverage exercises pointer, Enter, Space, pending
  double activation, save failure/retry, multiple rows, zero-column rejection,
  normal/equivalent-200%, reload/process restart, search selection,
  Trash/restore, JSON restore, verified-backup clean restore, undo/redo, and
  active-element/accessibility assertions.

## Engineering boundaries

- Reuse the existing row model, stable-ID generation, table renderer, save
  queue, status region, undo snapshots, search projection, Trash, export, and
  verified-backup paths.
- Do not redesign tables, add row forms or modals, change cell types, add bulk
  entry, alter table search, revise row deletion, implement column deletion, or
  combine this with MOTION-UX-005 through UX-008.
- A small shared post-render focus helper is acceptable only if used to make
  this row-insertion path reliable; do not broaden into an editor-navigation
  refactor.

## Verification handoff

Engineering should return one focused two-layout trace showing pointer, Enter,
and Space insertion; pending-event serialization; save failure/retry; focus and
announcement transitions; first-cell entry; reload/restart; search routing;
Trash/restore; JSON and verified-backup clean restore; and undo/redo. Product
will verify that a keyboard user can create a table and immediately enter its
first durable value without traversing the application again.
