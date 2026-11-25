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

## Current release evidence — 25 November 2026

**The first complete installed Windows baseline passes at `8209982`.**
[Windows run45624078077](https://github.com/JimBarnesly/Motion/actions/runs/45624078077)
built and installed current-user NSIS, authenticated its exact Microsoft
prerequisite and passed 28 native Rust tests, 23 filesystem/service tests, three
startup-gate cases and 23 installed native cases. Mapped-SMB positive controls,
refusal, unchanged filesystem/security state and cleanup also passed.

The actual installed GUI created/edited a page, ingested an attachment,
created/verified/previewed a native backup, confirmed restore into a new workspace
and preserved the original canonical state and revision. Exact restored attachment
bytes, concurrent-GUI exclusion, same-GUI Retry after owner close, normal restart,
search and uninstall/reinstall preservation all passed. Application, local service
and WebView outbound traffic was blocked before GUI launch.

The downloaded candidate ZIP and all 25 entries were independently hashed. The
installer is 323,707,772 bytes with SHA-256
`819fe5c375fc9be10d1c4605678562b9fbe49d3b929d2fa1d19733b6ffe64e09`.
See [candidate artifact](https://github.com/JimBarnesly/Motion/actions/runs/45624078077/artifacts/15028359148)
and `WINDOWS_INSTALLED_EVIDENCE_8209982.json`. This is a development installer,
not a 1.0 release.

[General CI run45624078178](https://github.com/JimBarnesly/Motion/actions/runs/45624078178)
passed every job: full verification including all 86 browser cases, Linux x64
packaged/offline acceptance and ARM64 isolated/native/package/offline acceptance.
The confinement-compatible lifecycle correction is proven in complete CI. The
older failed 28a4180 prerequisite attempt remains a failure; selected Microsoft
primary0 and the independent Windows payload probe succeeded in the new run,
without trusting EdgeBuild.

The next reviewed candidate extends the real Windows backup button through native
Save As and restores its exact saved disk bytes. Reviewed nested writing and native
nested-search repair are also ready for candidate CI. These later changes have
not executed on Windows and do not imply toggle/callout UI or inline rich text.

The hosted runner already contains WebView2: before/after registry and file
inventory show 131.0.2903.86 unchanged. This proves neither runtime absence nor the
selected running engine. Fully offline first installation on a clean Windows 11
machine remains open. The locked minimum-version path must be reviewed before
assuming it upgrades an older runtime offline.

Glib renewal and exact current PR-base governance pass machine checks; existing
Code Owner review remains outstanding. Evergreen binary/notice classification
and downstream terms remain evidence work, distinct from npm/Cargo checks and
payload signature verification. No separate pre-existing binary-approval form is
implied. Practical local feature work continues under `DELIVERY_STATE.json`;
version and release status remain in development.


### Native Save As control correction: `f9cba2a`

Complete general CI, all 89 browser tests and both Linux platform jobs passed.
Windows native, prerequisite trust, mapped-SMB and installed storage checks also
passed. The corrected native Save As test authenticated the exact process and
dialog, rejected the stale-process control, wrote/read back the selected path,
invoked Save and observed the dialog close. The actual application backup action
then failed: its success status never appeared, and the renderer reported an
unhandled object rejection. Saved-file validation and the later installed flow
were not reached. The production cause is under investigation; no successful
native file-save claim is made from dialog closure alone.

The last complete installed/restart/reinstall baseline remains `8209982`.
See `WINDOWS_SAVE_DIALOG_EVIDENCE_f9cba2a.json` for the exact failed-run evidence.
Separate isolated work prepares the bundled offline runtime upgrade, actual
running-engine measurement, offline vendor notices and installer network denial.

The next candidate handles backup preparation and save failures visibly, releases
the operation for retry, and requires the complete native publication response
before reporting success. Five real-service browser regressions and the existing
native restore browser case passed, alongside five backup unit cases and 22
coordinator/confinement cases. Windows diagnostics now record the failure stage,
bounded error code and selected destination before cleanup. These changes do not
establish the cause of the original native rejection; that remains the next
actual Windows run's task.

### Latest acceptance increment: `b295a52`

Complete core CI, all 94 browser cases and both Linux packaged/native/offline
jobs passed. Windows again passed all 28 Rust, 23 native/service, three startup
and 23 installed native cases, plus prerequisite trust and mapped-SMB checks.

Actual Save As succeeded. The application then reported `VALIDATION_FAILED`
during the service's destination-inspection lane, with a visible retry status
and no unhandled rejection. No file existed at the expected selected path; an
independent installed-helper inspection accepted that same expected path as
absent. The dialog's edit-control readback does not establish the path returned
to Rust. See `WINDOWS_SAVE_DIALOG_EVIDENCE_b295a52.json` for the exact run and
independently downloaded diagnostic ZIP.

The follow-up preserves the original refusal and all filesystem checks. Only
when both CI acceptance gates are explicitly set, it records fixed native error
codes/types and path fingerprints after an inspection failure. Raw paths, error
messages and notebook content are excluded. The next Windows run must establish
the discrepancy before a production fix or successful native-save claim.
