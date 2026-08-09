# Motion multiline table-cell preservation remediation

Owner: Product Director  
Reviewed: 2026-08-06  
Defect: MOTION-UX-006

## Decision

Motion text cells support multiline plain text. A logical line break is stored
canonically as LF (`U+000A`). Consecutive and leading/trailing line breaks are
meaningful user data and must not be trimmed, collapsed, or replaced with an
empty string. CRLF and bare CR received from paste/import are normalised to LF
before persistence.

This is an editor-boundary defect, not a new table property type or rich-text
feature. The persisted Web-v1 and canonical-v2 models already accept newline-
bearing strings, JSON and verified backups retain them, and SQLite FTS indexes
them. The smallest release replaces the lossy single-line cell boundary with a
real multiline plain-text editor and makes display/search whitespace handling
consistent.

## Verified current behaviour

Test value:

```text
Hydraulic isolation
Permit signed — café 😀

Witness: A&B
```

| Stage | Verified result |
| --- | --- |
| Keyboard entry | `Shift+Enter` inserts no newline; the DOM and IndexedDB immediately contain `Hydraulic isolationPermit signed…`. |
| Save/reload | The flattened value is saved and remains flattened. |
| Existing LF data | IndexedDB retains all three LF characters, while the rendered `<input>` displays one concatenated line. |
| Application restart | Persisted LF remains intact underneath; the visible control remains flattened. |
| Edit after restart/restore | Typing one character writes the flattened visible value back and irreversibly removes every stored LF. |
| JSON export/clean restore | Export and restored IndexedDB retain the exact LF string; the restored control still displays it flattened. |
| Verified backup/restore | Backup verifies and isolated restore returns the exact LF string. |
| Trash/restore | The exact LF string survives unchanged. |
| Browser search | A token on one line finds the table but shows only `1 rows`; a phrase spanning the line boundary returns no result. |
| Native search | FTS matches both a single-line query and words spanning a newline; its raw snippet contains the original LF characters. |
| Normal/equivalent-200% layout | The cell remains a 36 px single-line `INPUT`; line structure is invisible at both layouts. |

The loss is caused by `renderDatabase()` in `apps/web/app.js`, which renders
every text cell as `<input value="…">`. HTML single-line inputs strip line
breaks. The subsequent input handler persists that stripped `.value`, turning
a display defect into data loss on the next edit.

## Bounded implementation brief

Replace the existing text-cell input with a multiline plain-text editing
control while preserving the current table model, stable IDs, save queue,
Trash lifecycle, export/backup formats, and search index. Normalise text-cell
line endings at user-input and import boundaries. Present multiline values and
search snippets without concatenating adjacent words.

Do not add rich text, Markdown rendering, formulas, additional property types,
row-detail pages, column deletion, or general table redesign.

### Data-fidelity acceptance criteria

- [ ] Typing or pasting `alpha`, LF, `beta`, LF, LF, `gamma` stores exactly
  `alpha\nbeta\n\ngamma`; leading and trailing LF, consecutive LF, spaces,
  Unicode, emoji, punctuation, and HTML-like text remain unchanged.
- [ ] CRLF and bare CR from keyboard composition, clipboard, JSON import, or
  native migration normalise deterministically to LF before the confirmed
  save. No other whitespace is normalised.
- [ ] The exact canonical LF string survives save completion, reload, complete
  application-process restart, JSON export/clean-profile restore, verified
  backup/clean-workspace restore, and Trash/restore.
- [ ] Merely rendering, focusing, blurring, searching, resizing, or opening a
  multiline cell cannot mutate its persisted value or revision.
- [ ] Editing one character in a pre-existing multiline cell changes only that
  character; it cannot remove, add, reorder, or replace unrelated LF
  characters.
- [ ] A failed or conflicted save leaves the prior canonical multiline value
  recoverable and does not expose the unsaved value through the canonical
  search index.
- [ ] JSON export and verified backup contain the same LF string as canonical
  storage. CSV export quotes multiline fields according to RFC 4180 and
  round-trips the embedded LF without splitting one record into several.

### Keyboard-editing acceptance criteria

- [ ] While editing a text cell, `Enter` inserts one LF at the caret and
  `Shift+Enter` also inserts one LF; neither submits, changes row, or silently
  removes text.
- [ ] `Tab` commits through the existing save path and moves focus to the next
  editable cell; `Shift+Tab` moves to the previous cell. Existing forward and
  reverse traversal order remains stable across rows.
- [ ] Arrow, Home/End, selection, Backspace/Delete, undo/redo, clipboard paste,
  and IME composition work as native multiline text editing operations and do
  not trigger table-level shortcuts unexpectedly.
- [ ] Pointer placement and keyboard caret movement can edit the first, middle,
  last, and blank lines without moving focus or scrolling the entire page
  unexpectedly.
- [ ] A documented non-destructive way to leave the cell remains available by
  keyboard (`Tab`/`Shift+Tab`); multiline entry must not create a focus trap.

### Display acceptance criteria

- [ ] Every stored LF is displayed as a visible line break in edit and read
  states; adjacent lines never concatenate visually.
- [ ] The row expands to show at least six text lines without overlap,
  clipping, or covering row controls. Longer content may use an internal
  vertical scrollbar while preserving the full value.
- [ ] Empty lines remain visibly representable, and leading/trailing blank
  lines are not removed when the control is rendered or resized.
- [ ] At normal and equivalent-200% layouts in a 720 px-wide window, multiline
  content, caret, focus indicator, and required row controls remain usable.
  Horizontal overflow stays within the existing table scroller; the page does
  not require simultaneous horizontal and vertical page scrolling to edit a
  cell.
- [ ] Reflow or control auto-sizing does not cause disruptive layout oscillation
  on each keystroke or move focus/caret position.

### Search acceptance criteria

- [ ] A distinctive token from any line returns the owning table after the
  same confirmed save that persisted the cell.
- [ ] A query whose tokens occur on adjacent lines matches in both native and
  browser-development search; line boundaries act as word separators, never
  as concatenation or an exact-phrase dead zone.
- [ ] Result snippets include useful matching row context and convert LF runs
  to bounded readable spacing or an explicit visual separator. They must not
  concatenate `alpha\nbeta` as `alphabeta`, render raw escape text (`\\n`), or
  expand the dialog with unbounded blank lines.
- [ ] Snippet generation escapes HTML-like cell text and preserves Unicode; it
  never interprets cell content as markup.
- [ ] Editing, restart, Trash/restore, JSON clean restore, verified-backup clean
  restore, and index rebuild preserve the same searchable tokens. Trashed
  tables remain excluded from ordinary results.

### Accessibility acceptance criteria

- [ ] Each cell is exposed as an accessible multiline textbox (`aria-multiline`
  semantics) with a name that distinguishes its column and row position; it is
  not announced as a single-line input.
- [ ] Screen readers announce the cell label, multiline editability, value,
  focus, and validation/save failure without requiring pointer inspection.
- [ ] `Tab`/`Shift+Tab` traversal, caret keys, `Enter`, `Shift+Enter`, and search
  result activation are covered at normal and equivalent-200% layouts with no
  focus trap or unexpected table navigation.
- [ ] Focus remains visibly identifiable at 200%, and the caret/current line is
  not hidden beneath sticky headers, row tools, or internal scroll boundaries.
- [ ] Search snippets have an accessible name containing the owning table and
  readable matched context; line separation is not conveyed by colour alone.
- [ ] Automated coverage asserts active element, selection/caret survival where
  supported, accessible role/name/multiline state, and keyboard traversal.

### Compatibility and migration acceptance criteria

- [ ] No persisted-shape change or schema bump is introduced solely to support
  multiline text: Web workspace schema 1 and canonical workspace schema 2
  continue storing text cells as strings.
- [ ] Pre-fix workspaces/backups containing LF render and edit without data
  change. Pre-fix values already flattened by the old control remain unchanged;
  Motion must not guess where missing line breaks belonged.
- [ ] Pre-fix CRLF or bare-CR cell strings are normalised once to LF at the
  first controlled import/edit write. The operation is idempotent and covered
  by migration/normalisation tests.
- [ ] Loading an older workspace is read-only until an explicit import
  migration or user edit is successfully committed; opening it must not
  silently rewrite all cells.
- [ ] Newer or unsupported structured cell values retain the existing
  validation/compatibility behaviour and are not stringified as
  `[object Object]` under this change.
- [ ] Fixtures cover LF, CRLF, bare CR, consecutive/leading/trailing LF, empty
  text, 100,000-character boundary handling, Unicode/emoji, JSON, CSV, verified
  backup, restart, Trash, and search projection rebuild.

## Verification handoff

Engineering should return one focused normal/equivalent-200% trace showing
keyboard entry, paste, exact persisted bytes/JSON string, reload, process
restart, JSON and verified-backup clean restores, Trash/restore, an edit that
preserves untouched line breaks, cross-line search/snippet behaviour, and the
multiline accessibility tree. Product verifies semantics and usability;
Quality retains broader regression ownership.

