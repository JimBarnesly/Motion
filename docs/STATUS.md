# Status

Updated: 2026-08-11
Provisional evidence baseline: `fd15dbe` (`feat/v1-phase-0-green-baseline`)

The baseline is provisional because the Phase 0 documentation and remaining
integration work will advance the commit before merge. It is not an immutable
release candidate.

## V1 Phase 0 — reproducible engineering baseline

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
  shared canonical ID, payload-shape, depth, count, and resource limits. These
  TypeScript paths still require supported-toolchain compilation in CI.

## Evidence verified locally on 2026-08-11

These checks ran against an identical source tree in the dependency-equipped
integration worktree. They do not substitute for Node 22 runtime tests, actual
Playwright/native execution, or immutable CI:

| Check | Result at `fd15dbe` |
| --- | --- |
| Workflow, complete-E2E-selection, and network-denial contracts | 22 passed, 0 failed |
| Complete Web unit/source-boundary suite | 54 passed, 0 failed |
| Core tests | 24 passed, 0 failed |
| Backup tests | 5 passed, 0 failed |
| Root TypeScript typecheck | Passed with TypeScript 5.9.3 |
| Root build | Passed |
| First-party static-analysis scan | Passed; 80 files, 8 rules |
| Static-analysis governance tests | 16 passed, 0 failed |

## Blocked or absent evidence

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

## Current product foundation

The repository has a canonical typed application service, SQLite/FTS
persistence, an allowlisted Tauri boundary, a zero-network Web compatibility
UI, links/backlinks, search, attachments, structured export, and verified
backup primitives. Earlier CI built x86-64 and ARM64 0.1 packages and exercised
an extracted packaged service. That historical evidence remains useful, but it
does not prove the current provisional baseline, installed-window behavior, or
V1 acceptance.

## Next actions

1. Complete independent review of the final combined bytes and push the exact
   reviewed commit.
2. Run the complete Node 22 CI, Playwright, Rust/Tauri, and release-security
   chain on that immutable commit.
3. Preserve the complete immutable CI run, then perform checksum-bound installed
   package acceptance separately; do not infer package acceptance from service
   smoke tests.

See `ENGINEERING_HEALTH.md`, `QUALITY_RELEASE_STATUS.md`, `V1_SCOPE.md`, and
`FEATURE_PARITY.md` for gate-level evidence and remaining product gaps.
