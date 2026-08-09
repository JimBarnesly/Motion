# Motion 0.1.0 stable-link lifecycle review

Owner: Product Director  
Reviewed: 2026-08-05

## Outcome

Motion preserves internal-link identity through rename, restart, restore, and
verified backup remapping. Its user-facing Trash state is defective.

**MOTION-UX-004 — Links to trashed pages masquerade as active links**

When a target page moves to Trash, the source page still presents it as an
ordinary outgoing-link button with no deleted/unavailable status. Activating
that button opens the trashed page in the normal editor even though the page is
absent from ordinary navigation and search. Users cannot tell whether the
target is active, deleted, or safe to edit.

This is the highest-impact gap because it makes deletion state contradictory
and undermines trust in both links and Trash. The stable ID is retained—the
problem is that Motion conceals and bypasses the target's lifecycle state.

## Reproduction and evidence

1. Create `Link source` and `Link target` pages.
2. Enter `See [[Link target]]` in the source. Confirm **Outgoing links** shows a
   `Link target` button and the target shows the source under **Backlinks**.
3. Rename the target to `Renamed target` and reload.
4. Confirm the source text and outgoing-link label use `Renamed target`; the
   link still resolves, demonstrating stable identity through rename/restart.
5. Open the target and choose **Delete**, accepting the move-to-Trash prompt.
6. Return to the source and inspect **Outgoing links** at normal and 200% zoom.
7. Observe a normal `Renamed target` button with no `In Trash`, `Deleted`, or
   `Unavailable` state.
8. Activate it. Motion opens the trashed page in the normal editor even though
   no corresponding page exists in the ordinary Pages navigation or search.
9. Use the separate Trash restore action, reload, and return to the source.
   The same stable link becomes ordinarily valid again.

A focused Playwright reproduction exercised rename, reload, Trash, 200% zoom,
navigation into the deleted target, restore, and another reload. The temporary
inspection test was removed after the run.

Canonical backup evidence:

- `packages/backup/src/test/backup.test.ts` backs up a workspace containing a
  materialised `linkIndex`, restores it under a new workspace ID, remaps source
  page, target page, and block IDs, then proves semantic equality after
  reversing the remap.
- The application-service vertical-slice test proves backlinks survive service
  restart and page trash/restore. It does not assert user-facing deleted-target
  presentation.

Affected source area:

- `apps/web/app.js`, `renderContext()`: outgoing target IDs are mapped to pages
  and filtered only for existence, not `page.deleted`.
- `apps/web/app.js`, `linksHtml()`: only archived state is labelled; deleted
  state is neither styled nor included in the accessible name.
- `apps/web/app.js`, generic `data-open-page` handler: sets a deleted page as
  active without lifecycle validation.
- Startup and search already reject deleted active/results, creating the
  contradiction with context-link navigation.

## Intended behaviour

Stable links remain associated with their target while it is in Trash, but the
UI must present that lifecycle state honestly. A link to a trashed page must be
labelled **In Trash** visually and in its accessible name. It must not silently
open the deleted page as an ordinary editable document.

The smallest suitable behaviour is for activation to focus or reveal the
matching Trash entry and offer the existing **Restore** action. A compact
restore confirmation is also acceptable if it uses the same page-restore path.
Restoring the target must reactivate the original stable link automatically;
no link recreation or text rewrite should be required.

## Observable acceptance criteria

- [ ] Renaming a target updates displayed link text while preserving the same
  target page ID, outgoing link, and backlink across save and restart.
- [ ] Moving the target to Trash retains the link relationship but labels it
  `Renamed target (in Trash)` or equivalent in visible text and accessible
  name; colour or styling alone is insufficient.
- [ ] A trashed target is excluded from ordinary Pages navigation and search,
  and link activation cannot open it as a normal editable page.
- [ ] Activating a trashed-target link by pointer, Enter, or Space takes the
  user to a clear recovery path using the existing Restore action and explains
  why ordinary navigation is unavailable.
- [ ] Cancelling recovery leaves the target in Trash, the source unchanged,
  and focus on a stable trashed-link or Trash control.
- [ ] Restoring reactivates the same link and backlink immediately and after
  restart without changing source block ID, source page ID, or target page ID.
- [ ] A verified backup made with an active or trashed target restores into a
  clean workspace with correctly remapped internal IDs, the same lifecycle
  state, and the same understandable link behaviour after restart.
- [ ] If a target is genuinely missing rather than recoverably trashed, Motion
  labels it as unavailable/broken and does not offer a false Restore action.
- [ ] At normal zoom and 200% zoom in a 720-pixel-wide window, the link label,
  lifecycle state, and recovery action remain readable, keyboard-operable, and
  free from clipping or hover-only discovery.
- [ ] Focused tests cover rename/restart, trash state, blocked normal opening,
  recovery cancellation, restore/restart, clean-profile backup restore, missing
  target, keyboard navigation, and normal/200% zoom.

## Engineering boundaries

- Reuse the existing stable IDs, link metadata, page Trash, and restore path.
- Do not delete or rewrite links when a target enters Trash, and do not create
  a second broken-link registry.
- Do not add graph view, deep links, link previews, aliases, unlinked mentions,
  permanent deletion, or broad editor work under this defect.
- Do not alter attachment handling, package validation, security controls, or
  general QA gates.

## Product verification request

Engineering should return focused normal/200% zoom evidence showing rename,
restart, Trash labelling, blocked ordinary opening, restore, and clean-profile
backup restore. Product will verify wording and recovery clarity; Quality
retains the full release regression pass.
