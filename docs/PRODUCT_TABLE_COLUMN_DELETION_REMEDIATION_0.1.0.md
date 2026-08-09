# Motion safe table-column deletion brief

Owner: Product Director  
Reviewed: 2026-08-06  
Defect: MOTION-UX-007

## Decision

Motion tables need an explicit, keyboard-operable delete action on each column.
Deletion is a destructive schema edit: one confirmed operation removes the
column definition and that column ID's value from every row. It must never
delete or rewrite another column, row, table, or surviving cell.

A table must retain at least one column. Attempting to delete the only column
is blocked without opening a confirmation. This preserves a usable row identity
and editing surface and matches Motion's existing new-table behaviour.

The smallest safe release reuses the current table model, save queue, snapshot
undo mechanism, confirmation pattern, status region, stable IDs, JSON export,
canonical migration, verified backup, and Trash lifecycle. It does not add a
general schema editor, column menu framework, column deletion from Trash, or
permanent deletion history.

## Verified current behaviour

The focused UI run created `Safety & permits <2026>` with two renamed columns,
two rows, and special-character values. It exercised pointer and keyboard
editing, application relaunch, JSON export, Trash/restore, normal layout, and
the 640 x 800 equivalent-200% layout.

- There are zero **Delete column** or **Column actions** controls at either
  layout.
- `Tab` from the first column-name field moves directly to the second column-
  name field; there is no keyboard deletion stop.
- The table's horizontal overflow remains contained by `.table-wrap` at the
  equivalent-200% layout.
- Both columns, their stable IDs, and all row-value keys survive relaunch and
  Trash/restore.
- JSON export shows that each column ID owns one key in every row's `values`
  object.

A canonical dry run removed column `notes` and every `row.values.notes` key,
then validated, backed up, and restored the result. The post-deletion restore
contained only the surviving `equipment` property and values. A verified
pre-deletion backup restored these targeted values exactly:

```text
Line one
Line two — café 😀 & <permit>
Witness: A&B #42
```

This proves that no persisted-shape or schema migration is required. The risk
is implementing the mutation partially or without adequate consequence/focus
handling.

## Bounded implementation brief

Add a compact direct delete button beside each editable column name. Its
accessible name is `Delete column “<column name>”`. Do not assign a bare
`Delete`/`Backspace` shortcut. Pointer click, `Enter`, and `Space` invoke the
same consequence-specific confirmation and the same atomic save path.

Before confirmation, compute:

- table and column stable IDs;
- current column name;
- total row count; and
- number of rows whose targeted value is non-empty (any value other than the
  empty string, including whitespace, LF-only, zero, and `false`, counts as
  data).

The confirmation names the column and table, states both affected counts, says
that the column and its cell values will be removed, and states that immediate
session undo is available but will not survive application closure. It never
echoes cell contents.

On confirmation, perform one validated mutation: remove the column definition
and only its key from every row, update the existing default view/property
projection, then persist once. Unsupported canonical dependencies outside the
shipped table view must reject the operation with no changes rather than being
silently rewritten.

### Initiation and confirmation acceptance criteria

- [ ] Every column has one visually identifiable delete action adjacent to its
  name at normal and equivalent-200% layouts. Hover is not required to discover
  or operate it; keyboard focus makes it clearly visible.
- [ ] The action's accessible name includes the current column name. Renaming a
  column updates that name without changing its stable ID.
- [ ] Pointer click, `Enter`, and `Space` open the same modal/native confirmation.
  `Delete`, `Backspace`, and ordinary typing never initiate column deletion.
- [ ] For column `Isolation notes` in table `Safety & permits`, two rows, and
  two non-empty target cells, the confirmation communicates all of: column
  name, table name, `2 rows`, `2 cells containing data`, removal of those cell
  values, and the limited session-undo consequence.
- [ ] Empty, whitespace-only, multiline, Unicode, emoji, punctuation, and
  HTML-like values cannot break, inject into, or be disclosed by the
  confirmation; only counts are shown.
- [ ] Renaming, editing, adding a row, or a concurrent revision change between
  initiation and confirmation causes the operation to revalidate against the
  current revision and either show current counts or fail safely.

### Cancellation, failure, and focus acceptance criteria

- [ ] Cancelling by pointer, `Escape`, or the platform confirmation's cancel
  action changes no column, row value, revision, search entry, export, or
  backup content.
- [ ] Cancellation returns focus to the invoking delete button and announces
  `Column deletion cancelled. No data was changed.` through the existing live
  status region.
- [ ] A validation, dependency, revision-conflict, or storage failure restores
  the pre-action in-memory state, leaves canonical data unchanged, returns
  focus to the invoking control, and announces `Column deletion failed. No data
  was changed.` with useful non-sensitive context.
- [ ] Confirmation does not announce success until the canonical save has
  succeeded. `Saving…` or optimistic rendering must not be mistaken for a
  committed deletion.
- [ ] After success, focus moves to the next surviving column-name field; if
  the deleted column was last, focus moves to the previous surviving column-
  name field. Focus never falls to `body` or a removed node.
- [ ] Success announces `Column “<name>” deleted; values removed from <n> rows.
  Undo is available until Motion closes.` Counts use the confirmed committed
  revision.
- [ ] Immediate undo restores the same column ID, original position, name, and
  every targeted cell value, then focuses the restored column name and
  announces `Column deletion undone.` Redo repeats the validated deletion.

### Minimum-column acceptance criteria

- [ ] A table with one column cannot delete that column, whether it has zero or
  many rows and whether its cells are empty or populated.
- [ ] The sole-column delete control remains keyboard discoverable with
  `aria-disabled="true"`. Pointer, `Enter`, or `Space` announces `A table must
  have at least one column. Add another column before deleting this one.` and
  opens no confirmation.
- [ ] Adding a second column immediately enables deletion for both columns;
  deleting either returns the table to one valid column and disables deletion
  of the survivor.
- [ ] Imported legacy tables with zero columns remain loadable under existing
  compatibility policy, but this feature does not create new zero-column
  tables or invent a column silently. Their recovery is outside this bounded
  deletion task.

### Atomic data and lifecycle acceptance criteria

- [ ] A successful deletion atomically removes exactly one column object and
  that column ID from every row's `values`; no stale property key survives in
  Web-v1, canonical-v2, the default view projection, SQLite search, JSON, CSV,
  or verified backup output.
- [ ] Column order, row order, stable table/row/surviving-column IDs, titles,
  and all surviving values remain byte-for-byte unchanged, including LF,
  consecutive/leading/trailing blank lines, special characters, Unicode, and
  emoji.
- [ ] Empty rows and rows missing the optional target key are handled
  deterministically and do not block deletion or create a replacement value.
- [ ] Reload and complete application restart retain the committed absence and
  the exact surviving state. Session undo is intentionally unavailable after
  restart and was disclosed before confirmation.
- [ ] Moving the table to Trash after deletion and restoring it preserves the
  committed deletion; Trash/restore does not resurrect the column. A table in
  Trash cannot expose or run column deletion.
- [ ] A verified backup or JSON export created before deletion restores the
  original column, position, stable ID, and exact values. One created after
  deletion restores the table without that column or stale target keys.
- [ ] A failed/cancelled restore leaves the current deletion state unchanged.
  Clean-profile/workspace restores are validated before becoming active.
- [ ] Search stops returning the deleted column's unique values only after the
  same committed deletion, while unique values in surviving columns remain
  searchable. Undo or pre-deletion restore reactivates the original search
  content without duplicates.

### Layout and accessibility acceptance criteria

- [ ] At normal and equivalent-200% layouts in a 720 px-wide window, each
  column name and its delete control remain readable, focusable, and operable
  inside the existing horizontal table scroller without clipping required
  actions or causing page-level two-dimensional scrolling.
- [ ] Delete controls meet the existing pointer target and visible-focus
  standards and are not identified by colour or an unlabelled `×` alone.
- [ ] Confirmation is keyboard operable, traps focus only while modal, exposes
  a descriptive accessible name/consequence, and returns focus according to
  cancellation/success rules.
- [ ] The sole-column disabled reason, cancellation, failure, success, undo,
  and redo are announced through a polite live region without announcing an
  uncommitted success.
- [ ] Screen readers can distinguish repeated actions by column name and table
  context. Confirmation and announcements pluralise row/cell counts correctly.
- [ ] Focus and announcements remain correct when the deleted column is first,
  middle, or last, when the table has no rows, and when cell content is
  multiline or contains special characters.
- [ ] Focused automated coverage exercises pointer, `Enter`, `Space`, `Escape`,
  cancellation, save failure, success, undo/redo, first/middle/last columns,
  one-column blocking, zero/non-empty row counts, normal/equivalent-200%,
  reload/process restart, Trash/restore, pre/post JSON export, pre/post verified
  backup restore, search removal/reactivation, and accessibility tree/status
  assertions.

## Engineering boundaries

- Reuse existing stable IDs, Web-v1 normalisation, canonical migration,
  snapshot undo/redo, save status, confirmation, export, backup, search, and
  Trash paths.
- Do not add bulk column deletion, a general property-settings panel, arbitrary
  schema dependency rewriting, row deletion changes, column reordering,
  multiline remediation, or new recovery/history infrastructure.
- If a non-default canonical view/filter/sort/group dependency is encountered,
  reject safely and return a separate follow-up requirement; do not silently
  broaden this release.

## Verification handoff

Engineering should return a focused trace at normal and equivalent-200%
showing pointer and keyboard cancel/confirm, exact affected counts, minimum-
column blocking, save-failure rollback, focus/status transitions, undo/redo,
multiline/special-character survival, reload/restart, Trash/restore, pre/post
JSON and verified-backup clean restores, and search projection changes.

