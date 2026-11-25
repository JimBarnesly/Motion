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
