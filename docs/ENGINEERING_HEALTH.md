# Engineering health

Owner: Engineering Director  
Decision authority: Managing Director  
Last reviewed: 2026-08-11
Provisional evidence baseline: `8b7cc13` (`feat/v1-phase-0-green-baseline`)

This commit identifies the current integration point, not a frozen candidate.
The baseline will advance before merge as documentation and separately owned
work are integrated.

## Phase 0 gate disposition

**In progress / not closed.** Source-level CI contracts and focused
zero-dependency checks are repaired, but the clean-checkout Node 22+ execution
gate has not been demonstrated. No immutable CI run covers the combined V1
Phase 0 work.

| Gate | Current result | Evidence / limitation |
| --- | --- | --- |
| Six missing workflow npm scripts | Implemented | Root scripts now declare dependency release, offline advisory, runtime confinement, backup integrity, release-security preflight, and release-manifest gates. |
| Workflow command contract | Verified locally | Self-gated contract discovers workflow `npm run` references; 2 contract tests pass. |
| Complete E2E spec selection and network denial | Verified locally; execution blocked | Playwright discovery is complete; 7 source contracts prove suite-wide fail-closed HTTP(S)/WebSocket policy. Playwright/browser dependencies are absent. |
| Static-analysis base | Verified locally | Scanner passed 77 first-party files under 8 rules; 16 governance tests passed after final sink review. |
| Link, search, and failed-edit recovery | Integrated; focused evidence only | Link lifecycle, accessible canonical search, and race-hardened retry/discard are present; complete Web suite passed 45 tests. |
| Web zero-dependency build | Verified locally | `npm run build --workspace @motion/web` passed under Node 20. |
| Complete package/unit/integration suite | Blocked on audit host | Repository requires Node >=22; host is Node v20.20.2 and dependencies are not installed/cached. |
| Root typecheck/build and offline restart | Blocked on audit host | Supported Node, workspace dependencies, and generated package outputs are unavailable. |
| Release-security chain | Blocked / review open | Rust/Tauri, `gitleaks`, dependency tooling, and the offline advisory database are unavailable; static-analysis success alone is insufficient. |
| Immutable CI for V1 baseline | Missing | No complete run exists for one frozen Phase 0 commit. |
| Installed native package acceptance | Missing | No package from this baseline was installed and exercised on representative x86-64 and ARM64 graphical hosts. |

## Evidence boundaries

The passing local checks above are deterministic, zero-dependency source tests
or the Web asset build. They establish that the repaired contracts are present
and that focused source behavior is internally consistent. They do **not**
establish that workspace compilation, native packaging, browsers, advisory
collection, or release security pass under the supported toolchain.

Historical 0.1 CI/package evidence predates the provisional V1 baseline. It may
support continuity investigations, but it cannot be attributed to
`8b7cc13`, used as an immutable V1 run, or treated as installed-package
acceptance.

## Engineering priorities for Managing Director coordination

1. Obtain independent review of the final combined source and preserve exact
   coordinate-sensitive static-analysis evidence.
2. Provide a pinned Node 22+ environment and offline dependency/tool cache, then
   run `npm test`, `npm run typecheck`, `npm run build`,
   `npm run test:offline`, complete Playwright, and every release-security gate
   from a clean checkout.
3. Freeze the resulting commit and require complete immutable CI before using
   any Phase 0 result as release evidence.
4. Keep installed AppImage/Debian acceptance, accessibility, representative
   performance, and failure-injection gates open until exercised on the exact
   checksum-bound candidate.

Product scope remains defined by `V1_SCOPE.md`; capability implementation status
is tracked in `FEATURE_PARITY.md`. This document records engineering and release
evidence only.
