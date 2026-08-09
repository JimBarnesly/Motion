# Motion 0.1.0 highest-impact usability defect

Owner: Product Director  
Identified: 2026-08-05  
Priority: P0 must-ship usability

## Selected defect

**MOTION-UX-001 — Block type control is visually hidden and undiscoverable**

Motion exposes each block's type through a 24-pixel-wide native select whose
text colour is transparent. A new user sees editable text but no labelled way
to turn it into the heading, task, code, or divider blocks required by the
frozen 0.1.0 workflow. The control becomes discoverable mainly by tabbing to it
or accidentally clicking the narrow blank area beside a block.

This is the highest-impact product defect found in the exercised workflow
because it blocks discovery of most of the shipped editor value at the first
content-creation step. Search, links, and export completed when their visible
controls or syntax were known; the editor's primary structure control does not
communicate that it exists.

## Reproduction and evidence

Tested against the locally runnable Motion Web UI at desktop size through the
create, edit, link, search, and export path. This uses the same Web-v1 UI that
the packaged Tauri shell presents; native persistence and packaging behaviour
are outside this product finding.

1. Start Motion with `npm run dev` and open the local URL.
2. Select **New page**, name the page, and type in its initial text block.
3. Inspect the block row without tabbing through controls or reading source.
4. Attempt to change the paragraph to a heading, task, code block, or divider.
5. Observe that no block-type label, icon, menu button, or affordance is
   visibly presented. A narrow blank/select-arrow target sits to the left of
   the text.
6. If that target is found and opened, the native option list contains the
   shipped types and changing type works.
7. Continue the known path: `[[Link target]]` produces an outgoing link,
   `Ctrl+K` finds page text, and **Export JSON** initiates an export. Those
   controls are visible or explicitly prompted, isolating the defect to block
   type discovery rather than general workflow failure.

Repository evidence:

- `apps/web/app.js` renders a select with accessible name `Block type` and the
  current type as its option text.
- `apps/web/styles.css` sets that select to `width: 24px`, `border: 0`,
  `background: transparent`, and `color: transparent`.
- The existing browser flow in `e2e/web.spec.ts` passes create/edit/search/
  export, but never attempts to discover or change a block type; it therefore
  does not catch this usability failure.

## Intended behaviour

Every editable block presents a compact but unmistakable block-type control.
It communicates the current type, opens the existing type choices by pointer
or keyboard, and returns focus to the edited block after a choice. The control
must remain usable when the row is not hovered and must not introduce a new
editor model, command palette, slash-command system, or block type.

The smallest suitable change is to restyle the existing select or replace its
presentation with a labelled trigger backed by the same existing type-change
handler. A visible current-type label such as **Text**, **Heading 1**, **Task**,
**Code**, or **Divider** is preferred over an unexplained icon.

## Observable acceptance criteria

- [ ] On a newly created page, a first-time user can identify how to change the
  initial paragraph's type without hovering, tabbing through unknown controls,
  or consulting documentation.
- [ ] Each editable block visibly communicates its current type at normal and
  200% zoom; the label is not transparent, clipped, or represented only by
  colour.
- [ ] Pointer users can open the type choices and select each 0.1.0 must-ship
  type: paragraph/text, Heading 1, Task, Code, and Divider.
- [ ] Keyboard users can focus the control, hear the accessible name and
  current value, open it, choose a type, and return to editing without a focus
  trap.
- [ ] Changing type preserves the block ID and compatible content; converting
  to Task exposes its completion control, and converting to Divider does not
  falsely present editable text.
- [ ] The selected type and task state survive save and relaunch through the
  packaged native persistence path.
- [ ] At a 720-pixel window width and 200% zoom, the control and block content
  remain operable without covering required editor actions.
- [ ] A browser test creates a page and changes one block through every
  must-ship type using the visible control. It asserts the visible current
  label, keyboard access, preserved block identity/content where applicable,
  and saved state after reload.

## Engineering boundaries

- Reuse the existing block type list, mutation path, persistence, and focus
  restoration; do not add a parallel editor command system.
- Do not replace the Web-v1 editor or add slash commands, drag/drop, new block
  types, rich formatting, or broad visual redesign under this defect.
- Do not alter links, search, export, native packaging, security controls, or
  release gates except where the focused regression test necessarily exercises
  persistence.
- Keep the current accessible name or improve it to include the current value;
  do not trade visual discoverability for keyboard or screen-reader regression.

## Product verification request

Engineering should return the focused test result and a screenshot at normal
zoom plus 200% zoom. Product will verify that an unprompted user can identify
and operate the control; Quality remains responsible for the frozen end-to-end
acceptance checklist.
