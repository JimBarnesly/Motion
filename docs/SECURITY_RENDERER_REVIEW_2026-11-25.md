# Renderer suppression review — 2026-11-25

## Scope and outcome

This is an independent **AI agent source review**, conducted separately from the
agent implementing the attachment repair. It covers the remaining raw HTML sinks
in `apps/web/app.js`, the helpers supplying those sinks, the canonical validation
boundary used by browser load/import, and the new filter editor. It is not human
approval, a general security audit, or native release certification.

The review found one inherited HTML injection defect in attachment-size rendering.
That defect was repaired and independently rechecked before this document was
written. No unresolved HTML injection defect was identified within the reviewed
sink/helper chains. This finding is limited to the source and regression evidence
described below; it does not establish safety for unrelated application paths.

The reviewed working tree builds on commit `d413253`. Its empty-policy inventory
contains **16** `js-no-html-sink` findings, all in `apps/web/app.js`. The former
filter-panel and added-filter-row sinks no longer exist. The new filter editor
does not require a raw HTML suppression.

## Review method and validation boundaries

The reviewer read `AGENTS.md`, the existing suppression rationales, and the
suppression requirements in `docs/DEVELOPMENT.md`. Inventory used the exported
`analyse` function from `scripts/static-analysis.mjs` with an in-memory empty
policy:

```js
{ schemaVersion: 2, rulesetVersion: "1.2.0", suppressions: [] }
```

That call was for inventory only. The reviewer did not change the clock, scanner,
rules, real policy, or source files. The normal static-analysis gate still needs
to validate the maintained policy separately.

The source review followed these boundaries:

- `canonicalWorkspace` calls both `assertSafeCanonicalWorkspaceIds` and
  `assertSafePropertyLifecycle`. Canonical browser load, schema-v2 JSON restore,
  and confirmed native snapshots pass through this function. Browser restore
  validates before saving the replacement workspace.
- `escapeHtml`, `escapeAttribute`, and the equivalent property/block helper
  encoders replace `&`, `<`, `>`, single quotes, and double quotes. Persisted IDs
  are validated and still encoded at HTML attribute boundaries. Validation alone
  is not treated as a substitute for output encoding.
- `propertyControlHtml` escapes labels, IDs, values, option names, and attachment
  names in their text or attribute contexts. It selects control markup from fixed
  property-type choices. System metadata uses read-only output.
- `renderBlockTypeSelect` escapes the block ID, option values, and labels,
  including preserved unsupported block types. Block CSS classes come from the
  local `BLOCK_TYPES` list or the fixed `unsupported` fallback. Block text is
  escaped; opaque unknown-block data is not rendered as HTML.
- `assertSafePropertyLifecycle` requires persisted column widths to be positive
  finite numbers. The reviewer confirmed that a width containing CSS
  declarations is rejected through the actual canonical validator chain. Other
  numeric substitutions in the reviewed templates are computed traversal depths,
  array lengths, or generated sort indices.
- Attachment sizes now pass `isValidAttachmentByteLength`, which requires a safe
  integer from zero through the existing shared `MAX_ATTACHMENT_BYTES` limit.
  `renderFileBlockContent` checks that predicate independently and escapes the
  displayed size. The limit is shared with core validation, not a new browser
  policy.
- Property names, filter values, operator labels, and error messages in
  `filter-editor.js` are assigned using DOM text/value APIs. Element types,
  attribute names, and event handlers are application-controlled. The module
  uses `createElement`, `textContent`, `value`, `dataset`, `append`, and
  `replaceChildren`; it contains no raw HTML sink. Its
  `createFilterValueControl` dependency also builds DOM controls directly.

The legacy `renderContext` implementation still contains five scanned sinks.
Before the initial render it is replaced by the DOM-based context renderer and
then wrapped to add internal URL controls. Its old sinks were nevertheless
reviewed individually because the scanner still inventories them.

## Each remaining sink

Every entry below has rule **`js-no-html-sink`** and file
**`apps/web/app.js`**. Coordinates are `line:column`, followed by the zero-based
occurrence on that line. They describe the reviewed snapshot; edits that change
these coordinates require fresh exact fingerprints.

| Coordinate | Function or role | Assessment and evidence boundary |
| --- | --- | --- |
| `230:17`, occurrence 0 | `renderNavigation`: page tree | Page IDs are attribute-escaped; titles and accessible labels are HTML-escaped. Classes and disclosure glyphs are fixed choices. Depth is an internally computed integer. |
| `231:150`, occurrence 0 | `renderNavigation`: favourites | Persisted page IDs and titles are encoded before composition. Other markup is fixed. |
| `232:84`, occurrence 0 | `renderNavigation`: trash | Restore IDs are attribute-escaped; titles are escaped in both text and accessible-label contexts. The empty message is fixed. |
| `236:111`, occurrence 0 | `render`: empty workspace | Fixed application markup with no persisted dynamic values. |
| `240:51`, occurrence 0 | `renderBreadcrumbs` | Each ancestor ID and title is escaped. Navigation state chooses only fixed back-button markup. |
| `252:325`, occurrence 0 | `renderDocument` | `pageHeader`, live-property controls, block text/type controls, and attachment metadata use the boundaries above. The formerly unsafe attachment-size path is now validated and independently encoded. |
| `261:2143`, occurrence 0 | `renderDatabase`: table/list composition | IDs, titles, view names, property names, and displayed values are encoded. Control/type labels are fixed mappings. Widths have a positive-finite numeric validation boundary. Record counts are array lengths; order-control states are fixed booleans. |
| `262:59`, occurrence 0 | Legacy `renderContext`: no-page outgoing | Assigns fixed application markup only. |
| `262:85`, occurrence 1 | Legacy `renderContext`: no-page backlinks | Second sink of the chained fixed-markup assignment; no dynamic values. |
| `262:714`, occurrence 2 | Legacy `renderContext`: outgoing links | Link IDs and titles are escaped by the local `html` helper. Its empty-message argument at this call site is a fixed string. |
| `262:782`, occurrence 3 | Legacy `renderContext`: backlinks | Same escaped helper boundary; the empty-message argument at this call site is fixed. |
| `262:845`, occurrence 4 | Legacy `renderContext`: attachment fallback | Assigns fixed application markup only. |
| `268:958`, occurrence 0 | `showPageMenu` | Page and destination IDs are attribute-escaped. Titles and accessible labels are escaped. Selected states and movement suffixes are fixed choices. |
| `269:207`, occurrence 0 | `showPropertyMenu` | Property IDs, names, and joined option names are escaped. Type values/labels come from fixed application choices. Visibility and deletion controls use fixed boolean branches. |
| `289:156`, occurrence 0 | `showSort` | `sortRow` escapes property IDs and names. Directions are fixed `asc`/`desc` choices. Row indices are generated by array iteration or the fixed initial row. |
| `340:52`, occurrence 0 | Add-sort-clause handler | Uses the same reviewed `sortRow` boundary. Its index is the current DOM child count; it does not interpolate persisted arbitrary index text. |

### Exact reviewed fingerprints

| Coordinate | Fingerprint |
| --- | --- |
| `230:17`, occurrence 0 | `sha256:8f2c76d2a19e11f8c53a998b39e0090379077ead034ed5c7ce395759506788eb` |
| `231:150`, occurrence 0 | `sha256:adf6c91138bf01f66c29adb598d0b4a77533c93fd7aae0e0ea0a901d3890597e` |
| `232:84`, occurrence 0 | `sha256:b1fece949553f5b946287b7ca034b2ca56bdf57c21f985c4d9756cc1f996b95b` |
| `236:111`, occurrence 0 | `sha256:fa521fbc092566e8365c7866d806a526d98ff8852e7241859666a0854ea1ecf4` |
| `240:51`, occurrence 0 | `sha256:33dd0db2996900e036e1a0833f773810a09333c1d9fd775ff0f6723c323bab4b` |
| `252:325`, occurrence 0 | `sha256:864d748371541c42fe878abfa7c2fec40d0b21ef056f7432df192600483597b2` |
| `261:2143`, occurrence 0 | `sha256:1bc923721124ff4078bf583f6bbe7d75633474f9aab8c694c37911652977e724` |
| `262:59`, occurrence 0 | `sha256:305a8c5eeeaba7e982527f06b1e952fd5fd9f08431b8076531e549ec555de952` |
| `262:85`, occurrence 1 | `sha256:cbae9a4a105a347a6231513197dc54b41e1113cebd09703464680069cab54fa5` |
| `262:714`, occurrence 2 | `sha256:ae00c73721f3ac8db7e991877efba800c7cce9b1e7ce9920e5d29d2ebb0bc6bf` |
| `262:782`, occurrence 3 | `sha256:a3403dd622bce7ec53ca9b0437f27f99adc5fb7042f1a5657c6ef4f4df6b28a5` |
| `262:845`, occurrence 4 | `sha256:05e8c574af12a4a0fd8c27b3d560c7ddf9c1b749aea915b7802004b736f836d7` |
| `268:958`, occurrence 0 | `sha256:a492e8bf28e1d27611b445d14d78e030d49fe377e45c2e2f61f26e2b26756b90` |
| `269:207`, occurrence 0 | `sha256:678f5947bf695c592a8982252aff435af4000c08be84360e9fdd076c8c2d26b0` |
| `289:156`, occurrence 0 | `sha256:fee70285d8ad38e4a1bd961227c79dfae6320c2e7af5ec71202765df3c21b3c9` |
| `340:52`, occurrence 0 | `sha256:e4b6256759641fe8153c0bb05ecdc379ac1dd998fe857a1f2b38b67573f2207c` |

The scanner fingerprints bind a sink's rule, file, matched code, trimmed source
line, and coordinate. They do **not** hash its complete helper dependency chain.
For example, the attachment helper repair did not change the document sink's
fingerprint. Changes to a named helper or validator therefore still require
review, even when the sink fingerprint remains unchanged.

## Defect and regression evidence

Before the repair, `renderFileBlockContent` interpolated
`attachment.byteLength` directly into HTML. The browser canonical-ID validator
checked attachment IDs but did not validate sizes, and the property-lifecycle
validator does not validate attachment metadata. A canonical JSON import could
therefore supply a string containing a button with a delegated action attribute.
This was an actual HTML/delegated-action injection path; the review did not rely
on proving execution of inline JavaScript.

The reviewer independently reproduced acceptance of a hostile attachment size
through both canonical validators using the existing hostile-ID fixture with
its required canonical title-property field supplied. After the separate repair,
the same validator-chain check rejects the size. The renderer also rejects it
through its own numeric predicate. Numeric zero and the exact shared maximum
remain accepted without coercion.

Evidence is intentionally split between source inspection and executable
regressions:

- `apps/web/test/canonical-security.test.mjs` covers hostile canonical IDs across
  identifier/reference classes, the separate attribute encoder, and the new
  attachment-size matrix. The size matrix rejects markup, numeric strings,
  null/undefined, booleans, objects/arrays, negative/fractional/non-finite values,
  and values above the existing limit without reflecting the payload in errors.
- `apps/web/test/property-lifecycle.test.mjs` covers canonical lifecycle
  validation and wiring schema-v2 restore through `canonicalWorkspace`.
  The reviewer additionally executed the actual validator chain with a
  CSS-declaration string in `columnWidths` and observed rejection. The existing
  width guard, rather than HTML attribute escaping alone, protects that CSS
  context.
- `apps/web/test/property-editors.test.mjs` exercises hostile plain/rich text,
  attachment-name escaping, labelled controls, metadata projection, and
  read-only system-property rendering.
- `apps/web/test/block-presentation.test.mjs` exercises hostile unknown block
  types and IDs against the option/control encoders and checks renderer wiring.
- `apps/web/test/filter-editor.test.mjs` covers unchanged typed values,
  negation preservation, invalid numeric/boolean edits, supported operator
  choices, and metadata projection. The absence of raw HTML in the filter DOM
  module was established by source review and the empty-policy inventory.
- `e2e/attachment-metadata.spec.ts` exercises hostile JSON import rejection
  before persistence, exact preservation of the previous IndexedDB workspace,
  absence of injected delegated-action controls, and persistence after reload.
  Its second case verifies literal filename/media-type markup alongside valid
  numeric rendering, including after reload. The implementing agent reproduced
  the hostile-import failure before the repair and reported both browser
  regressions passing afterward with the external-network-denial fixture.

The reviewer independently reran the canonical-security and property-lifecycle
tests after the repair; all 11 focused tests passed. Earlier source/helper review
also included passing property-editor, block-presentation, and filter-editor
tests. Final whole-workspace and full-browser-suite results belong in
`docs/STATUS.md`, not in this bounded review record.

## Required policy maintenance

The inherited policy has 18 suppressions with expiry `2026-11-05`; those entries
are expired on the review date. The maintenance plan is:

1. Retain the same rule ID and exact file for the 16 reviewed sinks, replace old
   fingerprints with the exact reviewed snapshot fingerprints, and attach
   substantive evidence/rationales naming the helper and validation boundaries.
2. Remove the two obsolete filter suppressions entirely. Their old fingerprints
   are `sha256:9570334cef959f890dc74f5294dda165cf0b252649bb6558d1095a36c3253244`
   and `sha256:0c18a0f0686a6d5bc1b724121afe131effe949fd765d74c67baaa3d5e09d27ee`.
   Do not redirect them to unrelated findings or add a suppression for the new
   DOM filter module.
3. Preserve the existing owner value, `Operations & Security Director`, as the
   policy's ownership field. This does not assert that a human in that role
   performed or approved this AI review.
4. Use the bounded 90-day expiry **`2027-02-23`** for the renewed entries. Keep
   policy schema version 2 and ruleset version `1.2.0`.
5. Run the real gate with the actual clock and final source inventory. Preserve
   expiry validation, exact coordinate-bound fingerprints, stale/unmatched and
   duplicate suppression rejection, inventory checks, and all scanner rules.
   Regenerate and review fingerprints if the source changes before the policy is
   maintained.

This document records review evidence and the maintenance plan. The reviewing
agent made no policy, scanner, or application-source edits during this review.


## Desktop CSP layout correction — 25 November continuation

Actual installed Windows diagnostics at `fbdbbd8` showed that the unchanged
`style-src 'self'` policy blocked the renderer's generated style attributes.
The blocked declarations controlled page-tree depth, block indentation and table
column widths. This was a presentation defect, distinct from the resolved native
startup failure.

The implementing reviewer replaced those declarations with numeric data
attributes and one post-render CSSOM helper. The root and desktop/backup reviewer
independently inspected all render entry points and escaping boundaries. Page
and block depths accept only nonnegative safe integers. Column widths remain
escaped in attributes and accept only positive finite numbers before assignment
to the fixed width property. Property names are fixed; no arbitrary CSS string,
new HTML sink, permission, canonical mutation or CSP change is introduced.
Separate navigation refreshes and both document/database rendering apply the
helper. The CSP-only reviewed `apps/web/app.js` SHA-256 was
`7e6325c7a7f88cfbb7e3ee7d77bc27ca6705d512cbd8cada15e3bcf7ce11805e`.
The later lifecycle/attachment increment below records the final source identity;
its sink inventory is unchanged from this reviewed CSP baseline.

The final sink inventory still has 16 entries. Only the database composition
line changes from column 2143 to 2140 at line 261, occurrence 0. Its reviewed
fingerprint changes from
`sha256:1bc923721124ff4078bf583f6bbe7d75633474f9aab8c694c37911652977e724`
to
`sha256:5ce05a7c3d6d1e006c894cd355c06e420d7fe44914bb90d8a9c6f4c3d4587a63`.
The other 15 HTML fingerprints and all native unsafe fingerprints are unchanged.
The root rebinds only that existing exception, retaining its rule, file, owner
and 23 February 2027 expiry, and adds this review/test evidence. No human approval
or broader allowance is inferred.

The new regression reads the actual server CSP header and compares it with the
unchanged desktop configuration. It first reproduced the old ignored depth and
width declarations; both cases pass after the correction. It checks computed
page/block indentation, mobile indentation, actual column geometry, saved width
persistence after reload and zero application policy violations. A deliberately
injected inline style remains blocked, establishing that CSP is still enforced.
Twelve existing editor/accessibility cases and all 54 web adapter/source tests
also pass. These are Chromium browser results; the next installed Windows run
must still cover the packaged UI.


## Page lifecycle durability and attachment selection continuation

The full Chromium suite exposed an actual browser restore race. The saved
selection could still identify a deleted page, so the old test's title assertion
succeeded before restore persisted. Trace evidence showed reload while the UI
still said `Saving…`. Independent source review also found that the adapter
resolved a successful IndexedDB request before the containing transaction
completed; a later transaction abort could therefore be reported as success.

The browser adapter now resolves on transaction completion, rejects transaction
abort/error (including abort after request success), and closes the connection.
Browser trash/restore saves canonical content and selected page in the same
rollback-safe candidate. `saveLocal` snapshots its candidate before queueing it.
Load and active-page resolution exclude deleted/stale page selections while
preserving an explicit null/home selection. Native canonical commands retain
their existing durability boundary; the separate UI-selection write is awaited,
and its failure reports a saved page change with unsaved selection instead of
claiming full completion or rolling back already committed canonical content.

A narrow lifecycle guard blocks another page lifecycle/navigation action and
history shortcuts while this write is pending. Independent review caught an
initial Ctrl+Z bypass: it could enqueue an old deleted snapshot behind restore.
Real held-transaction regressions failed with two writes before the guard and
pass with exactly one afterward, on both successful completion and abort.
Ordinary focus navigation remains available. These changes introduce no HTML
sink, dependency, wire protocol, canonical schema, CSP or capability change.

The actual Windows attachment test independently exposed a live `FileList`
being emptied when the input was cleared. The handler now captures an array of
`File` objects first. The regression uses a real DOM input and File bytes through
the unchanged ingestion controller and native adapter, with only the service
reply supplied by a fixture. It verifies exact bytes/authority/revision, selecting
the same file twice, input reset and cancelled selection. That browser regression
failed before the fix and passes afterward; installed publication/restore is
still required Windows evidence.

The root reviewed the final source and regression diff. The independent
editor/backup reviewer confirmed the transaction, rollback, selection, keyboard
and attachment boundaries. Focused Chromium execution passed **32/32**: eight
page-lifecycle cases, three original web cases, 20 destructive-accessibility
cases and the actual attachment-input case. Web adapter/source plus actual
service backup bridge tests passed **55/55**, and web typecheck passed. No new
injected native UI-selection failure fixture is claimed; that branch is source
reviewed, and complete installed Windows acceptance remains pending.

Final reviewed SHA-256 bindings:

| Source | SHA-256 |
| --- | --- |
| `apps/web/app.js` | `e90ee20af284f531f3b7d80c801c89c84800167f3b26747b5ac1b1d51b6f74ff` |
| `apps/web/app-adapter.js` | `1786df1a690752c4d675d343cba00d291469045ebe93f174c4f131fd8ac14227` |
| `e2e/page-lifecycle-persistence.spec.ts` | `5f09c37189b0d0a6a29e712b16d195438c80f3bd62ea9c41b90a0b143d7fa46e` |
| `e2e/attachment-file-input.spec.ts` | `170dff9017a4db5ad47bb859e22c8bc83fa7c7ff50830cae5ddade61d671516f` |
| `e2e/web.spec.ts` | `a87477895cc369bb72513a60197045d006447021a7f1a17ae71655b5efc9fabb` |

All 16 HTML sink fingerprints match the reviewed CSP baseline above. The only
existing suppression changed in this candidate remains its database-layout
fingerprint; rule, file, owner and expiry are retained.


The complete integration run then caught one presentation regression at the
narrow/200% layout: replacing the old `openPage` call had retained the open
sidebar after successful page restore, covering the page receiving focus. The
final restore path closes navigation only after durable lifecycle completion;
Trash and failed saves retain their prior behavior. Independent review confirmed
that ordering. Both full page-first flows now explicitly require the completion
announcement, page-title focus and closed sidebar. Those two flows plus the
eight lifecycle regressions pass **10/10**. The final app hash above includes
this correction. The original failed full run passed 85/86 and remains failure
evidence; the final complete run is recorded separately after it finishes.

Additional reviewed regression SHA-256: `e2e/first-run-table-creation.spec.ts` —
`ada0da3d9b6c9bab1517604aa41c4317459014d54c5a6122250b3db1fcd043c0`.

The root final complete Chromium run passed **86/86**, zero skipped, after the
mobile correction. All-workspace typecheck, lint and the unchanged secret scan
also passed. Source analysis passed for 122 first-party files under all eight
unchanged rules, with only the reviewed existing database-layout fingerprint
rebound. Actual installed Windows execution remains the next acceptance step.


### Browser confinement contract correction after `28a4180`

General CI run45619140898 passed compilation, typechecks, workspace tests and
preceding security checks, then correctly rejected the new lifecycle test's
dynamic import under the existing suite-wide confinement contract. The
production application and confinement rule are unchanged. The regression now
intercepts the next real IndexedDB read during normal application startup,
observes request success followed by transaction abort, requires the honest
startup failure, and exercises Retry to reopen the exact unchanged workspace.
It no longer imports an adapter or creates a browser outside the shared fixture.
All **19 unchanged confinement tests** and **eight lifecycle browser cases** pass
locally after this test-only correction. The earlier 86-case application run
remains valid local evidence; complete CI for the corrected test is still needed.

Corrected regression SHA-256: `f06d2b6397377fe1545b2a109f2666cbf9bdd14789d9e4252345372f386a4ebc`.


## Nested writing foundation after `8209982`

This bounded increment reuses the existing native command, browser confirmation,
canonical history and IndexedDB paths. The shared block-tree helper locates the
actual parent and sibling list, checks canonical ID/depth/count limits and copies
subtrees with fresh descendant IDs using the same path scheme as the native
WorkspaceDocument. References, attachment targets and opaque imported payloads
remain unchanged. Workspace-wide collision checks include pages, blocks,
attachments, databases, properties, options, rows and views. The candidate is
validated before insertion; rejected copies do not partially mutate the tree.

Both standalone and batched browser transforms now share the native guard that
rejects converting a block with children into a leaf type. Multiline Markdown
paste derives its actual parent/sibling position, including leading-divider and
last-child cases. The only app.js change delegates its Ctrl+D browser callback
to that existing typed reducer instead of copying only the root ID. No toggle
controls, folding, rich-text schema, capability, dependency or policy is added.

The independently implemented browser regression first failed on the previous
callback because three copied descendants retained their source IDs. After the
correction, all three new cases pass through the actual DOM and transaction-
complete IndexedDB reads: nested duplication with opaque/reference/attachment
preservation, independent copied-grandchild editing, ordinary nested paste,
leading-divider paste, undo/redo and durable reload. Twelve existing keyboard,
Enter, composition and accessibility browser cases also pass. Thirteen actual
core/browser parity tests and twenty unchanged confinement/release-contract
tests pass; the web build and offline asset check pass.

The independent editor previously reviewed the five pure foundation files, and
root reviewed the final seven-file integration and actual pre/post-fix evidence.
The app retains exactly the same sixteen raw HTML findings/fingerprints; the new
helpers introduce none. Root reran the unchanged source policy successfully over
123 first-party files. No suppression is added or broadened. Native installed
writing coverage and full candidate CI remain separate requirements; browser
development evidence is not recorded as Windows graphical acceptance.

| Reviewed source | SHA-256 |
| --- | --- |
| `apps/web/app.js` | `364b5da25f1454686500002232d7710e9197a56788dfdeaf22f3f2f219dd4692` |
| `e2e/nested-writing.spec.ts` | `ff0d4d6d45244944ba64a1b5061051e1b5fac2d1a31ed99a4fece90f1e3b47d3` |
| `apps/web/block-tree.js` | `7de91897bdd472b780f08b000b5226488ce28ee08458167c18afc246a4835983` |
| `apps/web/browser-edit-confirmation.js` | `edc56814cbece2126a85ef399aecfc097003bc54f157b49ea4984866c495c20c` |
| `apps/web/markdown-paste.js` | `43cb97daa9e0808f3e3607925cd906ce73ebf02ca483851580e1d41d6cbe24d3` |
| `apps/web/scripts/build-assets.mjs` | `ee5d30742f8bda7b76e14f78e017b48bc72248bb6c3d82cbc6d2c127ff7ad105` |
| `apps/web/test/block-tree.test.mjs` | `c478a7b9e7d1e559333903ae1d1e7d975bb7e920f6006833de82e90e7624980a` |


## Native nested-search repair after `8209982`

A full core-validated three-level fixture reproduced a native search defect:
nested canonical block text was indexed as a generic entity, so the existing
navigation resolver could not target it. Stored blocks use top-level `text`;
BlockContent is a command payload, not a stored `content` object.

The bounded fix carries block type and owning-page identity only along the actual
page root's canonical block/children tree. Independent review caught that a
simple inherited hint also treated opaque `unknownData.blocks[].children` as
canonical. Its negative regression failed on the initial draft and passes with
separate canonical-origin tracking; metadata edges clear the new context.

Migration 6 appends a derived-index repair using the existing pending-job
mechanism. The exact first five SQL strings/checksums are unchanged. Repair does
not rewrite canonical JSON, workspace schema, revision or update timestamps.
Tests inspect raw rows, old migration records and historical jobs; a second open
leaves FTS row IDs and job records unchanged. Real service tests cover nested
content edits, subtree moves between pages, correct ownership and reopening;
incremental rollback and unchanged other-page FTS rows are also checked.

All 70 storage/service tests pass, with zero failures/skips, and builds pass.
The four-file empty-policy static scan has zero findings. Independent editor
review and root integration review found no remaining blocker. This changes the
derived database migration version, not canonical workspace schema 2. Actual
candidate CI and installed acceptance remain required. No browser search/folding
behavior, dependency, policy or suppression changes are included here.

| Reviewed source | SHA-256 |
| --- | --- |
| `packages/storage/src/index.ts` | `d9c64b4a1a180b0a63ace3364b2dd5faf8361ddfee69a2559df148330b1d90b6` |
| `packages/storage/src/test/nested-search.test.ts` | `1a076b34be65e0459d23abfb8bf86d163a6f4f44997dcd67c7e5ae30d476a8ee` |
| `packages/storage/src/test/storage.test.ts` | `2d49d9fd271fa9ae781b228f1d4dd59b6d708407faf68de53be8ba26610ee8a8` |
| `packages/app-service/src/test/nested-search.test.ts` | `3499c75f987ce71e0a790ae95b76cbf28982f489b465764aa1486a6ccca5917e` |
