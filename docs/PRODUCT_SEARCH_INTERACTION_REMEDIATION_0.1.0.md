# Motion 0.1.0 search interaction remediation

Owner: Product Director

Decision date: 2026-08-09

Priority: Must ship

## Decision

Close **MOTION-UX-005** with one bounded remediation: make quick search a
complete, keyboard-operable interaction whose guidance, loading, results,
no-result, error, retry, and cleared-query states are visibly and accessibly
distinct.

Table-cell indexing remains part of the required outcome, but it is implemented
in the current `fix/motion-ux-011-recoverable-edits` candidate. The remaining
release risk is that a user cannot reliably understand or recover from search
state changes. The previous frozen candidate exposed raw native errors, lacked
a retry action and status semantics, and did not prove clearing or the complete
keyboard path. The current candidate adds state rendering and retry, but it is
accepted only when the criteria below pass against one immutable candidate.

This supersedes the broad Product tasks **Assess Motion 0.1 user-value gap** and
the open-ended acceptance scope in
`PRODUCT_SEARCH_USABILITY_REVIEW_0.1.0.md`. The earlier report remains the defect
and indexing evidence; this document is the implementation and verification
authority for the smallest valuable release.

## User outcome

A user opens search, types or clears a query, understands what Motion is doing,
can reach and open a visible result without a pointer, and can recover from a
failed search without losing the query. Supported searches respond within the
existing 200 ms target.

## Acceptance criteria

### Keyboard use

- `Ctrl+K` (and `Cmd+K` where supported) opens the dialog and places focus in
  the search field. The dialog has an accessible name.
- With results present, `Tab` reaches the first visible result, visible focus is
  not clipped, and `Enter` opens the correct owning page/table. A table-cell hit
  focuses or scrolls its stable matching row into view without changing data.
- `Escape` closes search from the field, a result, empty state, or retry control
  and returns focus to the control that opened it.
- The error-state Retry control is reachable by `Tab` and activated by `Enter`
  or Space. Retry preserves and reruns the current query.

### Empty, no-result, and error states

- An empty query shows concise search guidance. It must not say `No results`.
- A genuinely unmatched non-empty query shows `No results` and includes the
  escaped query. It does not move focus out of the search field.
- Loading, results, no-result, and failure are programmatically announced once
  per transition. Failure uses alert semantics; ordinary progress/results do
  not repeatedly interrupt typing.
- A native or fallback search failure shows non-technical copy, never raw error
  text, paths, SQL, stack traces, or query internals. It preserves the query and
  offers Retry. Repeated failure and later successful recovery are testable.

### Query clearing

- The native clear affordance and `Ctrl/Cmd+A`, `Backspace` both clear the query
  and synchronously restore empty-query guidance.
- Clearing removes stale results, no-result text, loading indicators, and error
  controls. A late response from the cleared query cannot repopulate them.
- The field retains focus after clearing, so a new query can be typed
  immediately. Closing and reopening search starts with an empty field and
  guidance.

### Result visibility and content

- Each result visibly identifies its owning page/table. A table-cell result also
  contains a bounded, escaped snippet with matching row/property context.
- At 100% and browser-equivalent 200% zoom in a 720 px-wide viewport, the query,
  state message, at least the first result, visible focus, Retry when present,
  and close control are readable and operable without horizontal page scroll or
  clipped required controls.
- Opening a table-cell result brings the matching row into the viewport and
  leaves the row ID, values, and order unchanged.

### Response target

- Measure from the input event to the corresponding guidance, no-result, error,
  or first-result state being committed to the DOM. Warm representative queries
  must have median and p95 below **200 ms**, and no recorded acceptance sample
  may exceed 200 ms.
- Candidate evidence uses the supported indexed desktop path with 10,000 pages
  and 100,000 blocks: at least 15 separate-process cold queries and 100 warm
  queries on the controlled AArch64 runner. Record commit, fixture/query,
  runtime/hardware, all raw timings, median, p95, min/max, and exit status.
- The browser fallback must pass the interaction criteria on a normal acceptance
  fixture. It is not a release-performance substitute for the indexed desktop
  path; if it is supported for the representative dataset, it must independently
  meet the same 200 ms target.

## Required focused evidence

One candidate-bound automated scenario must cover: open by keyboard; empty
guidance; exact and partial table-cell result; Tab/Enter activation; matching-row
visibility; clear during an in-flight query; genuine no-result; injected redacted
failure; keyboard retry through repeated failure and recovery; Escape/focus
return; and 100%/200% layouts. The benchmark must run against the same commit.

Existing page-title and block-text search, restart persistence, edit/reindex,
Trash/restore, and clean verified restore remain regression requirements from
MOTION-UX-005; they are not new scope for this remediation.

## Boundaries

Reuse the existing dialog, indexed search path, browser fallback, stable IDs,
and save transaction. Do not add fuzzy/semantic search, filters, highlighting,
recent searches, new navigation, table redesign, or a new performance policy.

## Product disposition of current candidate

**Conditional accept, not release approval.** Commit `8690564` implements the
intended state model, redacted failure copy, Retry, row routing, and table-cell
fallback search. Product acceptance remains open until the focused evidence
above proves clearing, complete keyboard/focus behaviour, result visibility at
both layouts, repeated failure/recovery, and candidate-bound 200 ms performance.
