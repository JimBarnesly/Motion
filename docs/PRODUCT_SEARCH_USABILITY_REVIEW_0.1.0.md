# Motion 0.1.0 search usability review

Owner: Product Director  
Reviewed: 2026-08-06

## Outcome

**MOTION-UX-005 — Table cell content is absent from workspace search** is the
highest-impact must-ship search defect.

Motion successfully finds exact and ordinary partial substrings in page titles
and block text, reflects renamed pages after restart, presents understandable
empty results, and permits keyboard result selection at normal and 200% zoom.
It returns no result for persisted table cell text in both the browser fallback
and canonical SQLite search paths.

The frozen acceptance scope requires a distinct table value to be searchable
and to open its owning content. This functional omission outweighs smaller
search presentation issues because an entire shipped content type is
unfindable.

The defect was reproduced again against the current rendered Motion UI on
2026-08-06. No product implementation had closed the gap.

## Reproduction and evidence

Search-focused Playwright inspection covered:

1. Create `Commissioning notes` containing
   `Exact pressure calibration marker`.
2. Open search using `Ctrl+K` and search `pressure calibration`; the page is
   returned.
3. Search ordinary partial text such as `pressure`; the page is returned.
   Non-contiguous fragments such as `press cal` return no result because the
   browser fallback performs one contiguous substring match.
4. Traverse from the search field to the result using Tab and activate it with
   Enter; the correct page opens.
5. Rename the page, restart, and search its new title; the renamed result is
   returned.
6. Search a deliberately absent value; Motion displays
   `No results for “…”`.
7. Create `Search acceptance table`, add a row, and enter
   `Unique table-cell marker 417`.
8. Restart, switch to 200% zoom, and search `table-cell marker 417`.
9. Observe `No results` although the value remains visibly persisted in the
   table.

The focused scenario completed with the missing table-cell result reproduced.
The temporary test was removed after inspection.

The 2026-08-06 retry used the current local Web application and confirmed:

- `Unique valve calibration marker 417` remained visible after reload but its
  exact meaningful phrase and partial `marker 417` both returned `No results`;
- the table title, renamed to `Renamed commissioning register`, remained
  searchable after reload and its result opened using keyboard-only operation;
- at a 720 by 720 viewport with 200% page zoom, the false empty state and close
  control remained visible, confirming the failure is missing search coverage
  rather than clipped presentation.

The focused retry passed after recording the expected missing-cell outcome.
The temporary Playwright inspection was removed. The first launch attempt was
blocked by an inherited non-loopback `HOST` value and correctly refused by the
development server; rerunning with `HOST=127.0.0.1` exercised the product.

Canonical evidence independently reproduced the same defect: a
`SqliteWorkspaceStore` containing row value `Acceptance marker beta` returned
zero hits for that exact query.

## Affected source area

- `packages/storage/src/index.ts`, `extractSearchEntries()` traverses table
  `row.values` but indexes only object fields named `title`, `name`, `text`,
  `content`, or `label`; primitive cell values are discarded.
- `apps/web/app.js`, browser fallback search checks page titles and block text
  only.
- `apps/web/app.js`, native result routing accepts page IDs and block IDs only;
  a future row-ID hit would currently be discarded instead of mapped to its
  owning table page.

## Table-verification blocker record

The preceding office task **Verify table editing and data survival** did not
record a product, browser, package, or test-infrastructure failure. Its exact
office-runtime error was:

> Worker process ended before producing a reply.

The task was consequently marked blocked before its report was saved. This
search review did not restart that worker or retry any unavailable
infrastructure. It used the locally available Playwright harness and retained
repository evidence from the interrupted work. The implementation-ready table
brief remains in
[`PRODUCT_TABLE_WORKFLOW_REVIEW_0.1.0.md`](PRODUCT_TABLE_WORKFLOW_REVIEW_0.1.0.md).

## Intended behaviour

Search indexes persisted textual table values and routes a match to the owning
table with enough row context to identify it. Native and browser-development
search should provide the same basic user outcome, while SQLite FTS remains the
packaged implementation.

The smallest change is to index each table row as a stable entity using its row
ID, owning table identity, and textual property values, then resolve row hits
to the existing table page. Browser-development search must provide the same
observable outcome. This does not require filters, fuzzy search, highlighting
infrastructure, or new table views.

## Observable acceptance criteria

- [ ] After the UI reports the table save as confirmed, an exact unique string
  cell value returns its owning table without requiring that value in the
  table title or another page.
- [ ] A distinctive partial token and case variation return the same owning
  table; fuzzy and non-contiguous matching remain out of scope for 0.1.0.
- [ ] Every row-value result names the owning table and presents a bounded,
  escaped snippet containing the match plus enough row/property context to
  distinguish it. It must not appear as a generic table-title-only hit.
- [ ] From `Ctrl+K`, keyboard-only users can type the query, reach a result with
  visible focus, activate it with Enter, and close the dialog with Escape.
  Activation opens the correct table and brings the matching row into view
  without changing row ID, value, or order.
- [ ] Pointer activation provides the same destination and context.
- [ ] Editing a cell removes the stale term and makes the replacement searchable
  only after the same confirmed save that persists the edit. A search failure
  must not falsely report `No results`; it shows a distinct, non-technical
  error message, keeps the query, and offers a keyboard-operable retry.
- [ ] Cell search survives application restart and JSON export into a clean
  browser profile, and survives verified backup/clean-workspace restore in the
  native application, followed by restart.
- [ ] Deleted rows and trashed table pages do not appear in ordinary search;
  restoring a table reactivates its valid row entries.
- [ ] Multiple matching rows in one table produce deterministic, distinguishable
  results without flooding the dialog with identical table entries.
- [ ] A genuinely unmatched query displays `No results for “<query>”`, exposes
  that status to assistive technology without moving focus unexpectedly, and
  remains dismissible by keyboard. An empty query retains concise search
  guidance and does not claim that there are no results.
- [ ] Empty and unsupported values do not appear as `[object Object]`, raw JSON,
  or misleading searchable text.
- [ ] At normal and 200% zoom in a 720-pixel-wide window, query text, empty
  and error states, result title/snippet, visible focus, and the selected
  matching row remain readable and operable without clipped required controls
  or two-dimensional page scrolling.
- [ ] Search result, empty-state, progress/catching-up, and error containers use
  appropriate accessible names/status semantics; result snippets are not the
  only means of identifying the owning table.
- [ ] Focused tests cover native SQLite indexing, browser fallback parity,
  exact/partial terms, rename/restart, edit/reindex, empty and injected-error
  states, keyboard selection, clean restore, accessibility assertions, and
  normal/200% zoom.

## Engineering boundaries

- Reuse SQLite FTS, table/row IDs, the existing save transaction, and search
  dialog.
- Do not add fuzzy search, semantic search, performance benchmarking, filters,
  result highlighting infrastructure, table redesign, or new property types.
- Do not duplicate package, security, attachment, link-lifecycle, or general QA
  work.

## Product verification request

Engineering should return focused evidence for one unique cell value before
and after edit, restart, and clean restore, with keyboard selection opening the
correct table at normal and 200% zoom. Product will verify result clarity;
Quality retains general release regression ownership.
