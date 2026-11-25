# Status

Updated: 2026-11-25

## Active Windows-first continuation

The live branch is `feat/windows-notebook-resume`,
[PR #2](https://github.com/JimBarnesly/Motion/pull/2). Read
[delivery state](DELIVERY_STATE.json) for the current remote checkpoint, active
work lease, exact CI evidence and immediate next action, and
[Windows 1.0 delivery](WINDOWS_1_0_DELIVERY.md) for acceptance and scope. The
initial resumption audit below is retained as historical evidence; its earlier
host limitations and unimplemented Windows checklist are no longer current.

The first complete installed Windows baseline passes at `8209982`, in
[Windows run45624078077](https://github.com/JimBarnesly/Motion/actions/runs/45624078077).
All native and installed storage tests pass. Actual GUI editing, attachments,
native backup/confirmed new-identity restore, concurrent-GUI rejection and Retry,
restart/search and uninstall/reinstall preservation pass with app/service/WebView
outbound traffic blocked. The downloaded installer and all 25 entries are
independently hashed in `WINDOWS_INSTALLED_EVIDENCE_8209982.json`. Complete core
verification, all 86 browser cases, Linux x64 and ARM64 native/package/offline
jobs pass at the same head.

The next reviewed candidate adds actual native Save As acceptance and nested
writing/search repairs; those changes are not covered by preceding installed
evidence. Absent-WebView/Windows 11 first installation, existing owner review,
runtime distribution evidence and practical local feature work remain. Release
remains **in development**. The hourly continuation observes the active lease.

## Initial resumption checkpoint — historical local audit

Development has resumed on `feat/windows-notebook-resume`, continuing from
`d4132534ea2512ae3886500a026b95fa31d66213` on `feat/notion-editor-chrome`.
That recovered branch contains `main` and 171 subsequent commits. The existing
canonical model, typed application service, SQLite/FTS storage, Tauri boundary,
editor and backup components remain the foundation.

The immediate target is a dependable local Windows notebook; comparable core
Notion workspace capability remains the broader goal. Complete offline use,
no account dependency, no telemetry, versioned structured data, and AI through
documented interaction/command interfaces remain requirements.

This increment repairs existing editor interactions and block presentation,
adds an editor for nested saved-view filters over the existing filter model,
hardens attachment metadata imports and rendering, and improves Windows
development readiness. See
[Development resumption](DEVELOPMENT_RESUMPTION.md) for the exact changes,
source provenance and remaining boundaries, and [Windows development](WINDOWS.md)
for the current local launch path.

**Status: local verification passed for the checks below; native Windows and
release acceptance are incomplete.** These results describe the resumption
working tree, not an immutable CI run or an installed desktop release.

## Evidence at the initial local resumption checkpoint

Runtime: Node `24.22.3`.

| Check | Result |
| --- | --- |
| Complete workspace suite, `npm test` | 405 passed, 0 failed, 1 pre-existing skip; 406 total |
| Root TypeScript typecheck | Passed |
| Root build | Passed |
| Offline verification | Passed |
| Complete Playwright suite | 73 passed, 0 failed |
| Repository lint | Passed; 147 JavaScript files and 43 JSON files |
| Workflow script contracts | 5 passed |
| Complete E2E-selection contract | 1 passed |
| Network-denial fixture contracts | 19 passed |
| Current source security scan | Passed; 106 first-party files, 8 unchanged rules |
| Static-analysis governance tests | 16 passed, 0 failed |
| Dependency-governance change check against the resumption base | No policy/control-plane changes detected |

The skipped test requires root privileges to construct foreign-owned lock
evidence. Offline verification includes a separate-process persistence test and
the remote-asset scan. Browser coverage includes failed filter saves, unchanged
nested filter round trips, editor selection/undo/composition cases, and hostile
attachment import preservation. Filter layout was also visually checked at
1440-pixel and 800-pixel viewport widths.

All 16 retained HTML sinks and their helper boundaries were independently
reviewed by an AI agent. The attachment metadata defect found in that review was
fixed with regression evidence before renewing the expired exact suppressions;
two removed filter sinks no longer need exceptions. This is bounded source
review, not human security approval or release certification. See the
[renderer review](SECURITY_RENDERER_REVIEW_2026-11-25.md).

The standard Playwright browser download returned HTTP 403 in this execution
environment. Browser verification used an ephemeral Chromium `158.0.8127.0`
installation and a temporary configuration outside the repository. The existing
fail-closed HTTP(S)/WebSocket denial fixture was unchanged. This is useful local
browser evidence, not a substitute for the normal pinned CI browser or installed
native testing.

## Outstanding work at the initial checkpoint — historical

- No native Windows build or installer has been built or installed. Windows
  single-writer ownership, filesystem security, atomic attachment/backup
  publication, runtime packaging and installed offline restart behavior remain
  to be implemented and exercised through the native boundary.
- Rust/Tauri verification and the complete release advisory, signing and
  attestation chain have not been run for this increment.
- The locked dependency inventory check could not complete because the local
  offline Cargo metadata/cache prerequisite is unavailable. Script-only npm
  changes do not change that inventory; dependency manifests, locks, trust
  anchors and dependency-governance records are unchanged.
- Cross-block editing and fully hierarchical numbered-list presentation remain
  incomplete. The current editor work preserves unsupported selections and
  payloads rather than silently changing them.
- Relations, rollups and formula-property integration remain incomplete;
  existing canonical models and the standalone formula package should be reused.
- User-facing interchange and Notion-export migration remain incomplete.
  Existing structured export and verified backup components remain available
  foundations, not proof of complete migration fidelity.

## Historical baseline — 11 August 2026

The remainder of this document preserves the August audit and its follow-up
actions as historical evidence. Its host limitations, provisional commit and
Linux release scope are not the current resumption status or current action
list.

Historical update: 2026-08-11
Provisional evidence baseline: `a8e0c2f` (`feat/v1-phase-0-green-baseline`)

The baseline is provisional because the Phase 0 documentation and remaining
integration work will advance the commit before merge. It is not an immutable
release candidate.

### August V1 Phase 0 — reproducible engineering baseline

**Status: in progress; exit gate not met.** The Phase 0 exit gate in
`NOTION_PARITY_EXECUTION_PLAN.md` requires a clean checkout to execute the
complete documented verification set with pinned inputs. This audit host has
Node `v20.20.2` while the repository requires Node 22 or newer, and it does not
have the dependency cache, Rust/Tauri toolchain, Playwright/browser payload,
`gitleaks`, or the offline advisory database needed by the complete CI and
release-security chain.

Integrated at the provisional baseline:

- Restored the six workflow-referenced npm contracts:
  `test:dependency-release-gate`, `validate:dependencies:offline`,
  `test:runtime-confinement`, `test:backup-integrity`,
  `test:release-security-preflight`, and `test:release-manifest`.
- Added a repository test that discovers workflow `npm run` references and
  fails when a referenced root script is undeclared. The release workflow now
  runs that contract test, so the contract is self-gated.
- Changed the release-gated `test:e2e` command from one named spec to complete
  Playwright discovery and added a test that rejects omitted tracked E2E specs.
- Repaired the first-party static-analysis policy and reviewed final renderer
  sinks. The scanner and fail-closed governance tests pass locally; this is not
  final release-security acceptance.
- Integrated honest live/trashed/missing link lifecycle states, backlink source
  focus, accessible canonical search, and race-hardened failed-edit recovery.
- Every tracked Playwright spec inherits fail-closed HTTP(S)/WebSocket denial;
  service workers and unprotected extra browser contexts are prohibited.
- Added fine-grained typed block commands and an atomic batch boundary with
  shared canonical ID, payload-shape, depth, count, and resource limits.
- Hardened restore with schema-directed identity remapping and enforced
  bidirectional database record membership. These paths compile and their
  focused Core/Backup tests pass; Node 22 runtime CI remains required.

### Evidence verified locally on 2026-08-11

These checks ran against an identical source tree in the dependency-equipped
integration worktree. They do not substitute for Node 22 runtime tests, actual
Playwright/native execution, or immutable CI:

| Check | Result at `a8e0c2f` |
| --- | --- |
| Workflow, complete-E2E-selection, and network-denial contracts | 22 passed, 0 failed |
| Complete Web unit/source-boundary suite | 54 passed, 0 failed |
| Core tests | 31 passed, 0 failed |
| Backup tests | 9 passed, 0 failed |
| Root TypeScript typecheck | Passed with TypeScript 5.9.3 |
| Root build | Passed |
| First-party static-analysis scan | Passed; 80 files, 8 rules |
| Static-analysis governance tests | 19 passed, 0 failed |

### Blocked or absent evidence at the August baseline

- Root typecheck/build and the Core, Backup, and Web suites passed in the
  dependency-equipped worktree. The complete `npm test`, app-service runtime
  tests, `npm run test:offline`, and actual Playwright execution remain blocked
  because this host runs Node 20; `node:sqlite` requires the pinned Node 22 CI runtime.
- Rust/Tauri builds, vulnerability collection, secret scanning with `gitleaks`,
  and advisory-database-backed release-security checks were not run here.
- No complete CI and release-security chain has passed against one immutable V1
  commit. There is no immutable Phase 0 CI run.
- No AppImage or Debian package from this baseline has passed installed native
  UI acceptance on representative x86-64 and ARM64 graphical hosts.
- V1 editor, database-view, interchange, accessibility, representative
  performance, failure-injection, signing, and attestation outcomes remain
  incomplete as defined by `V1_SCOPE.md`.

### Product foundation at the August baseline

The repository has a canonical typed application service, SQLite/FTS
persistence, an allowlisted Tauri boundary, a zero-network Web compatibility
UI, links/backlinks, search, attachments, structured export, and verified
backup primitives. Earlier CI built x86-64 and ARM64 0.1 packages and exercised
an extracted packaged service. That historical evidence remains useful, but it
does not prove the current provisional baseline, installed-window behavior, or
V1 acceptance.

### August follow-up actions — historical

1. Complete independent review of the final combined bytes and push the exact
   reviewed commit.
2. Run the complete Node 22 CI, Playwright, Rust/Tauri, and release-security
   chain on that immutable commit.
3. Preserve the complete immutable CI run, then perform checksum-bound installed
   package acceptance separately; do not infer package acceptance from service
   smoke tests.

See `ENGINEERING_HEALTH.md`, `QUALITY_RELEASE_STATUS.md`, `V1_SCOPE.md`, and
`FEATURE_PARITY.md` for gate-level evidence and remaining product gaps.


### Latest acceptance increment: `503ae3d`

Complete general CI, all 89 browser tests and both Linux platform jobs passed.
Windows native, prerequisite trust and installed storage checks also passed.
The new native Save As test opened the real authenticated dialog and rejected a
stale process identity, then failed while selecting its controls. The recorded
filename Edit label and ID now drive a reviewed selector with bounded pattern
and original-value diagnostics. Corrected Windows execution is pending; the
last complete installed/restart/reinstall baseline remains `8209982`.
See `WINDOWS_SAVE_DIALOG_EVIDENCE_503ae3d.json` for the failed-run evidence.
