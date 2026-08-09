# Motion mobile navigation focus remediation

Owner: Product Director  
Reviewed: 2026-08-06  
Defect: MOTION-UX-010  
Priority: P0 navigation accessibility

## Selected defect

**The mobile/equivalent-200% navigation drawer opens visually without moving
keyboard focus into it or containing navigation within the open drawer.**

At widths up to 720 px the sidebar is translated off-screen and exposed by
adding `.open`. Activating **Open navigation** leaves focus on that obscured
trigger. The next Tab moves to a breadcrumb behind the drawer, not to **Close
navigation** or the first sidebar action. Pointer-closing the drawer leaves
focus on the now off-screen **Close navigation** button.

This is the highest-impact verified remaining navigation defect. The drawer is
the constrained-layout route to workspace pages, persistent page/table
creation, Search, Trash, Export JSON, Restore, Attach file, Verified backup,
and Restore verified. A keyboard user can see those controls but cannot enter
their focus sequence without wrapping through obscured application content.
The same missing lifecycle also risks leaving focus behind an open drawer or
inside a closed drawer after page, Trash, creation, or recovery actions.

MOTION-UX-006, UX-007, and UX-009 are excluded. MOTION-UX-008 established the
persistent table action; this defect concerns the containing drawer's general
open/close and focus contract across every navigation destination.

## Reproduction evidence

A focused Playwright inspection used a clean profile and the current rendered
candidate:

1. At 640 x 800, create `Navigation persistence marker`, wait for confirmed
   save, and reload.
2. Focus **Open navigation** and press Enter.
3. The sidebar has class `open` and is visible, but **Open navigation** remains
   focused behind it.
4. Press Tab. Focus moves to the `Navigation persistence marker` breadcrumb
   behind the drawer; it does not enter the drawer.
5. Pointer-click **Close navigation**. The drawer translates off-screen while
   the hidden Close button retains focus.
6. At 1280 x 800, the persistent sidebar's Search, Add page, New table, Export,
   and Restore entry points remain visible; the failure is specific to the
   constrained drawer lifecycle.

The mobile reproduction passed its assertions of the current defective
behaviour. The normal-layout inspection encountered only a strict test-locator
ambiguity because both the empty state and sidebar correctly expose **New
table**; it did not reveal a product failure. The temporary test was removed.

Affected source:

- `apps/web/app.js`: `openSidebar` and `closeSidebar` only add/remove `.open`.
- `apps/web/app.js`: page selection removes `.open` after rerender but assigns
  no destination focus; Trash restore and root creation render/focus content
  without consistently closing the drawer.
- `apps/web/styles.css`: the closed sidebar is visually translated, not removed
  from sequential focus or the accessibility tree.
- `apps/web/index.html`: no drawer dialog semantics, backdrop, inert-region, or
  expanded-state relationship is exposed.

Reload preserves the active page and reproduces the same defect. Canonical
restart, Trash/restore, search, export, and verified-backup tests confirm that
the underlying content remains durable; this is navigation state and focus
corruption, not persisted workspace corruption.

## Bounded implementation brief

Give the existing constrained sidebar one explicit drawer lifecycle. When
opened, expose its state and move focus to **Close navigation** (the stable
first control). While open, prevent keyboard and assistive-technology
navigation into obscured main/context content. Escape, Close, and a pointer
backdrop close the drawer and return focus to **Open navigation** unless an
activated navigation command has a more useful visible destination.

When a sidebar command opens content, close the drawer first and move focus to
that command's logical destination: page/table title, matching search result
destination, restored page title, or the stable invoking recovery control
after cancellation/failure. Reuse current actions and rendering; do not
redesign navigation or introduce a routing framework.

### Open, traversal, and close acceptance criteria

- [ ] Pointer click, Enter, and Space on **Open navigation** open the same
  drawer, set `aria-expanded="true"`, and move focus to **Close navigation**.
- [ ] The trigger identifies the controlled sidebar with `aria-controls`; the
  sidebar has an understandable navigation/drawer name and open state.
- [ ] While open, Tab and Shift+Tab traverse only visible drawer controls in
  logical DOM order and wrap or stop according to a documented modal-drawer
  pattern. They never reach breadcrumbs, editor, table, context panel, or the
  obscured Open trigger.
- [ ] Main and context content are inert and unavailable to the accessibility
  tree only while the drawer is open. No data or selection changes merely from
  opening or closing it.
- [ ] **Close navigation**, Escape, and backdrop pointer activation close the
  drawer, set `aria-expanded="false"`, and return focus to **Open navigation**.
  Clicking inside the drawer does not dismiss it accidentally.
- [ ] After closing, no translated/off-screen drawer control remains focusable
  or announced. Reopening starts at Close, not at a stale prior node.
- [ ] If focus is lost because the window/application is deactivated, returning
  does not place it behind the still-open drawer.

### Destination and recovery acceptance criteria

- [ ] Selecting a page or table closes the drawer and focuses its visible title
  without changing its stable ID, content, active selection, or sibling order.
- [ ] **Add page** and **New table** retain MOTION-UX-008 behaviour, close the
  drawer after confirmed creation, and focus the new title. Save failure closes
  or retains the drawer consistently, leaves no unconfirmed entity, focuses a
  visible retry control, and announces the failure.
- [ ] Opening Search from the drawer moves focus into the search field. Escape
  from Search returns focus to the visible Search trigger in the still-open
  drawer; selecting a result closes both search and drawer and focuses the page
  title or matching table row.
- [ ] Moving content to Trash while the drawer is closed and then opening the
  drawer exposes its restore action. Restoring closes the drawer, focuses the
  restored page title, and announces success; failure retains a visible stable
  focus target and changes no content.
- [ ] Export JSON, Restore, Attach file, Verified backup, and Restore verified
  remain reachable inside the drawer. Cancelling a picker/confirmation returns
  focus to its visible invoking control; success moves focus only when the
  existing operation has a defined useful destination.
- [ ] A failed backup/restore never closes the drawer onto hidden focus, never
  claims success, and preserves the current workspace byte-for-byte.

### Persistence and recovery acceptance criteria

- [ ] Opening, closing, tabbing within, or dismissing the drawer creates no
  workspace revision, save, search-index change, export difference, or backup
  difference.
- [ ] The last confirmed active page/table and its exact blocks, rows, values,
  IDs, Trash state, and hierarchy survive reload and complete process restart.
  After restart the drawer begins closed with focusable **Open navigation**.
- [ ] JSON restore and verified-backup clean-workspace restore reproduce the
  same durable content; the restored workspace uses the same closed drawer
  default and focus contract.
- [ ] Cancelled or failed restore leaves both workspace content and drawer
  interaction usable. It cannot strand focus in a hidden file input, closed
  drawer, removed search dialog, or obscured main region.
- [ ] Trash/restore and search projections remain governed by their current
  persistence boundaries; this task does not change indexing or recovery data.

### Normal and equivalent-200% acceptance criteria

- [ ] At normal layout (1280 x 800), the persistent sidebar remains non-modal:
  all sidebar and main controls retain their current logical sequential order,
  and no mobile-only Close control enters the accessibility tree.
- [ ] At 720 px width and 640 x 800 equivalent-200% layout, the drawer,
  backdrop, Close control, Search, Pages, Trash, and backup/restore entry points
  remain visible or vertically scrollable without page-level horizontal
  scrolling.
- [ ] Focus indicators are fully visible at both layouts, including the first
  and last drawer controls and footer controls after vertical scrolling.
- [ ] Drawer content does not become unreachable at short heights; scrolling
  the drawer does not scroll obscured main content.
- [ ] Reduced-motion mode removes the transition without changing focus timing,
  inert state, announcements, or destination behaviour.
- [ ] Focused automated coverage exercises pointer, Enter, Space, Tab,
  Shift+Tab, Escape, backdrop and Close; page/table selection; Search close and
  selection; Trash restore; recovery cancellation/failure; reload/process
  restart; normal/equivalent-200%; reduced motion; active-element progression;
  and accessibility-tree/inert-state assertions.

## Engineering boundaries

- Reuse the existing sidebar, controls, media breakpoint, page/search/Trash/
  creation handlers, status region, persistence, and recovery paths.
- Do not replace the sidebar, add a navigation library, redesign information
  architecture, introduce gestures, alter desktop layout, or combine this with
  UX-006, UX-007, UX-009, table editing, search indexing, or backup semantics.
- A small drawer open/close/focus helper and backdrop are in scope. A general
  application focus manager is not.

## Verification handoff

Engineering should return one bounded normal/equivalent-200% trace covering
open/close focus, contained traversal, Escape/backdrop, page/table destinations,
Search return and result focus, Trash restore, backup/restore cancellation and
failure, reload/restart, reduced motion, and accessibility-tree state. Product
will verify that an unprompted keyboard user can open the constrained
navigation, reach every sidebar entry point, and return to useful content
without focus entering obscured or off-screen UI.
