# Motion edit save-failure remediation

Owner: Product Director  
Reviewed: 2026-08-06  
Defect: MOTION-UX-011  
Priority: P0 data fidelity

## Selected defect

**Failed edits remain rendered as if they are current content, then disappear
without recovery on reload or restart.**

Motion mutates the in-memory workspace before every title, block, checklist,
column, and cell save. When persistence rejects, `persist()` changes only the
shared status text to `Save failed`; it neither rolls back nor marks the
affected content as unsaved, and exposes no retry. The edited value remains
fully interactive and visually indistinguishable from durable content. Reload
loads the last confirmed workspace and silently removes the failed edits.

This is the highest-impact remaining data-editing defect outside UX-006,
UX-007, UX-009, and UX-010. It affects every core content type and can cause a
user to continue working from a false state, export/search/backup a different
state than the editor shows, or close Motion believing visible work is durable.

## Reproduction evidence

A focused Playwright run injected a native save failure and passed at 1280 x
800 and 640 x 800 (equivalent-200%):

1. Load a confirmed workspace containing paragraph `Durable text`, Heading 1
   `Durable heading`, unchecked task `Durable checklist`, code `durable code`,
   and table cell `Durable cell`.
2. Using the rendered controls, replace the paragraph, heading, code, and cell
   with distinct `Unsaved … marker` values and check the task.
3. Every `motion_ui_save` rejects with `injected disk failure`.
4. Motion displays only `Save failed`; all new values and the checked state
   remain visible and editable.
5. Reload. The paragraph, heading, code, task state, and table cell all revert
   to their durable values. No recovery or retry is offered.

Both layout cases passed their assertions of the current defective behaviour.
Temporary inspection files and the isolated-port config were removed.

Affected source:

- `apps/web/app.js`: input/change handlers mutate `state` before calling
  `persist()` and do not retain a per-operation durable snapshot.
- `apps/web/app.js`: `persist()` returns `false` and writes `Save failed`, but
  leaves optimistic state rendered and supplies no retry/recovery contract.
- `apps/web/app.js`: subsequent saves clone the whole optimistic state, so an
  unrelated later successful edit may accidentally commit earlier failed edits
  without a clear user decision.
- Search/export/backup use different adapter boundaries and may therefore
  reflect canonical durable state while the editor displays failed optimistic
  state.

## Bounded implementation brief

Introduce one shared, serialized edit-commit boundary for existing editable
fields: page/database title, document block text/type/check state, column name,
and table cell value. Preserve an exact pre-edit durable snapshot until save
confirmation. On failure, keep the attempted value available in a clearly
identified recoverable unsaved state and expose **Retry save** and **Discard
unsaved changes**. Do not silently mix it into a later unrelated save.

Retry must submit the same validated candidate against the current revision.
Discard must restore the last confirmed values and stable focus. Reload,
restart, Trash, export, search, and backup must never treat a rejected edit as
confirmed. A before-unload warning is in scope only while recoverable unsaved
changes exist; autosave history, general versioning, and collaborative merge UI
are not.

### Data-fidelity acceptance criteria

- [ ] A confirmed edit preserves exact text and type/state across paragraph,
  Heading 1, checklist text/completion, multiline code, page/database title,
  column name, and table cell value.
- [ ] Exact fidelity includes LF, consecutive/leading/trailing blank lines,
  spaces, tabs where supported, Unicode, emoji, punctuation, and HTML-like
  text. Rendering or retry does not normalise or execute it.
- [ ] On save rejection, the last confirmed snapshot remains unchanged and the
  attempted candidate is retained separately with the IDs, field, value, type,
  checked state, ordering, and expected revision required for deterministic
  retry or discard.
- [ ] An unrelated later edit cannot silently commit, overwrite, merge, or
  discard a failed candidate. The UI serializes it or requires an explicit
  retry/discard decision.
- [ ] Retry commits the exact attempted candidate once. Revision conflict
  rejects safely with both durable and attempted values available; no
  last-write-wins overwrite occurs silently.
- [ ] Discard restores exactly the last confirmed state without changing any
  unrelated page, block, row, column, cell, ID, link, hierarchy, order, Trash
  state, or attachment metadata.

### Usability and accessibility acceptance criteria

- [ ] Saving progress, confirmed save, and failed/recoverable state are
  visually distinct and announced through the status region. `Save failed`
  alone is insufficient.
- [ ] Failure identifies the affected content generically but usefully, for
  example `Checklist change could not be saved`, without exposing filesystem
  paths, stack traces, secrets, or entire cell/block contents.
- [ ] **Retry save** and **Discard unsaved changes** are visible without hover,
  keyboard operable by Tab/Shift+Tab plus Enter/Space, have clear accessible
  names, and do not rely on colour alone.
- [ ] Focus remains in or returns to the affected editor after failure. Retry
  success preserves a sensible caret/selection and announces confirmation;
  discard focuses the restored field and announces that unsaved changes were
  discarded.
- [ ] Screen readers can identify which field is unsaved and whether the shown
  value is confirmed or recoverable. Repeated failed fields are distinguishable
  by page/table and field context.
- [ ] Pointer and keyboard editing, retry, and discard produce identical data
  outcomes. Escape does not discard work without a consequence-specific
  confirmation.
- [ ] Closing/reloading while recoverable edits exist presents one concise
  warning. Cancelling closure returns to the failed field; choosing to leave
  does not claim the attempted value was saved.

### Persistence, search, export, and recovery acceptance criteria

- [ ] Only confirmed edits appear after reload, complete process restart, or
  forced termination. If attempted edits are intentionally session-recoverable,
  they reopen explicitly labelled as unsaved and never replace canonical data
  until retry succeeds.
- [ ] Search excludes rejected terms and retains confirmed terms. Successful
  retry atomically replaces the relevant search projection; discard leaves it
  unchanged and creates no duplicate/stale hit.
- [ ] Ordinary JSON export and verified backup include only the last confirmed
  workspace. If unsaved changes exist, the UI states they are excluded before
  export/backup and offers Retry/Discard; it never silently exports the rendered
  optimistic state as though canonical.
- [ ] A clean JSON or verified-backup restore reproduces confirmed values,
  types, checklist state, IDs, hierarchy, and table mappings exactly. Rejected
  edits are absent unless a separate explicitly labelled draft-recovery format
  is later approved; that format is outside this task.
- [ ] Moving a page/table with a failed edit to Trash requires resolving the
  edit first or explicitly discarding it. Trash/restore cannot convert a failed
  edit into confirmed content or erase it without notice.
- [ ] Restore initiation while edits are unsaved requires explicit resolution.
  Cancelled/failed restore preserves both canonical data and the recoverable
  attempted edit; successful replacement does not leak the old attempt into the
  restored workspace.
- [ ] Retry failure, application restart, backup failure, and restore failure
  never display `Saved`, advance the durable revision, or corrupt the previous
  valid workspace/backup.

### Normal and equivalent-200% acceptance criteria

- [ ] At 1280 x 800 and a 720 px-wide equivalent-200% layout, the affected
  field, failed-state message, Retry, and Discard remain visible or reachable
  without page-level two-dimensional scrolling.
- [ ] At equivalent-200%, failure actions do not obscure the editor, table cell,
  save state, or mobile navigation trigger; focus never moves into a closed
  drawer or off-screen control.
- [ ] Long values, multiline code, long column names, and horizontally scrolled
  tables keep the affected field and visible focus indicator in view.
- [ ] The status/action layout can wrap vertically but does not overlap required
  editing or recovery controls at either layout.
- [ ] Focused automated coverage injects save rejection and recovery for every
  listed field using pointer and keyboard at both layouts, including exact
  special-character fidelity, retry success, repeated retry failure, discard,
  revision conflict, unrelated-edit serialization, reload/process restart,
  search, Trash/restore, JSON export/clean restore, verified backup/clean
  restore, before-unload choice, and accessibility/status assertions.

## Engineering boundaries

- Reuse the existing state model, adapter, save queue, stable IDs, validation,
  status region, search, Trash, export, and verified-backup services.
- Do not add document history, cloud sync, collaborative merging, offline queue
  infrastructure, autosave versions, new editor types, or redesign the editor.
- Do not combine this with UX-006, UX-007, UX-009, UX-010, table schema work,
  search redesign, or backup-format changes.
- A small shared failed-edit record and Retry/Discard UI are in scope. A second
  workspace store or draft database is not.

## Verification handoff

Engineering should return one bounded two-layout trace showing each editor
type under injected failure, exact attempted/durable values, retry and discard,
revision conflict, unrelated-edit isolation, reload/restart, search, Trash,
export, verified-backup clean restore, focus/caret recovery, before-unload, and
accessible status/action semantics. Product will verify that Motion never lets
visible failed work masquerade as durable content or disappear without an
explicit recovery choice.
