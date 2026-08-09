# Motion 0.1.0 table workflow review

Owner: Product Director  
Reviewed: 2026-08-06

## Outcome

Real table title, column, row, and cell edits survived reload, a fresh page
application launch, Trash/restore, JSON export, deletion of the browser
development database, and clean restore. Special characters survived exactly.
The 640 px equivalent-200% layout kept the table reachable and horizontally
scrollable.

**Highest-impact verified defect: MOTION-UX-005 — table cell search results are
not end-to-end usable.**

- Browser development search ignores table cells and reports `No results` for
  a unique persisted value before restart and after clean restore.
- The current SQLite projection does index `row.values` and returns the stable
  row ID, owning table title, and matching snippet.
- The native Web-v1 result router accepts only page and block IDs, so it drops
  that row-ID hit instead of opening the owning table.

This is higher impact than the other observed table limitations because users
can safely store a sizeable structured table but cannot retrieve a remembered
cell value through Motion's primary find workflow. The frozen 0.1.0 acceptance
scope requires a distinct table value to be searchable and openable.

## Verified workflow and evidence

The focused Playwright run used pointer and keyboard interaction to:

1. create `Commissioning & acceptance table`;
2. add and rename a second column;
3. add three rows with both pointer and keyboard, then delete one row;
4. enter four distinct values, use `Tab` between cells, and include HTML-like
   characters, quotes, Unicode, emoji, punctuation, and a multiline attempt;
5. close the page and launch a fresh page in the same browser profile;
6. repeat the visible-table check at 640 x 800 (equivalent 200% layout);
7. search before restart, while trashed, and after clean restore;
8. move the table to Trash and restore it; and
9. export JSON, delete the IndexedDB database, and restore into the empty
   profile.

Observed exact values after entry, relaunch, Trash restore, and clean restore:

```text
P-101 & <primary> "feed" café 😀
Line oneLine two — Acceptance marker beta
XV-202 / return
Special: Ω ± 50% #ready? yes/no
```

`Shift+Enter` in the second cell did not preserve a line break: the native
single-line input flattened `Line one\nLine two` to `Line oneLine two`. No
column-delete control exists. These are verified secondary usability gaps, but
they are not included in the bounded search fix below.

Search returned `No results for “Acceptance marker beta”.` in the browser
before restart and after clean restore. Search correctly returned no result
while the table was in Trash.

The current canonical SQLite reproduction returned:

```json
[{"workspaceId":"w","entityId":"row-1","title":"Commissioning table","snippet":"[Acceptance] [marker] [beta]"}]
```

Source inspection confirms the split:

- `packages/storage/src/index.ts` includes scalar `record.values` in each row's
  FTS entry and inherits the owning table title.
- `apps/web/app.js` browser fallback checks page titles and document blocks
  only.
- `apps/web/app.js` native routing resolves a hit only when `entityId` is a page
  or block ID; a row ID is discarded.

Canonical separate-process restart and verified backup/isolated restore tests
passed. The packaged native UI itself was not interactively driven because the
available ARM64 AppImage has no display/GUI automation session; therefore the
native backup button and native result selection remain integration evidence,
not a claimed manual UI pass.

## Bounded implementation brief

Make table row values searchable and openable through the existing search
dialog in both native and browser-development modes. Reuse stable row and table
IDs, the SQLite FTS projection, the existing save transaction, and the current
search dialog. Do not redesign tables or add new views.

### Data-survival acceptance criteria

- [ ] Saving a non-empty text cell commits its row search projection with the
  same successful revision as the table edit; a failed/conflicted save exposes
  neither the new canonical value nor a new search hit.
- [ ] After editing a cell, the old unique value produces no hit and the new
  unique value produces one hit after the confirmed save.
- [ ] Row IDs, column IDs, cell values, row order, and table ownership are
  unchanged by indexing, result selection, reload, full application restart,
  Trash/restore, JSON export/clean restore, and verified backup/clean-workspace
  restore followed by restart.
- [ ] Deleted rows and trashed tables produce no ordinary search result;
  restoring a table reactivates its original searchable rows without duplicate
  entries.
- [ ] Rebuilding the index from canonical workspace data produces the same
  deterministic row hits and never makes the FTS index a second source of
  truth.

### Usability acceptance criteria

- [ ] A unique full cell value, a distinctive token, and a case variation each
  return the owning table in native and browser-development search.
- [ ] Each result identifies the table and includes a bounded, escaped snippet
  containing the matched value or sufficient row context to distinguish it.
- [ ] Selecting a result opens the correct table and scrolls the matching row
  into view; it must not silently discard a valid row-ID hit.
- [ ] Multiple matching rows are ordered deterministically and do not flood the
  dialog with indistinguishable duplicate table entries.
- [ ] Empty and unsupported structured values do not produce noise such as
  `[object Object]` or raw JSON; numeric and Boolean handling is explicit and
  consistent between native and browser modes.
- [ ] Search behaviour is identical after edit, restart, Trash/restore, JSON
  clean restore, and verified backup clean restore.

### Accessibility acceptance criteria

- [ ] Pointer, `Tab`/`Shift+Tab`, `Enter`, and `Space` can open a cell-value
  result and reach the matching row without a focus trap.
- [ ] Opening search moves focus to the search field; closing it returns focus
  to the invoking control; selecting a result moves focus to a stable control
  in or immediately before the matching row.
- [ ] The result's accessible name includes the owning table and useful match
  context; table/row identity and the snippet are not conveyed by colour alone.
- [ ] At normal and equivalent-200% layouts in a 720 px-wide window, the result,
  snippet, table identity, and matching row remain readable and keyboard
  reachable without clipped required controls or two-dimensional page
  scrolling.
- [ ] Focused automated coverage asserts active-element progression and result
  routing at both layouts, plus native/browser parity, edit/reindex,
  application restart, Trash/restore, JSON clean restore, and verified-backup
  clean restore.

## Engineering boundaries

- Reuse the existing SQLite FTS index, row IDs, table page IDs, save
  transaction, browser fallback, and search dialog.
- Add only the metadata needed to map a row hit to its owning table and expose
  that row. Do not add filters, sorting, row pages, property types, general
  highlighting infrastructure, or a table redesign.
- Do not include multiline-cell support, column deletion, packaging, security,
  attachments, or unrelated accessibility work in this release item.

## Next action

Engineering should implement MOTION-UX-005 and return a focused trace showing a
unique cell value before and after edit, restart, Trash/restore, JSON clean
restore, and verified-backup clean restore, with pointer and keyboard result
selection opening the correct row at normal and equivalent-200% layouts.
