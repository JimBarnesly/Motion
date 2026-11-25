# Motion 1.0 delivery — Windows first

Authorized by Jacob Waugh on 25 November 2026: continue implementation, finish the
Windows installer first, then reach practical Notion feature parity without
cloud dependencies. Expected laptop delivery: **3 December 2026, Australia/Perth**.
This is the delivery target; it is not a substitute for acceptance evidence.

## Product contract

- A local Windows 11 x64 desktop notebook with a bundled runtime and an installer
  that can install without fetching prerequisites from the internet.
- Complete workspace operation without accounts, subscription checks, hosted
  storage, telemetry, silent remote content, or an internet connection.
- Preserve the existing versioned canonical model, stable identities, typed
  command/query boundary, SQLite/FTS persistence and recoverable edits.
- Optional AI uses documented commands and interaction methods, with no direct
  database credentials or database access.
- Use original Motion design and code. Keep existing working features and improve
  their behaviour instead of replacing the application or framework wholesale.

GitHub CI and this development scheduler are development infrastructure, not
runtime dependencies of the installed notebook.

## Order and acceptance

| Priority | Work | Evidence required before completion |
| --- | --- | --- |
| W1 | Windows native boundary | Actual Windows tests for ACLs, reparse points, stable file identity, single-writer exclusion, crash release and process cleanup; existing Linux behaviour retained |
| W2 | Attachments and verified backups | Atomic publication/replacement, cancellation and interruption recovery, hostile-path rejection, attachment verification and round trips on Windows |
| W3 | Installer | Checksum-pinned Node x64 resource, offline WebView2 installer, per-user NSIS setup, complete required resources, uninstall preserving user data |
| W4 | Installed acceptance | Install into a clean user profile, launch without development tools, create/edit/search, exit/relaunch persistence, concurrent-instance exclusion, attachments and backup/restore with external network disabled |
| P1 | Daily writing | Rich inline marks and links, reliable multi-block selection/clipboard, nested list presentation, toggle/callout/image/page blocks, undo and failed-save recovery |
| P2 | Structured notebooks | Existing typed records/table/list/filter/sort remain reliable; practical board/calendar/gallery views; usable relations/rollups and formula properties with validation and dependency errors |
| P3 | Navigation and page tools | Workspace selection, recent pages, page duplicate/templates/icons, layout controls, settings and keyboard accessibility |
| P4 | Portability | User-facing canonical JSON and Markdown/CSV interchange, Notion-export migration with explicit unsupported-content/loss reporting, tested backup reconstruction |
| R1 | 1.0 release | Exact-commit CI and release gates, installed Windows acceptance, no known data-loss blocker, documented remaining local-feature gaps, downloadable checksummed installer and reproducible build record |

Use `NOTION_PARITY_MATRIX.md` as the feature inventory. A model field is not an
implemented feature, and local unit tests are not installed application evidence.
If a local Notion capability cannot be completed safely by the target, record its
actual state and reason. Do not silently remove it or claim full parity.

Cloud publishing, hosted multi-user permissions, live team collaboration,
cloud-only embeds, Notion AI and third-party SaaS integrations are outside this
local notebook's parity goal. Their absence must not prevent a local 1.0 release.

## Delivery targets

- **25–27 November:** native Windows implementation, CI and installer acceptance.
- **28–30 November:** core writing and database workflows, prioritising complete
  useful vertical slices over unused model coverage.
- **1–2 December:** interchange, keyboard/usability checks, reliability and
  installed acceptance; fix release blockers before adding optional features.
- **3 December:** deliver a verified 1.0 if all required gates pass. Otherwise
  report the exact candidate readiness and remaining blockers, and continue work.

These are targets, not guarantees. Do not set the version or publish a final
release merely because the date has arrived.

## Durable continuation

Continuation branch: `feat/windows-notebook-resume`, PR #2. Starting saved
checkpoint: `fed424dd9681e047ad74f0396f501928e70ccf8b`. Always discover the latest
remote head and read `DELIVERY_STATE.json` before editing.

The hourly continuation task runs at :45 in Australia/Perth. It should execute
useful bounded work and persist evidence, not repeatedly announce unfinished
features. Notify Jacob for material milestones, genuine blockers, delivery-target
risk or completion. Never send messages to third parties without authorization.

Use an isolated checkout if another worker is active. A non-expired active lease
in `DELIVERY_STATE.json` prevents a second worker from writing. Claim/renew/release
the lease using remote expected-head updates, and stop if that comparison fails.
A lease lasts at most two hours and must be renewed while work continues. Keep
uncommitted checkpoints durable when a run cannot finish. Never erase a concurrent
worker's changes. Disable the scheduled task once release acceptance is complete.

## Initial platform implementation

Use a narrow native Windows helper exposed by the same bundled Motion executable
before GUI startup. It authenticates private ACLs and file identity, rejects
reparse points, pins directories against rename, holds the single-writer guard,
and performs bounded attachment/backup operations. Node retains the existing
canonical service and passes through this helper only for Windows filesystem
operations that its portable APIs cannot safely express. Keep Linux descriptor
semantics intact. Native helper messages are local bounded JSON over stdio;
there is no network listener.

## Known release evidence at handoff

The preceding increment passed 405 local workspace tests (one privilege-dependent
skip), 73 browser tests and type/build/offline/source checks. GitHub run
45585445817 passed the Linux x64 native build and packaged offline/restart checks.
Its verify job failed on the inherited expired RUSTSEC-2024-0429 exception;
ARM64 isolation failed the pinned package-inventory comparison. These failures
remain open and must be resolved with evidence, not disabled checks. Windows
implementation and installed acceptance are still pending.
