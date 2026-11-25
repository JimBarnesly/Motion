# Inline formatting implementation contract

Status: design only, 25 November 2026. No canonical3 implementation has begun. The reviewed pure range helper exists only in the interrupted local candidate until its exact source is recovered and published. Do not treat this document as completed functionality or approval of a release.

## Complete the slice together

Keep the current recovered architecture. Canonical data, startup migrations, stale-client protection, command validation, every editor text operation, search, exports and verified restore must agree before canonical3 is enabled in a published application. Do not release a backend3 change while the browser can still discard ranges.

| Contract | Version |
| --- | --- |
| Canonical Workspace.schemaVersion | 3 |
| SQLite structural migration sequence | Append7; preserve SQL1–6 bytes |
| Browser IndexedDB database version | 2 |
| Native app_dispatch.protocolVersion | 1, unchanged |
| motion_ui_load/save envelope | 2, unchanged |
| Private ui-state.json | 1, unchanged |
| Verified backup/archive/native save envelope | 1, unchanged |

## Canonical content and command semantics

Block gains optional structured marks, using the single reviewed inline-ranges implementation. Ranges are nonempty half-open UTF-16 offsets that never split a valid surrogate pair. Preserve existing lone surrogates and exact text; do not normalize graphemes.

Known styles are bold, italic, underline, strike and code, plus an external HTTP(S) link mark with validated href. Different styles may overlap; different link targets cannot overlap. Normalize identical adjacent/overlapping ranges in fixed order. Preserve accepted URL spelling, reject credentials/unsafe controls/whitespace/backslashes, and never fetch a mark target.

The reviewed helper limits are10,000,000 text UTF-16 units,4,096 input/output marks per block and2,048 href units. Add aggregate maxInlineMarks100,000 to canonical/command limits, with the same explicit override mechanism as other validation budgets.

| BlockContent input | Result |
| --- | --- |
| marks omitted, text unchanged | Preserve existing marks |
| marks omitted, text changed, existing marks absent/empty | Compatible plain-text update |
| marks omitted, text changed, existing marks nonempty | Reject before mutation; caller must send transformed marks |
| marks: [] | Explicit clear |
| marks: null, unsupported types/keys, malformed ranges | Reject atomically |
| Valid explicit marks | Validate against resulting text and normalize |

Use one content-application function for standalone and batch routes. Preserve omitted page references consistently; the current browser batch route differs from standalone/native and must be fixed. Do not infer mark preservation from equal text lengths.

Default insertion edge affinity for the first editor slice is explicit false/false; strictly interior typing still inherits the containing mark. Any later change to that user-visible behavior requires coordinated tests. Stable page references remain independent from external URL marks.

## Versioned migration

Provide explicit version-specific validation so valid canonical2 can be verified without pretending it is canonical3. Keep canonical1→2's documented aliases/property ordering/record membership as a distinct stage, followed by2→3. The2→3 stage clones, validates and changes only the schema discriminator. Leave marks absent; preserve identities, timestamps, children, references, unknown blocks/payloads, legacy rows, views and attachment metadata. Do not mutate the caller.

Web-v1 import is a different historical format and may flatten legacy children. Canonical2/3 must never fall through to that importer. Unsupported newer versions or mark vocabularies must fail without rewriting source; unknownData.marks remains opaque.

Current-format validation should not migrate on reads. Unknown versions remain intact and produce an actionable opening failure.

## Native startup durability

Existing service startup validates raw stored documents before constructing WorkspaceDocument. Add one explicit startup-owned canonical upgrade before every query, command and attachment recovery, while the existing native writer lease is held.

Append a private checkpoint table through SQLite migration7. Never alter checksummed migrations1–6. Add a storage transaction API that prepares and validates every workspace in the database, checks row/document ID and schema agreement, then uses one BEGIN IMMEDIATE transaction to:

1. Retain each affected row's exact original document_json, schema version, revision and timestamp, with a digest.
2. Publish upgraded canonical JSON/schema without changing row revision, row timestamp, document timestamps, identities or attachment bytes.
3. Commit all affected documents and their checkpoints atomically.

A malformed later workspace or any transaction failure must leave all canonical rows and checkpoint contents unchanged. Reopen must not rewrite current JSON or create duplicate checkpoints. Checkpoints are not silently replaced or automatically restored over later edits. They protect pre-upgrade canonical recovery inside the same database, not against loss of that file.

Do not use saveUnitOfWork for a format-only upgrade: it increments revision/timestamp. Do not use normal backup creation as the startup mechanism: its reads already require current validation.

## Browser startup durability and stale writers

Add an explicit adapter startup initializer using IndexedDB version1→2. The versionchange transaction must atomically retain the original complete structured-clone envelope and publish upgraded canonical content. Preserve revision, explicit home/null selection, expanded pages, folds, selected views and retained fields.

An already-open old client currently reopens database version1 and may put a stale whole snapshot. Raising the database version makes those version1 opens fail instead of overwriting upgraded content. Handle blocked upgrades visibly with retry; do not wipe data or silently fall back. An aborted transaction preserves the old version and original object. Do not claim original JSON bytes for a source stored only as a structured clone.

Ordinary load/query is not a migration entry point. Update direct test fixtures to distinguish legacy version1 seeding from current version2 inspection; retain real old-client refusal tests.

## Browser shared implementation

Follow the existing attachment-policy pipeline:

- A small web wrapper statically re-exports the compiled core inline-ranges module for development/Node.
- The production build copies that exact compiled standalone ESM to the matching web asset.
- The dev server exposes only the exact core/dist/inline-ranges.js route with existing fixed-path, realpath, regular-file, loopback and CSP checks.
- Manifest/network tests verify exact asset bytes, headers and rejection of unrelated core paths.
- Add no framework, dependency, remote fetch, broad filesystem route or CSP waiver.

If canonical validation requires a larger compiled module graph, use a closed distinct path and complete explicit asset manifest so existing web modules cannot substitute accidentally.

## Rendering, selection and drafts

Render safe DOM with createElement, text nodes and replaceChildren; editable textContent must remain exactly block.text. Never save rendered HTML as canonical data. Use literal newlines and existing pre-wrap behavior.

Selection helpers must map both anchor and focus to UTF-16 offsets within a block and restore direction across styled nodes. Toolbar bookmarks include workspace/page/block identity, draft generation and range; revalidate after awaited operations. Preserve the existing Ctrl+K search behavior. External navigation is a separate explicit capability decision; do not broaden native opener permissions as an incidental formatting change.

Transform the latest pending draft, not repeatedly the last confirmed block. Reuse editRecovery generation/confirmation ownership for text, marks and references; older acknowledgments must not replace newer drafts. Retry retains the complete candidate; Discard renders the confirmed marked content through the same renderer.

Capture pre-edit selection and draft before ordinary input, preferring real target ranges. A longest-common-prefix difference alone is ambiguous for repeated text and can split surrogates. During IME keep the original range/draft, avoid rerendering the composition host, and reconcile once at completion. Actual Chromium and installed WebView behavior must be exercised.

Intercept single-line and multiline paste as plain text. Preserve existing structured multiline behavior and mark surviving prefix/suffix on the correct resulting blocks.

## Text operations that must transform ranges

- Ordinary input and composition.
- Selected deletion, Enter split and container-header split.
- Code newline and adjacent-block Backspace merge.
- Single/multiline paste, including container headers and leading dividers.
- Slash-query removal and shortcuts that clear text.
- Mention replacement while preserving stable page references.
- Undo/redo, duplication, moving, failed-save recovery and reload.

Structural operations should preserve full blocks; text-changing operations must supply explicit resulting marks.

## Search, exports, backup and compatibility

Skip canonical marks only during traversal of the actual block tree. Preserve the existing ancestry distinction; globally ignoring every key named marks would alter opaque metadata.

Share one safe inline projection between core Markdown and backup subtree exports. Retain literal code, escaping and validated link destinations. JSON is the lossless reconstruction format, including unsupported opaque payloads.

Verify original backup envelopes and hashes before upgrading verified legacy snapshots. Restore then migrates before attachment staging and the fresh-workspace commit. Mark hrefs are external strings and must not be remapped as workspace IDs; existing page-reference remapping remains separate.

Rust currently validates the outer typed command envelope while Node/core validate nested content. Add coverage without gratuitous IPC version changes. Legacy ui-load schema1 projection must refuse canonical3 rather than return lossy inline/nested content.

## Ownership

The canonical owner edits core model/validation/workspace/index/migrations/export/serializer and backup validation/export/restore plus tests. The backend owner edits storage startup/checkpoint transaction, app-service command/startup integration, desktop legacy projection and focused Rust envelope tests. The editor owner edits browser adapter/IndexedDB initialization, DOM/selection/input recovery, text-surgery modules, asset manifest/server and browser tests. One owner integrates app.js after Gallery is frozen. Root combines exact reviewed scopes and runs the complete gates.

## Required acceptance

- Real SQLite multi-workspace upgrade, exact raw-JSON checkpoints, preserved revisions/timestamps/IDs, reopen idempotence, malformed-second-workspace rollback and interrupted uncommitted transaction recovery.
- Real IndexedDB atomic upgrade, abort/retry, blocked handling, original-state preservation and old-version writer refusal.
- Native/browser standalone and batch agreement for omitted/preserve/clear, malformed/unsupported ranges, Unicode and later-invalid-operation rollback.
- Actual editor formatting through backward selections, multiple unsaved edits, IME, nested Enter/paste/merge, slash/mentions, undo/redo, failed-save Retry/Discard and reload.
- Search targets only real blocks while opaque metadata is unchanged.
- Markdown/JSON exports and verified backup/restore preserve appropriate semantics, marks, references, attachments, unknown payloads and record membership.
- Explicit canonical1, canonical2 and Web-v1 compatibility fixtures; newer/unsupported data refuses without mutation.
- Existing source-security, offline assets, secret scanner, type equivalence, build and release gates remain unchanged.
