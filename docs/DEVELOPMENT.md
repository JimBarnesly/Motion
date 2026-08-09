# Development guide

## Offline dependency policy

CI installs npm packages with `npm ci` and primes Cargo's cache using the
committed lockfile. Inventory generation itself is then forced offline and
locked:

```sh
cargo fetch --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
CARGO_NET_OFFLINE=true npm run inventory:dependencies:check
```

The check builds the npm production graph only from `package-lock.json`, runs
`cargo metadata --offline --locked` for the Cargo production graph, enforces
the SHA-256-bound reviewed `dependency-policy.json`, and byte-compares the result with
`docs/dependency-inventory.json`. It fails on inventory drift, unresolved
versions or sources, unknown/prohibited licences, and Git or file dependencies.

If the Cargo cache is incomplete, the offline check fails with a cache-prerequisite
message instead of accessing the network. Run the `cargo fetch --locked` command
above while dependency retrieval is permitted, then rerun the check. Intentional
dependency changes require `npm run inventory:dependencies` followed by review
of the canonical inventory diff.

Policy changes are separate security changes: the exact policy bytes are bound
to `dependency-policy-trust.json` and checked against the prior Git revision by
`scripts/dependency-policy-change-gate.mjs`.
Changing allowed/prohibited licences, registries, source kinds, or fail-closed
metadata requirements requires an explicit policy and trust-anchor diff plus a
`dependency-policy-change.json` record with the actual old/new digests,
rationale, Operations & Security approver role, exact generated scope diff, and
exact hashes for every changed dependency-governance control-plane file.
Regenerating the package inventory cannot approve policy broadening.

CI derives its comparison base from the event without a `HEAD^` fallback. Pull
requests use the merge base with the target SHA; existing-branch pushes use the
event's `before` SHA; new-branch pushes use the merge base with the fetched
default branch. Manual dispatch requires the operator to provide the full
40-character `comparison_base` commit SHA and fails closed when it is absent.

Repository administrators must protect the release branch with GitHub's
"Require a pull request before merging" and "Require review from Code Owners"
settings, require at least one approval, dismiss stale approvals when new commits
are pushed, require the `CI / verify` status check, and disallow bypass for the
policy author. `.github/CODEOWNERS` assigns itself, CI/release workflows,
dependency inventory and governance implementations, policies, anchors,
records, fixtures, and their tests to `@JimBarnesly` in the Operations &
Security role.
These live repository settings are administrative prerequisites and are not
changed by local tooling.

## Static-analysis release gate

Run the repository-pinned JavaScript/TypeScript and Rust source rules with:

```sh
mkdir -p artifacts/static-analysis
npm run static-analysis
npm run test:static-analysis
```

The rules and version are defined in `scripts/static-analysis.mjs` and
`static-analysis-policy.json`. They reject dynamic evaluation, shell execution,
raw HTML sinks, empty error handlers, uncontained user paths, first-party Rust
`unsafe`, and Rust shell/user-path patterns. Each suppression is bound to one
rule, exact logical path, and matched-code SHA-256 fingerprint containing its
line, column, and per-line occurrence coordinate, with evidence,
owner, substantive rationale, and an unexpired ISO date. Stale, duplicate,
broadened, or unmatched suppressions fail closed. The inventory is built from
the first-party source tree and rejects relevant untracked or omitted files.

On a Linux host with the native GTK/WebKit development packages installed, run
the pinned compiler/linter gate and produce its JSON Lines report with:

```sh
cargo clippy --locked --all-targets \
  --manifest-path apps/desktop/src-tauri/Cargo.toml \
  --message-format=json -- -D warnings \
  > artifacts/static-analysis/clippy.json
```

Both reports are uploaded by CI. Parse failures, missing reports, expired
suppressions, findings, Clippy warnings, and compiler errors fail closed.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

Native desktop work additionally requires Rust 1.97.1 and the Linux development
libraries used by Tauri 2. On Debian/Ubuntu install:

```sh
sudo apt-get install --no-install-recommends \
  build-essential file libayatana-appindicator3-dev libgtk-3-dev \
  librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev
```

Install dependencies with `npm install`, then run `npm test`, `npm run
typecheck`, and `npm run build`. The workspaces are intentionally small and do
not require Docker, a database server, or internet access at runtime.

Prove the canonical local vertical slice across a separate-process restart with
all Node networking APIs denied, and scan for remote runtime assets, with:

```sh
npm run test:offline
```

Validate the desktop boundary and native shell with:

```sh
npm run typecheck --workspace @motion/desktop
npm run test --workspace @motion/desktop
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run runtime:prepare --workspace @motion/desktop
npm run tauri:build --workspace @motion/desktop -- --bundles deb,appimage
node scripts/smoke-packaged-app.mjs apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage
```

For an ARM64 npm and native compile/test check without installing GTK/WebKit,
Rust, Node, or dependency caches on the host, use the same single entry point
locally and in CI:

```sh
npm run validate:isolated-rust-tauri
```

The image acquisition step uses digest-pinned Node and Rust base images and exact
Debian package versions. Validation subsequently runs with networking disabled,
a read-only container root, no capabilities, `no-new-privileges`, and UID/GID
1000. It verifies the complete installed-package inventory, Rust/Cargo hashes,
both lockfiles, ARM64 target, and candidate fingerprint before running npm lint,
typechecking and workspace tests plus locked offline Cargo tests and Tauri compile
checks. The private JSON report records the derived image ID, immutable base
digests, tool versions, inventory digest, candidate fingerprint and exact test
commands. A changed lock, dependency, tool, architecture, or candidate fails
closed. This is compile/test evidence only; it is not packaged-candidate
acceptance.

CI runs those checks and builds `.deb` and AppImage packages natively on both
x86-64 (`ubuntu-24.04`) and ARM64 (`ubuntu-24.04-arm`). This is a native runner
matrix, not cross-compilation, so GTK/WebKit linking and architecture-specific
Tauri tooling are exercised on each target architecture. Package preparation
downloads the matching official Node.js 24.18.0 archive from `nodejs.org`, checks
it against the embedded official SHA-256, and bundles only its executable. Set
`MOTION_NODE_RUNTIME_CACHE` to a preseeded directory and
`MOTION_NODE_RUNTIME_OFFLINE=1` for a network-free build. The installed program
uses one persistent bundled process and makes no runtime download.
The offline source scanner permits only those two exact pinned archive URLs and
only in the build preparation script; general `nodejs.org` references and all
application runtime network references still fail the scan.

On the current development host Rust/Cargo are installed, but the GTK/WebKit
development packages above are not. Consequently local TypeScript and Web tests
can run, while native compilation and packaging remain blocked until those
system packages are installed with administrator access.

## Boundaries

`packages/core` owns persisted types, mutations, migrations, search, and
exports. `apps/web` owns rendering and browser interaction. UI code should not
invent persisted fields or modify stored structures without passing through the
core package.

Networked services must be optional adapters. Any new outbound request requires
a visible user action, documentation, a timeout, and a usable offline failure
mode. Remote fonts, analytics, and telemetry are prohibited.

## Definition of done

- Persisted structures are versioned and migratable.
- Core behaviour has automated tests.
- Export output is deterministic and documented.
- The application builds without remote runtime assets.
- Offline local use remains complete.
- Security- or protocol-significant decisions have an ADR.
