# Motion workspace restore failure remediation

Owner: Product Director  
Reviewed: 2026-08-06  
Defect: MOTION-UX-012  
Priority: P0 recovery integrity

## Selected defect

**Workspace replacement announces success and displays restored content even
when persistence failed. Reload then returns the original workspace.**

The ordinary JSON **Restore** path validates the candidate and asks for
replacement confirmation, then replaces in-memory state before saving.
`restoreWorkspace()` ignores the `false` returned by `persist()`, renders the
candidate, announces `Workspace restored.`, focuses its title, and returns
`true`. The canonical workspace was never replaced. Reload or process restart
loads the original workspace and the apparent restoration disappears.

This is the highest-impact remaining recovery defect outside UX-006 through
UX-011 because it gives an explicit false success for a whole-workspace
replacement. A user can edit, search, export, back up, or close what appears to
be the recovered workspace while Motion's durable state is still the original.

## Reproduction evidence

A focused injected-failure Playwright journey passed at 1280 x 800 and 640 x
800 (equivalent-200%):

1. Launch with durable page `Original durable workspace` containing `Original
   recovery marker`.
2. Select a valid schema-v1 JSON workspace containing `Replacement workspace`
   and `Replacement recovery marker`.
3. Accept the consequence-specific replacement confirmation.
4. Inject rejection of `motion_ui_save` with `injected restore persistence
   failure`.
5. Observe `Workspace restored.`, replacement title/content rendered, and focus
   on the replacement title despite no durable commit.
6. Reload. The original title, block ID, and marker return; the replacement is
   absent from workspace navigation.

Both layout cases passed assertions of the current defective behaviour.
Temporary inspection files and isolated server configuration were removed.

Source evidence:

- `apps/web/app.js`, `restoreWorkspace()`: assigns `state = replacement`, then
  calls `await persist(); render(); announce("Workspace restored.")` without
  checking the save result.
- `persist()` catches the storage error and returns `false`, so the caller has
  enough information to reject safely but currently discards it.
- The same pattern exists in some Trash mutations, but this brief is bounded to
  whole-workspace JSON replacement. Trash failure handling should be tracked
  separately rather than expanding this release.

## Bounded implementation brief

Make ordinary JSON workspace replacement transactional from the user's point
of view. Retain the exact active pre-restore workspace and focus target, validate
the candidate, obtain confirmation, and attempt the existing persistence
boundary. Do not render, activate, index, export, or announce the replacement
as restored until persistence confirms success.

On rejection, restore/retain the pre-restore in-memory workspace, announce that
no workspace was replaced, return focus to **Restore**, and offer a safe retry
using the already validated selected file only for the current session. The
last valid durable workspace must remain byte-for-byte unchanged.

### Consequence and cancellation acceptance criteria

- [ ] File selection alone changes no active page, content, revision, search
  entry, Trash state, export, or backup input.
- [ ] Confirmation names the incoming workspace or file, summarises page/table
  counts where safely available, and states that the current active workspace
  will be replaced if persistence succeeds.
- [ ] The confirmation does not echo block/cell contents, internal paths,
  credentials, stack traces, or unescaped file-controlled markup.
- [ ] Pointer confirmation and Enter/Space on the confirm action execute the
  same single replacement. Ordinary typing, Delete, and Backspace cannot
  confirm it.
- [ ] Pointer cancel, the cancel action, and Escape leave the current workspace
  byte-for-byte unchanged, announce `Restore cancelled. Current workspace
  kept.`, and return focus to **Restore**.
- [ ] Closing a file picker without selecting a file is treated as cancellation
  without opening a consequence prompt or changing/announcing success.

### Failure, focus, and announcement acceptance criteria

- [ ] Validation, revision, storage, disk-full, permission, or service failure
  never renders the candidate as active and never announces `Workspace
  restored` or `Saved`.
- [ ] Failure announces `Restore failed. Current workspace kept.` with concise,
  non-sensitive context and exposes a keyboard-operable **Retry restore** when
  retry is safe.
- [ ] Failure returns focus to the visible **Restore** or **Retry restore**
  control. Focus never lands on the rejected candidate, hidden file input,
  removed confirmation, `body`, or a closed mobile drawer.
- [ ] Retry revalidates the candidate and current revision immediately before
  commitment. It creates exactly one replacement attempt and cannot apply a
  stale or changed file silently.
- [ ] A second failure leaves the original active and retry/cancel controls
  usable. Dismissing retry discards the session-held candidate and confirms
  that the current workspace remains active.
- [ ] Success is announced only after durable persistence confirms. It closes
  the mobile navigation if open and focuses the restored active page/database
  title, or a stable empty-state heading/control when the restored workspace is
  empty.
- [ ] Status, failure, retry, cancellation, and success are exposed through
  appropriate live-region/dialog semantics without repeated or contradictory
  announcements.

### Data-integrity and persistence acceptance criteria

- [ ] Failed or cancelled restore preserves the current workspace exactly:
  schema version, active page, page/block/table/column/row IDs, hierarchy,
  ordering, text, multiline values, checklist state, links, deleted state, and
  attachment metadata.
- [ ] A confirmed successful restore persists the validated candidate exactly
  once, then reload, complete process restart, and forced termination/relaunch
  open that replacement with the same IDs, values, active selection, hierarchy,
  and Trash state.
- [ ] Search continues to return only the original workspace after failure or
  cancellation. After confirmed success it returns only valid replacement
  entries, without stale or duplicate original hits.
- [ ] Export JSON after failure/cancellation contains the original workspace;
  after success it contains the replacement. The rendered UI and export source
  can never disagree about which workspace is confirmed active.
- [ ] Verified backup after failure/cancellation backs up the original; after
  successful replacement it backs up the replacement. Backup creation is
  blocked while commit outcome is unknown.
- [ ] A verified backup/clean-workspace restore remains governed by its existing
  create-new-workspace semantics. This task does not convert ordinary JSON
  replacement into that flow or change either backup format.
- [ ] Invalid, corrupt, oversized, cyclic, duplicate-ID, hostile, or unsupported
  input is rejected before confirmation where possible and cannot mutate
  canonical data, search, Trash, export, backup, or recovery files.

### Recovery-journey acceptance criteria

- [ ] If the original contains trashed content, failed/cancelled replacement
  retains its Trash entries and restore actions exactly. Successful replacement
  exposes only the candidate's valid Trash state.
- [ ] Existing unsaved/recoverable edits covered by UX-011 must be resolved
  before replacement confirmation; this task does not silently discard or
  merge them.
- [ ] Creation or search failure immediately before Restore does not weaken
  validation, confirmation, rollback, focus, or announcement behavior.
- [ ] Restart during validation/confirmation leaves the original workspace
  active. Restart after confirmed commit opens the replacement. A crash during
  commit resolves to one complete valid workspace, never a mixed state.
- [ ] Replacing a previously restored workspace follows the same rules and
  cannot accumulate duplicate pages, rows, search entries, or Trash records.

### Normal and equivalent-200% acceptance criteria

- [ ] At 1280 x 800 and 720 px-wide equivalent-200%, Restore, confirmation,
  consequence summary, Cancel, Confirm, error, and Retry are visible or
  vertically reachable without page-level two-dimensional scrolling.
- [ ] At equivalent-200%, the confirmation is not clipped by the navigation
  drawer, focus remains visible, and success/failure cannot leave focus in a
  closed or obscured region.
- [ ] Long safe filenames/workspace names wrap or truncate accessibly without
  hiding consequence counts or required actions.
- [ ] Pointer targets, keyboard focus indicators, contrast, and accessible
  names meet existing Motion standards at both layouts; state is not conveyed
  by colour alone.
- [ ] Focused automated coverage exercises pointer, Enter, Space, Escape,
  picker cancellation, confirmation cancellation, validation failure, injected
  persistence failure, retry failure/success, restart/crash boundary, search,
  Trash, export, verified backup, exact data comparison, normal/equivalent-200%,
  and accessibility/focus/status assertions.

## Engineering boundaries

- Reuse schema-v1 normalisation, current confirmation, adapter/save queue,
  stable IDs, status region, search, Trash, export, and verified-backup paths.
- Do not add workspace history, multi-workspace management UI, cloud sync,
  merge/conflict editors, new backup formats, or a broad recovery centre.
- Do not combine this with UX-006 through UX-011, Trash mutation remediation,
  editor save recovery, search redesign, or verified-backup semantics.
- A pre-restore snapshot, checked commit result, focused rollback, and bounded
  session retry are in scope. A second persistent draft store is not.

## Verification handoff

Engineering should return one bounded two-layout trace showing valid and
invalid files, cancellation, injected persistence/revision failures, exact
pre/post workspace comparison, retry failure/success, focus and announcements,
reload/process restart/crash boundary, search, Trash, export, and verified
backup results. Product will verify that Motion never displays or announces a
replacement workspace as restored before the durable commit succeeds.
