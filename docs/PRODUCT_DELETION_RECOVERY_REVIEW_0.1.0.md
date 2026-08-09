# Motion 0.1.0 deletion and recovery usability review

Owner: Product Director  
Reviewed: 2026-08-05

## Outcome

The frozen page-level reversible-deletion requirement is understandable and
usable in the locally rendered product. The next highest-risk destructive
action, block deletion, has a P0 recovery defect.

**MOTION-UX-002 — Block deletion becomes irreversible after restart**

Deleting a block is a single action with no confirmation and no visible
recovery message. Motion places the prior workspace snapshot only in its
in-memory undo stack. `Ctrl+Z` restores the block during the same session, but
the stack is empty after reload or restart while the deletion itself has
already been persisted. An accidental click followed by close, crash, or
restart therefore causes permanent user-visible content loss.

## Page deletion evidence — compliant

Tested through the locally rendered Web-v1 UI used by the desktop shell:

- Selecting page **Delete** presents `Move this page and any pages inside it to
  Trash?`; cancelling leaves the page and content unchanged.
- Accepting removes the page from ordinary navigation and adds an explicitly
  named **Restore _page title_** control under Trash.
- After reload, the page remains in Trash and the Restore control remains
  available.
- At 200% zoom, the Restore control is visible and operable.
- Restoring and reloading returns the same page title and block content.
- Existing `e2e/web.spec.ts` separately covers exclusion from search, persisted
  Trash state, and restore across reload.

This satisfies the frozen parent/child reversible-deletion outcome. Full
package execution remains Quality's responsibility and is not duplicated here.

## Block deletion reproduction and evidence

1. Create a page and enter a unique marker in its initial block.
2. Focus or hover the block, then activate **Delete block**.
3. Observe that deletion occurs immediately. There is no confirmation, status
   announcement, visible **Undo**, or recoverable block entry.
4. Press `Ctrl+Z` before reload. The block returns, proving that only the
   session undo snapshot currently protects it.
5. Delete the block again and wait for the confirmed save.
6. Reload or restart Motion, then press `Ctrl+Z`.
7. Observe that the marker does not return and no block-recovery action exists.

Focused Playwright evidence passed both assertions: same-session `Ctrl+Z`
restored the deleted block, while delete/reload/`Ctrl+Z` did not. The temporary
inspection test was removed after the run.

Affected source area:

- `apps/web/app.js`: `undoStack` and `redoStack` are initialized in memory on
  every application load.
- `apps/web/app.js`: the `data-delete-block` click handler checkpoints the
  current state, removes the block from `page.blocks`, persists immediately,
  and rerenders without confirmation or recovery UI.
- `apps/web/test/web.test.mjs` checks that undo code and deletion controls exist
  but does not test recovery after reload.

## Intended behaviour

Accidental block deletion must be apparent and recoverable after save and
restart. Activation should remove the block from the document, announce what
happened, and present a clearly labelled recovery action. The recovery record
must persist at least until the user performs an explicit final discard or the
product applies a documented retention boundary; application restart alone
must not make the deletion irreversible.

The smallest suitable implementation is a persisted soft-delete/tombstone for
blocks plus an inline or status-region **Undo delete** action. Reuse the
canonical block identity and existing save path. Do not build a general
version-history system or redesign page Trash for this fix.

## Observable acceptance criteria

- [ ] Activating **Delete block** removes the intended block only once and
  announces `Block deleted` through a screen-reader-readable status region.
- [ ] A visible, keyboard-focusable **Undo delete** action is presented without
  obscuring document editing at normal zoom or 200% zoom.
- [ ] Undo restores the same block ID, type, content, task state, order, indent,
  links, and unknown payload rather than creating a replacement block.
- [ ] After deletion reaches confirmed save, closing and relaunching Motion
  still provides a clear recovery path; using it restores the original block.
- [ ] Recovery inserts the block in its original position where possible. If
  surrounding blocks changed, placement is deterministic and communicated
  without overwriting another block.
- [ ] Deleting one of multiple blocks never deletes adjacent blocks. Repeated
  activation while a save is pending cannot duplicate tombstones or recovery
  actions.
- [ ] A cancelled or failed deletion leaves the canonical document unchanged
  and does not falsely announce success.
- [ ] Keyboard users can delete, reach **Undo delete**, recover, and return to a
  logical editing position. The flow must not depend on the keyboard-trap fix
  being undiscoverable and must not introduce a new focus trap.
- [ ] At 200% zoom in a 720-pixel-wide window, the deletion announcement and
  recovery action remain readable and operable without covering required page
  or editor controls.
- [ ] Browser/service tests cover delete, confirmed save, separate-process or
  reload recovery, restored identity/payload/order, repeated activation, and
  normal/200% zoom keyboard operation.

## Engineering boundaries

- Preserve the existing page Trash behaviour; it is compliant and does not
  need redesign under this task.
- Reuse existing block IDs, serialization, persistence, and save confirmation.
- Do not add general history, permanent-delete management, bulk deletion,
  editor replacement, package work, security work, or unrelated QA coverage.
- This brief does not duplicate `MOTION-UX-001` or `MOTION-A11Y-001`; ensure the
  recovery control is visible and keyboard-accessible, but keep those fixes
  independently reviewable.

## Product verification request

Engineering should return focused tests and a short normal/200% zoom recording
showing delete, confirmed save, restart, recovery, and restored block identity.
Product will verify the destructive-action language and recovery usability;
Quality retains the full release regression pass.
