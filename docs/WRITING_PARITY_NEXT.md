# Next writing slice — implementation plan

Reviewed: 2026-11-25. Source checkpoint:
`0d1dd27475525597c9d7fb6f02c75d0fbf01780d` on
`feat/windows-notebook-resume`.

**This document is a plan, not an implementation or acceptance report.** Finish
the installed Windows, offline restart, persistence and recovery acceptance
first. Then continue the existing editor and canonical command model. Preserve
local-only operation, versioned structured data, unknown payloads and verified
exports. No new editor framework or dependency is needed for the first slice.

## 1. Activate existing toggle and callout blocks

Both types already exist in the canonical model and support nested children.
The production editor currently renders their editable text with an Unsupported
label and flattens all descendants. Basic support does not require a workspace
schema change. Icons, colors and canonical collapsed-state fields do not exist.

| Existing file | Reusable implementation / required change |
| --- | --- |
| `packages/core/src/model.ts`, `validation.ts` | Known toggle/callout types, text, references and child trees; closed payload validation. |
| `packages/core/src/workspace.ts` | Create, transform, update-content, move, indent, outdent, duplicate and delete. Preserve IDs, children and `unknownData`; retain leaf-conversion checks. |
| `packages/app-service/src/index.ts` | Typed operations, atomic `block.batch`, revision checks, rollback and search/backlink updates. No new command is needed for basic block support. |
| `apps/web/app.js` | Add type controls and rendering; reuse recursive `findBlockLocation`, selection offsets and caret restoration. Replace unconditional flattening with a visible-tree projection. |
| `apps/web/slash-entry.js`, `styles.css` | Expose both existing types; add an accessible toggle disclosure and a neutral callout presentation. |
| `apps/web/editor-structure.js` | Define explicit Enter/Backspace behavior. Toggle/callout are absent from split/merge allowlists; merely adding their names would inherit generic sibling splitting. |
| `apps/web/markdown-paste.js` | Fix the nested-paste blocker: `multilinePasteCommands` searches only root blocks and creates new blocks with `parentBlockId: null`, while the caller passes `page.blocks`. Use actual parent/sibling locations. |
| `apps/web/editor-history.js`, `edit-recovery.js`, `operation-coordinator.js` | Reuse canonical history, pending-edit confirmation and recovery. Flush a child edit before hiding its subtree. |
| `apps/web/browser-edit-confirmation.js` | Keep the browser compatibility reducer consistent with native typed operations. |
| `apps/web/scripts/build-assets.mjs` | Include any new browser module in `WEB_ASSETS` and retain offline build checks. |

### Complete vertical slice

- Create toggle/callout through slash entry or the existing type selector.
- Edit and reorder children with existing structural commands; multiline paste
  stays under the actual parent. Define header Enter behavior deliberately.
- Toggle disclosure exposes `aria-expanded` and a controlled child region.
  Folding changes visibility only, never canonical `children`.
- Search/backlink navigation to a hidden block expands its ancestors. Collapsing
  a focused subtree returns focus to its header after pending edits are handled.
- Preserve full trees, references and opaque payloads across undo/redo, restart,
  JSON export and verified backup restore.

For remembered folding, use an optional bounded `collapsedBlockIds` field in
view state, with an empty default for existing documents. This is a coordinated
change: `apps/desktop/ui-state-validation.mjs`, the Rust UI-state validator in
`apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/service-runner.mjs`,
`apps/web/app-adapter.js` and `apps/web/app.js` currently accept/serialize only
the known UI-state fields. Updating one location will reject or lose the value.
Do not repurpose task `checked`, canonical `unknownData`, or remove children.

### Meaningful verification

Extend existing helper tests and `e2e/editor-enter.spec.ts`: create each type,
nest a child, paste several lines into it, move it, collapse/reopen, undo/redo,
and verify the actual saved tree. Add a failed-save case showing that collapse
does not discard a pending edit, plus hidden-child search/backlink focus.
Extend the app-service restart/export/restore tests to verify IDs, types,
children, references and unknown payloads. Check keyboard disclosure behavior
and run the resulting writing case through the installed Windows path after
the platform baseline passes.

## 2. Add inline marks and text hyperlinks as a versioned slice

There is no production inline-mark representation at the source checkpoint.
`BlockContent` is `{ text, references? }`; the database property named
`rich-text` is also a plain string. `spikes/002-editor-yjs/editor.mjs` is a
headless serialization/undo spike with no mark schema or production integration.
`docs/adr/0006-editor-framework.md` is a provisional direction, not an available
working rich editor.

The smallest complete mark slice is selected-text bold plus a validated HTTP(S)
hyperlink, with other marks reusing the resulting machinery. Use an explicit
bounded canonical mark-range model alongside text; define UTF-16 offsets,
overlap normalization, insertion affinity and clearing semantics before UI work.
Render approved elements from that data. Rendered HTML must not become the
stored document.

| Boundary | Required coordinated work |
| --- | --- |
| Canonical model/service | Extend `model.ts`, `validation.ts`, `workspace.ts` and app-service closed content/block validators. Add a workspace-format migration and malformed-range tests. |
| Browser editing | Replace `textContent`-only assumptions in `app.js`; preserve marks through input/composition, selection, undo and confirmation. Update both standalone and batch paths in `browser-edit-confirmation.js`. |
| Text surgery | Update `editor-structure.js`, `markdown-paste.js`, `slash-entry.js`, `mention-entry.js` and `reference-reconciliation.js` together. Share range transformations rather than leaving stale offsets. |
| Clipboard | Define deterministic plain-text paste and a bounded safe rich copy/paste format if formatting preservation is in scope. There is currently no production rich clipboard serializer. |
| Links | Keep stable page references and `internal-links.js` navigation separate from external URL marks. Installed Windows needs a narrow validated user-action command to open external URLs; the main-window capability grants no opener or shell access. |
| Persistence/search | JSON storage already retains complete pages; no separate mark table is required. In `packages/storage/src/index.ts`, exclude mark metadata from recursive entity traversal so it cannot produce synthetic title-bearing search entries. |
| Export/restore | Update both `packages/core/src/export.ts` and `packages/backup/src/index.ts`. The latter's subtree Markdown currently emits text only; static HTML is an escaped `<pre>`. Keep JSON lossless. Restore remaps block `pageId` and `references[].pageId` explicitly; any new ID-bearing shape needs its own remapping. |

### Compatibility and data-loss pitfalls

- Workspace v2 uses closed block keys. Adding marks under the same version makes
  older readers reject those blocks. Update canonical migrations and actual
  workspace gates in `apps/web/canonical-security.js`/`app.js`; the outer
  UI-state format is a separate contract.
- `packages/core/src/migrations/web-v1.ts` builds legacy blocks with empty
  children. Do not route current nested documents through that import adapter.
- Existing reference validation checks nonnegative ordered offsets, but does not
  require `end <= text.length`. New marks need complete bounds and Unicode
  behavior; do not copy that omission.
- Define whether omitted marks preserve existing data and whether an empty
  array clears them. Browser standalone/batch and native operations must agree.
- Preserve formatting across every text replacement, not only toolbar actions.
  Test split/merge, nested paste, slash removal, mentions, IME and emoji offsets.
- Verify escaping/URL validation, restart, retry, clipboard, Markdown output and
  JSON/backup round trips before calling the inline slice complete.

## Source recovery check

Read-only comparison of advertised remote heads, local refs, worktrees and
stashes found no additional rich-text/toggle implementation to recover. Prior
editor-chrome, property-contract, saved-view and baseline branches are ancestors
of this checkpoint. Divergent branches cover earlier search, recovery, link
lifecycle and runtime work. `git cherry` confirms the link-lifecycle change is
already present by patch; the current implementation also adds previews. There
is one checkout and no stash. Do not merge older branches just to obtain these
already-present features.
