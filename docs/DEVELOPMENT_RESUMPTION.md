# Motion development resumption — 25 November 2026

## Current direction

Jake requested resuming Motion as his own Notion-style workspace, building on
the existing implementation. A dependable local Windows notebook is the
immediate platform target. Comparable core workspace capability remains the
broader goal: documents and blocks, linked knowledge, structured records and
views, portable data, and optional extensions.

Keep the established constraints: complete offline use without an account,
versioned structured data, no telemetry or silent remote resources, and optional
AI through documented interaction/command interfaces. AI agents must not receive
direct database credentials or database access.

The older Linux-only release scope remains historical acceptance context. The
current request authorizes Windows development; it does not relax data safety,
recovery, offline behavior or release validation.

## Recovered source baseline

- Repository: <https://github.com/JimBarnesly/Motion>
- Starting branch: `feat/notion-editor-chrome`
- Starting commit: `d4132534ea2512ae3886500a026b95fa31d66213`
- `main` at inspection: `6b2613b4620826223d5d325241dfa511ed968ed5`
- The starting branch contains `main` and 171 subsequent commits. Its changes
  span 153 files. Continuing from `main` would recreate existing work.
- Resumption branch: `feat/windows-notebook-resume`

The existing canonical core, typed application service, SQLite/FTS storage,
Tauri IPC boundary, IndexedDB development adapter, editor command system,
backups, formula component and test infrastructure are retained. No framework,
dependency or persisted-schema replacement is part of this increment.

The recovered branch already provides slash commands, contextual editor
controls, Markdown shortcuts/paste, page mentions/backlinks, recoverable edits,
canonical undo/redo, typed properties, saved table/list views, manual record
ordering and relative-date evaluation. These are existing assets, not features
newly invented during resumption.

## Implemented in this increment

### Dependable writing

- Enter keeps a nested continuation under its original parent and before its
  next sibling.
- Enter replaces a selection within one block, preserving unaffected reference
  identities and adjusting their offsets.
- Code Enter inserts a newline without creating another block and restores the
  caret immediately after the newline.
- Composition events do not split blocks or apply Markdown shortcuts while the
  input method is still composing. Final text uses confirmed persistence.
- Focus-only history snapshots do not consume the first undo. Nested split
  undo/redo retains block identity.
- Unknown extension payloads remain intact when splitting is unsupported.
- Cross-block Enter leaves the selection and content intact with an explanation;
  full multi-block selection editing remains incomplete.
- The browser compatibility command path now locates nested blocks and respects
  the same parent/sibling destinations as the native command model.
- Canonical heading/list/unsupported classes have matching styles. Ordinary
  block text preserves whitespace and line breaks. Flat numbered runs count and
  restart; fully hierarchical numbering is still incomplete.

### Nested saved-view filters

- Recursive AND/OR groups, group/condition negation, adding and removing groups,
  Apply, Clear and Cancel operate on a draft.
- Applying an untouched filter retains its complete tree and typed values,
  including repeated NOT wrappers. Editing one branch retains its siblings.
- Applying uses the existing `database.view-update` command; no new storage
  representation is introduced. Other saved views remain unchanged.
- A failed Apply or Clear retains the confirmed view and the editable draft for
  retry. Cancel does not mutate the view.
- Switching between date properties preserves the selected relative-date preset.
- Browser evaluation uses the existing record-property projection for title,
  timestamps and actor metadata.
- Collection comparisons with incompatible scalar/array operand contracts are
  not offered for new editing. Existing conditions are preserved unchanged.
  Complete collection containment needs coordinated canonical validation and
  evaluator work, rather than a browser-only change.

### Windows developer readiness

- Playwright starts the loopback server using a portable environment definition.
- File URLs become filesystem paths through `fileURLToPath`, including worker
  processes and the offline scanner. Network denial preloads are passed as
  discrete subprocess arguments.
- `npm run dev` and the standalone Web build compile the shared core assets
  first, so a clean dependency install does not leave the UI missing imports.
- The offline test pattern uses shell quoting compatible with Windows npm.
- Runtime preparation rejects unsupported platforms before downloading or
  writing a Linux runtime on Windows.
- [Windows development instructions](WINDOWS.md) cover the current local
  browser application and the native port's actual remaining boundaries.

### Import and renderer safety

- Independent review of the retained HTML-rendering boundaries identified an
  inherited attachment-size injection defect. Browser validation now requires
  a non-negative safe integer within the existing shared attachment limit;
  file rendering independently validates and escapes that value.
- Hostile JSON imports preserve the existing notebook and cannot create
  delegated action controls. Valid filename and media-type markup displays as
  literal text. Regression tests cover import, persistence and reload.
- The expired source-security review records were renewed only after reviewing
  all 16 remaining HTML sinks and their helper boundaries. Two obsolete filter
  entries were removed because the new filter editor creates DOM elements
  directly. Exact fingerprints, expiry checks and scanner rules remain in force.
  See the [renderer review](SECURITY_RENDERER_REVIEW_2026-11-25.md).

## Verification and limits

The recovered starting branch passed its workspace test suite on Node
`24.22.3`: 385 passed, zero failed, and one platform/privilege-specific skip.
The final increment's results are recorded in `STATUS.md` after verification.

Browser checks use the repository's Playwright runner and external HTTP(S) and
WebSocket denial fixture. The standard Playwright browser download was denied
by the execution environment. Local verification therefore uses an explicit
temporary configuration and Chromium `158.0.8127.0` supplied by an ephemeral
`@sparticuz/chromium` installation outside the repository. Project dependencies,
locks, the normal browser configuration and CI browser selection are unchanged.
This is local browser evidence, not a replacement for pinned CI or installed
desktop acceptance. Composition tests simulate browser composition events; they
do not establish behavior with every physical operating-system IME.

No native Windows installer has been built or installed. The Rust boundary,
single-writer lock, attachment publication and backup publication currently
depend on Unix/Linux guarantees. They require Windows implementations and native
tests. A different Tauri bundle target alone cannot provide that support.

## Continued delivery

| Workstream | Build on | Remaining outcome |
| --- | --- | --- |
| Windows native notebook | Existing Tauri shell and typed service | Windows handles/ACLs, single-writer exclusion, atomic attachments/backups, pinned runtime, installer and offline restart acceptance |
| Daily writing | Existing stable block commands and history | Multi-block selection/clipboard, complete nested list presentation, rich editing and larger-document interaction evidence |
| Structured notebooks | Existing records, properties and saved views | Populated type conversions, relations/rollups, integrated formula properties, then additional views |
| Migration and portability | Existing canonical JSON/Markdown/CSV and verified backup components | Complete user-facing interchange and Notion-export compatibility with explicit loss reporting |
| Optional AI and integrations | Documented interaction/command boundary | Bounded context and permissioned actions without direct database access |

The existing [Notion review](NOTION_PRODUCT_REVIEW.md),
[parity matrix](NOTION_PARITY_MATRIX.md) and execution documents remain useful.
Their capability statements must be checked against source and current evidence
before implementing supposedly missing work.

## Behavior research refreshed

Checked against Notion's public documentation on 25 November 2026:

- [Writing and block editing](https://www.notion.com/help/writing-and-editing-basics)
  supports the benchmark of typed blocks, keyboard/slash entry and structural
  block operations.
- [Views, filters and sorts](https://www.notion.com/help/views-filters-and-sorts)
  supports independent saved presentations over shared database records.
- [Pages offline](https://www.notion.com/help/use-pages-offline) describes
  individually downloaded pages and limited initial database rows. Motion's
  complete local workspace remains an explicit product requirement.

The research describes observable behavior. Motion retains its own branding,
assets, wording, data model and implementation.
