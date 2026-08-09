# Motion 0.1.0 highest-impact accessibility gap

Owner: Product Director  
Identified: 2026-08-05  
Priority: P0 must-ship accessibility

## Selected defect

**MOTION-A11Y-001 — Editor blocks trap keyboard focus**

When focus is inside any editable block, Motion cancels every `Tab` and
`Shift+Tab` keypress, changes the block indentation, rerenders the document,
and explicitly returns focus to the same block. Once a keyboard or screen-reader
user enters the editor, conventional sequential navigation cannot leave it.

This is the most severe gap against the frozen minimum because it blocks access
from editing to the rest of the core workflow. Search, outgoing links and
backlinks, attachment and backup actions, verified restore, and page navigation
all remain elsewhere in the tab sequence, but Tab cannot reach them from the
editor. This finding is independent of the visual block-type defect
`MOTION-UX-001`.

## Reproduction and evidence

Reproduced in the locally rendered Motion Web-v1 UI used by the desktop shell:

1. Open Motion and create a page.
2. Enter text in the initial block and leave focus inside that block.
3. Press `Tab` repeatedly.
4. Observe that the block indents until the maximum indent is reached, then
   remains focused indefinitely. Focus never advances to the block delete/add
   controls or any later application control.
5. Press `Shift+Tab` repeatedly.
6. Observe that the block outdents until zero, then remains focused
   indefinitely. Focus never returns to controls earlier in the tab sequence.
7. Repeat at 200% zoom. The behaviour is unchanged.

Focused Playwright evidence was run at 100% and 200% zoom. At both zoom levels,
the active element remained the same contenteditable block after `Tab` and
after `Shift+Tab`; both reproductions passed their assertions of the current
defective behaviour. The temporary inspection test was removed after the run.

Affected source area:

- `apps/web/app.js`, document-level `keydown` handler: the branch beginning
  `if (event.key === "Tab")` calls `preventDefault()`, mutates `block.indent`,
  rerenders, and focuses the same block for both forward and reverse Tab.
- `apps/web/test/web.test.mjs` checks that keyboard mutation code exists but
  does not verify that users can exit a contenteditable block.
- `e2e/web.spec.ts` drives controls directly and does not traverse the complete
  workflow using sequential keyboard focus.

## Intended behaviour

An editor block must not be a keyboard trap. `Tab` and `Shift+Tab` must provide
a predictable way to move focus out of the block and through the surrounding
Motion controls in both directions. Indent/outdent may remain available, but
not as an unconditional override of the only conventional focus-navigation
keys.

The smallest implementation is to restore normal Tab traversal and move
indent/outdent to a documented, non-trapping shortcut or an explicit accessible
control using the existing indent mutation. Engineering may instead use a
clearly announced editor navigation mode, but only if a standard, discoverable
keystroke exits the block and automated assistive-technology semantics expose
that path. A hidden escape convention is not sufficient.

## Observable acceptance criteria

- [ ] From any editable block, one documented keyboard action moves focus to a
  logical control after the editor, and reverse navigation moves focus to a
  logical control before it; neither direction requires a pointer.
- [ ] Repeated `Tab` and `Shift+Tab` can traverse into and out of the editor and
  can reach page navigation, search, outgoing/backlink controls when present,
  **Export JSON**, **Verified backup**, and **Restore verified** without focus
  becoming stuck or cycling within one block.
- [ ] At maximum and minimum indentation, `Tab` and `Shift+Tab` still permit
  leaving the block; reaching an indent boundary never creates a trap.
- [ ] Indent/outdent, if retained for 0.1.0, uses an operable keyboard path that
  is distinguishable from focus traversal, preserves block identity/content,
  and is exposed through visible help or `aria-keyshortcuts` on an appropriately
  named control.
- [ ] A screen reader announces the destination control after focus leaves the
  block rather than repeatedly announcing the same unnamed editor textbox.
- [ ] Opening search moves focus into its search field; closing it returns focus
  to the invoking control. Selecting a result moves focus to a useful location
  on the opened page rather than leaving focus on removed dialog content.
- [ ] Invoking **Verified backup** and **Restore verified** by keyboard reaches
  the native file/confirmation flow and returns focus to a stable, visible
  control when cancelled or completed.
- [ ] Every criterion above passes at normal zoom and 200% zoom with no required
  control clipped, covered, or removed from the sequential focus order.
- [ ] Focused browser coverage starts in a contenteditable block and traverses
  the create/edit/link/search/backup/restore controls using keyboard input. It
  asserts active-element progression, reverse progression, search-dialog focus
  return, and stable focus after cancelled restore at both zoom levels.

## Engineering boundaries

- Change only editor keyboard/focus handling and the focused accessibility
  coverage needed to prove it.
- Reuse the existing indent mutation and core workflow controls. Do not replace
  the editor, redesign navigation, add block types, or fold in
  `MOTION-UX-001`.
- Do not change backup/restore semantics, package behaviour, security policy,
  or general QA gates. Those controls are traversal endpoints for this defect,
  not expanded feature work.
- Do not fix the trap by removing keyboard access to indentation without an
  explicit product note; preserve it through a non-trapping path if it remains
  part of the shipped interaction.

## Product verification request

Engineering should return the focused two-zoom test result and a short focus
sequence recording or trace. Product will verify that a keyboard-only user can
enter editing, leave it in both directions, complete search, and reach backup
and restore without prior knowledge of hidden shortcuts. Quality retains
ownership of the full frozen accessibility acceptance pass.
