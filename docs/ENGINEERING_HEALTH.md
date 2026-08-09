# Engineering health

Owner: Engineering Director  
Decision authority: Managing Director  
Last reviewed: 2026-08-05

## Current evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Workspace tests | Pass | 60 tests across desktop, Web, app service, backup, core, formula, observability, search, storage, and invariants |
| Type checking | Pass | `npm run typecheck` |
| Production build | Pass | `npm run build` |
| Search benchmark smoke | Pass | 33.38 ms query time; 200 ms target; index integrity true (250 pages / 2,000 blocks) |
| Packaged service restart | Pass in CI | `scripts/smoke-packaged-app.mjs` extracts the AppImage and proves offline save, termination, restart, reload, search, backup, and restore |
| Installed native UI | Open | Launch and interaction have not been exercised on representative x86-64 and ARM64 hosts |

The smoke benchmark is a regression fixture, not representative-scale
performance evidence. It does not close the 10,000-page / 100,000-block gate.

## Engineering priorities for Managing Director coordination

1. Assign representative x86-64 and ARM64 installed-artifact acceptance. This
   closes native UI launch, interaction, persistence, and network-denied gates.
2. Keep the editor replacement behind the existing typed app-service boundary;
   do not combine it with storage or IPC redesign.
3. Add forced-termination, disk-full, and concurrent-writer tests before
   claiming crash-safe desktop durability.
4. Establish representative performance baselines before turning smoke numbers
   into CI budgets.

Product capability scope and sequencing remain owned by the Product Director in
`FEATURE_PARITY.md`. This document tracks implementation health and release
evidence only.
