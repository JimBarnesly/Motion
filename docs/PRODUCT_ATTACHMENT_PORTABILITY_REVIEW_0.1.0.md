# Motion 0.1.0 attachment portability usability review

Owner: Product Director  
Reviewed: 2026-08-05

## Outcome

Canonical attachment bytes survive verified backup, clean-workspace restore,
and restart, but the user-facing workflow is defective.

**MOTION-UX-003 — Restored attachments are invisible and cannot be opened**

Motion displays only attachments added during the current UI session. It does
not load canonical attachment metadata at startup, explicitly clears the
session list after verified restore, and renders each session attachment as a
plain `div` rather than an open/download control. A user can create a valid
portable backup yet cannot verify, access, or open its restored files through
the product after restart.

This is the highest-impact gap because it breaks the user outcome, not the
underlying archive: preserved bytes that cannot be found or opened are not
usable portability.

## Reproduction and evidence

### Canonical service — data survives

The focused application-service scenario
`attachments and canonical backup survive restart and restore without trusting
archived paths` demonstrates:

1. a known text attachment is durably ingested;
2. `attachment.read` returns the original bytes after reopening the source
   store;
3. verified backup reports one attachment;
4. restore into a separate clean store recreates the attachment;
5. reopening the restored store and calling `attachment.read` returns the same
   bytes; and
6. restored metadata retains the original SHA-256.

The staged AArch64 AppImage service smoke also passed offline backup, restore,
termination, restart, and reload. That smoke does not attempt user-facing
attachment access.

### Rendered workflow — user access fails

1. Open Motion through its native UI adapter and create a page.
2. Select **Attach file** and choose a known file such as
   `portable-proof.txt`.
3. At 200% zoom, observe the filename, byte count, and hash prefix under
   **Confirmed attachments**. The metadata is readable.
4. Attempt to open or save the attachment. No link, button, menu item, or
   keyboard action exists; the entry is non-interactive text.
5. Reload or restart Motion. The filename disappears and the panel says
   `No attachments confirmed this session.`
6. Create a verified backup, restore it into a clean workspace, and approve the
   preview reporting the attachment count.
7. After restore, observe the same empty session message because the restore
   flow assigns `confirmedAttachments = []`.
8. Restart again. No restored attachment is listed or openable even though the
   canonical service can read its bytes.

A focused Playwright reproduction at 200% zoom passed assertions that the
newly attached file was readable as metadata, had no button or link, and
disappeared after reload. The temporary inspection test was removed afterward.

Affected source area:

- `apps/web/app.js`: `confirmedAttachments` is initialized as an empty
  in-memory array.
- `apps/web/app.js`: successful ingestion appends metadata only to that array.
- `apps/web/app.js`: verified restore explicitly clears the array before
  rerendering.
- `apps/web/app.js`: `renderContext()` renders attachment metadata as a plain
  `div` and uses session-specific empty-state wording.
- `apps/web/app-adapter.js`: exposes `attachment.put` but no attachment list or
  `attachment.read` operation to the UI, although the application service
  already implements `attachment.read`.

## Intended behaviour

Motion must derive its attachment list from the active canonical workspace on
load and after restore. Every attachment entry must expose an understandable,
keyboard-operable **Open** or **Save a copy** action that reads the canonical
bytes and preserves the original filename. Restart must not change visibility
or access.

The smallest implementation is to expose canonical attachment metadata and
the existing `attachment.read` query through the UI adapter, render the list
from canonical state, and create a local Blob/open or save action. Do not add a
media gallery, previews, drag/drop, attachment blocks, or filesystem browser.

## Observable acceptance criteria

- [ ] After durable ingestion, the active workspace lists the attachment's
  filename, byte count, and integrity/status information without relying on
  session memory.
- [ ] Closing and relaunching Motion lists the same attachment before any new
  file is added in that session.
- [ ] A verified backup preview reports the correct attachment count and total
  bytes in plain language before mutation.
- [ ] Restoring into a clean workspace lists every restored attachment
  immediately and still lists them after another restart.
- [ ] Activating **Open** or **Save a copy** retrieves bytes through the
  canonical `attachment.read` path and produces a file with the original name,
  byte length, SHA-256, and content.
- [ ] Opening an attachment requires no account, network connection, source
  path, or continued access to the original file.
- [ ] Every attachment action has an accessible name containing the filename,
  is reachable and operable by keyboard, and returns focus to a stable control
  when cancelled or completed.
- [ ] At normal zoom and 200% zoom in a 720-pixel-wide window, filenames,
  status, and the open/save action remain readable and operable without
  clipping or horizontal-only discovery.
- [ ] Missing or unreadable canonical bytes produce a visible and
  screen-reader-announced error naming the affected attachment, do not claim
  success, do not remove its metadata, and leave other attachments usable.
- [ ] A corrupt or incomplete backup is rejected before restore; the error
  states that no workspace was restored and leaves the clean destination
  unchanged.
- [ ] Focused tests cover add, backup, clean-profile restore, restart, list,
  read/open, byte/hash equality, keyboard operation, 200% zoom, missing-byte
  failure, and corrupt-backup rejection.

## Engineering boundaries

- Reuse canonical attachment metadata, `attachment.read`, verified backup, and
  restore services. Do not create a second attachment store or trust archive
  paths in the UI.
- Keep attachment actions local-only and explicit. No remote preview service or
  external viewer integration is required.
- Do not add streaming/large-file work, rich attachment blocks, general import,
  native package validation, security leakage testing, or broad backup
  redesign under this defect.
- Preserve the current verified-restore rule of restoring into a new workspace.

## Product verification request

Engineering should return a focused end-to-end trace using a uniquely named
text file: add, verified backup, clean-profile restore, restart, open/save, and
hash comparison at normal and 200% zoom. Product will verify that the restored
file is understandable and accessible without knowledge of internal storage;
Quality retains general release regression ownership.
