# Destructive workspace restore specification

Owner: Product Director

Decision date: 2026-08-09

Priority: Must ship

## Decision

The highest-risk destructive action lacking adequate prevention and recovery is
**Restore JSON workspace**. It can replace every active page, table, row, block,
link, Trash entry, and current selection. The current confirmation warns about
replacement, but the implementation assigns the replacement to live state and
announces success even when persistence returns `false`.

This is a larger and less recoverable blast radius than the other inspected
actions:

- page deletion has consequence copy and durable Trash recovery;
- block deletion has explicit irreversible confirmation and session undo;
- verified-backup restore creates a new workspace after preview;
- verified-backup file overwrite is protected by the native replacement path;
- row deletion lacks confirmation/recovery but affects one row, so it remains a
  separate follow-up rather than expanding this release.

This specification is the implementation authority for the destructive-action
portion of `PRODUCT_WORKSPACE_RESTORE_FAILURE_REMEDIATION_0.1.0.md`.

## Exact source locations

- `apps/web/index.html:35-42`: Restore trigger and hidden `restoreFile` input.
- `apps/web/app.js:94-102`: `restoreWorkspace()` parses, normalises, confirms,
  replaces live state, persists, renders, and announces.
- `apps/web/app.js:23-35`: `persist()` returns `false` on a failed save.
- `apps/web/app.js:259-260`: Restore button opens the file chooser.
- `apps/web/app.js:279-288`: file-selection handler calls `restoreWorkspace()`,
  reports thrown failures, and clears the input.
- `apps/web/app-adapter.js:40-43,68-73`: browser and native durable-save
  boundaries.
- `e2e/destructive-accessibility.spec.ts:69-90,145-153`: current cancellation
  and malformed-file coverage; neither proves rollback after an accepted
  confirmation followed by save rejection.

Line numbers refer to the inspected working tree on 2026-08-09. Implementers
must update the same named functions if surrounding lines move.

## Required trigger flow

1. Pointer click or keyboard activation (`Enter` or Space) on **Restore** opens
   the existing file chooser. Merely focusing Restore does nothing.
2. Selecting a file reads, parses, validates, and closed-shape normalises it
   without changing live state, persistence, search, export, backup input, or
   active focus context. Invalid input skips confirmation and reports failure.
3. Motion snapshots the exact active workspace, active selection, current
   revision where available, and the visible Restore trigger before presenting
   a modal confirmation. It may show safe counts from the validated candidate;
   it must not render candidate content or echo document text.
4. Only explicit **Replace workspace** confirmation begins one commit attempt.
   Disable both confirmation actions while that attempt is pending.
5. Persist the validated candidate through the existing adapter boundary.
   Do not assign it to globally visible `state`, render it, search it, export it,
   or announce success before the save resolves successfully.
6. On confirmed success, make the candidate active, render once, announce
   success, and focus its active page/table title or stable empty-workspace
   heading/action.
7. On cancellation or failure, retain or restore the exact snapshot, leave
   durable storage untouched, announce the outcome, and return focus to the
   visible Restore trigger. A failure may offer **Retry restore** using the
   already validated candidate; retry must repeat confirmation if the current
   workspace revision has changed.

## Confirmation contract

Use an application modal dialog, not a generic alert, with:

- Accessible name: `Replace current workspace?`
- Body copy: `Restoring “<safe file name>” will replace the current workspace,
  including its pages, tables, Trash, and current selection. This cannot be
  undone after Motion closes. Create a backup first if you may need the current
  workspace.`
- Primary destructive action: `Replace workspace`
- Safe action: `Cancel`

The file name is escaped, bounded, and never the only description of the
consequence. Do not include imported page titles, cell values, attachment
names, paths, raw JSON, or parse/storage error details in the confirmation.

## Keyboard and cancellation behaviour

- The modal receives focus on **Cancel** by default. `Tab` and `Shift+Tab` stay
  within its two actions while open.
- `Enter` or Space activates the focused action. There is no single-key Delete,
  Backspace, or typing shortcut for replacement.
- `Escape`, **Cancel**, closing the file chooser, or selecting no file all
  cancel without mutation. Escape is disabled only during the pending atomic
  commit, when both actions are disabled and progress is announced.
- Cancellation closes the modal, returns focus to **Restore**, and announces:
  `Restore cancelled. Current workspace kept.`
- Cancellation makes zero save calls and does not change revision, undo/redo,
  search results, export bytes, backup source, attachment metadata, Trash, or
  active selection.

## Recovery expectation

Workspace replacement is not added to ordinary session undo: a whole-workspace
undo entry would create misleading cross-workspace history. Prevention and
recovery instead require all three safeguards:

1. no live mutation before confirmed durable commit;
2. exact rollback/retention of the pre-restore snapshot on every failure; and
3. explicit advice to create a verified backup before replacement.

After a successful replacement, recovery is by a pre-restore JSON export or
verified backup. The implementation must not silently create, overwrite, or
delete a backup. A failed commit announces `Restore failed. Current workspace
was not replaced.` and exposes a keyboard-operable **Retry restore** plus
**Dismiss**. Dismiss returns focus to Restore. Raw native/browser error strings,
paths, SQL, and stack traces are never user-facing.

## Acceptance criteria

### Prevention and atomicity

- [ ] File selection alone never changes visible or durable workspace state.
- [ ] Invalid schema, unsafe IDs, malformed JSON, or failed normalisation opens
  no confirmation, performs no save, preserves the workspace exactly, and
  returns focus to Restore with a non-technical failure announcement.
- [ ] Cancel by button or Escape performs zero save calls and preserves the
  exact workspace, revision, active selection, Trash, search, export, backup
  source, attachments, undo stack, and redo stack.
- [ ] Confirm produces exactly one adapter save using the validated candidate.
  Repeated activation while pending cannot issue another save.
- [ ] Candidate state is not assigned, rendered, indexed, exported, or announced
  as restored until the durable save reports success.
- [ ] If save returns `false`, rejects, times out, or reports a revision conflict,
  the pre-restore state remains visible and durable, and reload/restart opens
  that same original state.
- [ ] Confirmed success renders the exact validated candidate once; immediate
  reload and separate-process restart retain its IDs, hierarchy, values, Trash,
  links, and active selection.

### Confirmation, focus, and status

- [ ] Confirmation uses the exact accessible name, body consequence, and button
  labels above, with Cancel initially focused.
- [ ] Pointer, Enter, and Space reach the same confirmation and commit path.
  Escape and Cancel reach the same zero-mutation cancellation path.
- [ ] Focus is trapped only while the modal is open. Cancellation, validation
  failure, save failure, Retry dismissal, and file-chooser cancellation return
  focus to the visible Restore trigger, including from the mobile drawer.
- [ ] Success focuses the restored active title or a stable empty-workspace
  control. Focus never falls to `body`, the hidden file input, or a removed node.
- [ ] The existing status region announces validation failure, cancellation,
  committing, failure, retry, and success once. It never says `Restored` or
  `Saved` before durable success.
- [ ] At normal and equivalent-200% layout in a 720 px-wide viewport, all copy,
  both actions, progress, Retry/Dismiss, and visible focus remain operable
  without clipped required controls or horizontal page scrolling.

### Recovery and regression

- [ ] Failure presents `Restore failed. Current workspace was not replaced.`,
  keyboard-operable Retry and Dismiss, and no raw technical error content.
- [ ] Retry reuses the validated candidate only while the source workspace
  revision is unchanged; otherwise it closes safely and requires reselection
  and fresh confirmation.
- [ ] A verified backup created before restore can recover the original after a
  successful replacement; this flow does not change verified-backup formats or
  the existing restore-as-new semantics.
- [ ] Page Trash/restore, block confirmation, verified-backup overwrite safety,
  export, search, and attachment behaviour are unchanged.

### Required focused tests

- [ ] Browser/service tests inject save success, explicit `false`, rejection,
  timeout, and revision conflict, asserting call count and byte-for-byte original
  state after every non-success.
- [ ] E2E covers pointer, Enter, Space, Escape, Cancel, double activation,
  chooser cancellation, invalid input, successful replace/reload, failed
  replace/reload, Retry success, stale-revision Retry rejection, focus/status,
  mobile drawer, normal layout, and equivalent-200% layout.
- [ ] Tests compare pre/post search results, JSON export, Trash, active IDs,
  attachment metadata, and backup source to prove cancellation/failure has no
  hidden mutation.

## Boundaries

Reuse the current Restore entry point, normaliser, adapter save boundary, status
region, and dialog styling. Do not add automatic backups, general history,
workspace merge, conflict resolution UI, verified-backup format changes, row or
block deletion work, application launch, packaging, or native-build scope.

## Product verification request

Engineering should return a focused trace showing accepted confirmation with an
injected save failure, unchanged state before and after reload, keyboard Retry
to successful durable replacement, and the same flow at normal and
equivalent-200% layout. Product will verify consequence copy, state truthfulness,
focus recovery, and absence of hidden mutation.
