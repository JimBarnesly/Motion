# Motion quality and release acceptance status

Owner: Quality & Release Director  
Decision authority: Managing Director  
Reviewed: 2026-08-11
Current provisional V1 baseline: `f084a5d` (`feat/v1-phase-0-green-baseline`)
Quality disposition: **NOT ACCEPTED for V1 or public release**

The current baseline is provisional and will advance before merge as this
report and separately owned work are integrated. It is not an immutable release
candidate, and no passing immutable CI run or installed-package acceptance can
be attributed to it.

## V1 Phase 0 baseline — 2026-08-11

Phase 0 is **in progress; its clean-checkout exit gate is not met**. The six
missing workflow npm scripts have been restored, workflow script contracts are
self-gated, complete tracked Playwright spec selection is gated, and the
first-party static-analysis baseline has been repaired. Link lifecycle states,
accessible canonical search, race-hardened edit recovery, and suite-wide
HTTP(S)/WebSocket denial are integrated at `f084a5d`.

The audit host has Node `v20.20.2`, while the repository requires Node 22 or
newer. Dependencies became available in an isolated integration worktree, where
typecheck/build and focused suites passed. App-service runtime (`node:sqlite`),
Rust/Tauri, Playwright/browser execution, `gitleaks`, and advisory-backed gates
still require the pinned CI/release environment.

| Current Phase 0 evidence | Result | Acceptance boundary |
| --- | --- | --- |
| Workflow/E2E selection/network-denial source gates | 22 passed, 0 failed | Proves declarations and confinement policy only; Playwright itself was not run |
| Complete Web unit/source-boundary suite | 54 passed, 0 failed | Source-level Web evidence, not packaged native interaction |
| Core and Backup suites | 31/31 and 9/9 passed | Focused canonical and restore evidence |
| Root TypeScript typecheck and build | Passed | Real compilation on Node 20; Node 22 runtime CI remains required |
| First-party static-analysis scan | Passed: 80 files, 8 rules | Final release-security approval remains open |
| Static-analysis governance tests | 19 passed, 0 failed | Must be rerun on final combined bytes |
| Complete Node 22+ CI/release-security chain | Blocked / not run | Missing supported runtime and security tooling/data |
| Immutable CI run for exact V1 candidate | Missing | No frozen candidate exists |
| Installed x86-64/ARM64 AppImage and Debian acceptance | Missing | No package from this baseline was installed or launched |

This focused evidence does not satisfy `V1_SCOPE.md`: it does not prove the
complete editor, linked-search, six-view database, interchange, accessibility,
representative reliability/performance, signed artifact, or installed offline
user outcomes. V1 readiness must not be inferred from repaired gate wiring.

## Historical Motion 0.1.0 evidence — preserved

The remainder of this report records the legitimate 0.1.0 evidence reviewed on
2026-08-05. Its source and CI baselines are historical and must not be presented
as verification of `f084a5d` or of V1. The recorded historical baseline was
`8ae8a17` (`main`) plus the uncommitted working tree present at final retest.

Motion 0.1.0 had credible automated evidence for its canonical service and Web
workflow, including operation with networking denied. It did not have
user-facing acceptance evidence from installed native packages. Passing the
automated service smoke is not equivalent to launching and operating the Tauri
UI from an installed artifact.

The Managing Director's security decision is an external release gate. Quality
does not repeat or reinterpret that review. A release requires both this
acceptance report to pass and the security gate in
`OPERATIONS_SECURITY_REVIEW.md` to be explicitly satisfied or accepted by the
Managing Director.

## Historical 0.1.0 existing evidence

| Area | Evidence | Status |
| --- | --- | --- |
| CI verification | Typecheck, 62 unit/integration tests, production build, Playwright, local-only scan, secret scan, and benchmark smoke | Pass |
| Native package build | CI run `30876348219` built and uploaded x86-64 and ARM64 AppImage and Debian artifacts | Pass |
| Packaged runtime | `scripts/smoke-packaged-app.mjs` extracts each CI AppImage and uses its bundled runtime | Pass |
| Offline persistence and restart | Packaged service saves with network calls denied, terminates, restarts, and reloads the same SQLite content | Pass |
| Packaged search | Restored packaged workspace is searchable after restart | Pass |
| Backup/restore | Packaged service creates and verifies a backup, changes content, restores to a new workspace, and checks restored content | Pass |
| Browser workflow | Playwright creates, edits, reloads, searches, exports, trashes, reloads, and restores with external HTTP and WebSocket requests blocked | Pass |
| Staged ARM64 files | `sha256sum --check SHA256SUMS`; AppImage and Debian package both match on 2026-08-05 | Pass |

## Historical 0.1.0 focused RC verification — 2026-08-05

Host: Debian AArch64 `6.18.34+rpt-rpi-2712`, Node `v24.18.0`, npm
`11.16.0`. This host is the OpenClaw gateway, not a clean graphical acceptance
host. No package was installed and no native window was launched.

| Check | Command/evidence | Result |
| --- | --- | --- |
| Package/unit/integration | `npm test`: 63 passed, 0 failed | Pass |
| Syntax/config lint | `npm run lint`: 26 JavaScript files and 28 JSON files valid | Pass |
| Static type boundary | `npm run typecheck` | Pass |
| Production build | `npm run build` | Pass |
| Offline restart | `npm run test:offline`: separate-process SQLite reload plus offline asset scan | Pass |
| Core browser flow | `npm run test:e2e`: create/edit/reload/search/export with external networking blocked | Pass |
| Persistence/failure handling | Revision conflicts, corrupt restore, attachment promotion recovery, transaction/index rollback, real `SIGKILL` at SQLite/FTS commit boundaries, trash restore, and repeated save/load tests | Pass |
| Staged ARM64 integrity | `sha256sum --check SHA256SUMS`; AppImage and Debian package both `OK` | Pass |
| Debian metadata | `dpkg-deb --field`: package `motion`, version `0.1.0`, architecture `arm64` | Pass |
| Debian dependency resolution | `apt-get -s install <local arm64.deb>` resolved Motion and dependencies without changing the host | Pass (simulation only) |
| Packaged ARM64 service | `node scripts/smoke-packaged-app.mjs artifacts/release/Motion_0.1.0_aarch64.AppImage` | Pass |
| Full search benchmark | 10,000 pages/100,000 blocks; 224.36 ms query against 200 ms target on final retest | **Fail** |
| Installed AppImage/Debian native UI | Requires clean graphical host and complete sections A–D below | **Not run / blocking** |
| Cross-version upgrade/rollback | No previous release artifact or supported migration pair exists | Not applicable to first release; cold-copy procedure only |

GitHub Actions run
[`30975790973`](https://github.com/JimBarnesly/Motion/actions/runs/30975790973)
passed at exact HEAD `8ae8a173b25085351b0a2cfdf28ce61e9fb817b9`, including
verification, native x86-64 and AArch64 builds, and extracted packaged-runtime
offline restart smoke. This is build evidence, not installed-window acceptance.
The uncommitted lint and crash-boundary additions appeared during this RC pass
and were retested locally, but they are not covered by that immutable CI run.

### Reproducible defects

**MOTION-RC-001 — P1 — full search benchmark misses its target and does not
fail the command**

1. On the release source with Node 24, run `npm run benchmark`.
2. Observe the 10,000-page/100,000-block result.
3. On the final run, `queryMs` was `224.36`, `targetQueryMs` was `200`, and
   `queryTargetMet` was `false`.
4. Observe that npm still exits zero, so this target can regress without
   failing a release command. CI currently runs only `benchmark-smoke.mjs`, not
   this representative fixture.

Impact: search misses the documented latency target at the representative
fixture, and gate automation can report success despite the miss. This does not
indicate data loss, but it prevents a clean performance acceptance claim.

No additional reproducible functional or data-integrity defect was found in
the automated RC scope.

The ARM64 files currently staged in `artifacts/release/` are correctly typed as
an AArch64 AppImage and an `arm64` Debian package version 0.1.0. Equivalent
x86-64 files are CI artifacts, not locally staged evidence.

## Historical 0.1.0 required manual acceptance

Run the complete checklist on a clean representative x86-64 Linux host and a
clean representative ARM64 Linux host. Test both AppImage and Debian formats.
Record OS version, architecture, artifact filename, SHA-256, CI run, tester,
date, and pass/fail for every check. Use a fresh OS user or move aside the
application data directory between package-format runs so old state cannot hide
a first-launch fault.

### A. Artifact, install, and launch

- [ ] Download the artifact and its `SHA256SUMS`; run `sha256sum --check SHA256SUMS` from the artifact directory. Every selected file must report `OK`.
- [ ] AppImage: run `chmod +x <artifact>` and launch it while disconnected from all networks. The Motion window must open without downloading a runtime or showing a blank/error page.
- [ ] Debian: run `sudo apt install ./<artifact>.deb`, then launch `motion-desktop` and the **Motion** desktop-menu entry. Both launch paths must open the same persistent workspace.
- [ ] Confirm the footer says `Local workspace` and the save indicator changes from `Saving…` to `Saved to Motion`; `Browser development mode` is a failure.
- [ ] Close the window normally, relaunch, and confirm the last selected page and its content return.

### B. Complete offline first-release path

Keep networking disabled for this entire section.

- [ ] Click **New page**, title it `Release acceptance root`, and enter `Offline persistence marker 0.1.0` in the first block. Wait for `Saved to Motion`.
- [ ] Use **+ Add block** to add Heading 1, Task, Code, and Divider blocks. Edit the first three, tick the task, change their order with the block arrow buttons, then relaunch and confirm type, text, order, and task state persist.
- [ ] Use the page-row **+** button to add `Release acceptance child` inside the root. Move pages up/down where enabled, relaunch, and confirm hierarchy and order persist.
- [ ] Create a page titled `Link target`. In the root page type `[[Link target]]`; confirm it appears under **Outgoing links**. Open `Link target` and confirm the root appears under **Backlinks**. Rename it `Renamed link target`; confirm the link still resolves after relaunch.
- [ ] Click **New table**, title it `Acceptance table`, add a property and two rows, enter distinct values, relaunch, and confirm title, columns, row count, and values persist.
- [ ] Press `Ctrl+K`, search for `Offline persistence marker`, and open the root from the result. Search for a value from the table as a separate check.
- [ ] Click **Attach file** and choose a known small file. Confirm its filename, byte count, and hash prefix appear under **Confirmed attachments** and no success is shown before confirmation.
- [ ] Click **Export JSON**. Open the downloaded JSON locally and confirm it is valid JSON containing the root, child, link target, table, stable IDs, and edited block data.
- [ ] Click **Verified backup** and retain the downloaded JSON. Change the root marker to `Changed after backup`, wait for save, then click **Restore verified**, select the backup, verify the preview reports the expected page and attachment counts, and approve **Restore as a new workspace**. Confirm the restored workspace contains the original marker; create another verified backup and confirm its manifest still lists the attachment entry and checksum.
- [ ] Delete the root and approve the prompt. Confirm it and its child move to **Trash**, disappear from search, and remain in Trash after relaunch. Click **Restore**, relaunch, and confirm both pages and content return.
- [ ] With the root open and `Saved to Motion` visible, force-terminate the application process. Relaunch and confirm the last confirmed content is intact, search works, and no duplicate pages or blocks were created.
- [ ] Re-enable networking only after all preceding checks pass. Confirm no step required an account, login, remote service, or internet connection.

### C. Keyboard and accessibility

- [ ] Complete page creation, block-type selection, block movement, search, link opening, deletion cancellation, and trash restoration using only the keyboard. Focus must always remain visible and no control may trap focus.
- [ ] At 200% desktop/UI zoom, confirm navigation, editor, dialogs, table controls, status, and context panels remain readable and operable without clipped required controls.
- [ ] Run a screen-reader pass over navigation, editor blocks, search dialog, table, Trash, save status, attachment confirmation, and restore prompt. Controls must have usable names, state changes must be announced, and colour must not be the only state indication.

### D. Debian lifecycle

- [ ] After completing section B in the Debian build, run `sudo apt remove motion`, reinstall the same package, and confirm the workspace remains intact.
- [ ] Confirm uninstall removes the application launcher/binaries but does not silently delete user workspace data.

## Historical 0.1.0 remaining blockers

1. **P0 — Installed native acceptance:** sections A and B have no passing
   evidence on either supported architecture or package format.
2. **P0 — Full packaged user path:** the automated package smoke exercises the
   bundled service, not the native window, IPC interaction, dialogs, downloads,
   attachment picker, or desktop lifecycle.
3. **P0 — Crash-boundary confidence:** forced termination, concurrent writes,
   disk-full/write failure, and corrupt-index recovery lack packaged UI
   evidence. The manual termination check is necessary but does not replace
   engineering failure-injection tests.
4. **P1 — Accessibility:** no automated WCAG result or recorded keyboard and
   screen-reader pass exists for the packaged application.
5. **P1 — Representative performance:** the 250-page/2,000-block benchmark is a
   smoke fixture, while the full 10,000-page/100,000-block run missed its
   200 ms query target (224.36 ms on the final retest) without failing the command.
6. **External — Security:** the Managing Director's security disposition in
   `OPERATIONS_SECURITY_REVIEW.md` remains separately binding.
7. **P0 — Candidate immutability:** the final locally tested tree contains
   uncommitted implementation and CI changes not represented by the passing
   HEAD CI run. Freeze and commit the intended candidate, then rerun CI and this
   focused gate against that exact commit before release.

## Historical 0.1.0 acceptance rule and next action

Public release acceptance requires all P0 checks to pass on x86-64 and ARM64,
no unresolved data-loss or offline defect, recorded accessibility disposition,
and explicit clearance of the external security gate. Any failed step must be
filed with architecture, package type, exact reproduction, logs/screenshots,
and artifact checksum before retest.

**Next recommended action:** first freeze and commit the intended RC and obtain
a passing CI run for that exact commit. Then assign two clean-host acceptance
runs: one x86-64 tester and one ARM64 tester, each starting with the AppImage
and then the Debian package. Return the completed checklist and artifacts to
Quality for a go/no-go update; do not label 0.1.0 a public release before that
review.
