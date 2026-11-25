# glib advisory review — 25 November 2026

**Status: AI technical review only. No exception, approval, policy, dependency, or gate was changed by this review.**

The inherited `RUSTSEC-2024-0429` exception expired on 5 November 2026. The configured gate must continue to reject that expired exception until an authorized policy change or a compatible dependency fix is recorded.

## Finding

The locked Linux dependency graph still contains affected `glib 0.18.5`. Examination of the resolved crate sources found no production caller of the affected iterator constructor outside glib. The Windows MSVC target graph does not contain glib, GTK, or WebKitGTK at all. This supports a narrowly scoped, time-bounded exception review for the existing Linux dependency graph; it does not prove that the vulnerable crate is fixed or authorize renewal.

## Reviewed inputs

| Input | Observed value |
| --- | --- |
| Motion commit at review | `09376b09b2ad8e0217d0466ef60608feb3c3c605` plus the in-progress Windows implementation |
| Cargo lockfile | `apps/desktop/src-tauri/Cargo.lock` |
| Lockfile SHA-256 | `154f7934089d10ee4d1eb3a944fc1c2fc140da7ffdba4030c2545c42270ee623` |
| Resolution | Cargo 1.97.1, `--locked --offline`, existing default features |
| Linux target | `x86_64-unknown-linux-gnu` |
| Windows target | `x86_64-pc-windows-msvc` |
| Source material | Motion Rust source and every registry package reachable from the target-filtered Cargo metadata root, including build dependencies |

Missing registry sources were fetched using `cargo fetch --locked`. No manifest or lockfile was edited for that inspection. The target-specific package counts below describe Cargo's resolved source graph, not an instrumented binary call graph.

## Advisory and fixed-version status

[RustSec's current advisory](https://rustsec.org/advisories/RUSTSEC-2024-0429.html), checked on the review date, identifies unsound iterator operations on `glib::VariantStrIter` in `>=0.15.0, <0.20.0`; the listed patched range is `>=0.20.0`. Its affected methods are `next`, `nth`, `last`, `next_back`, and `nth_back`. The bug passes an immutable pointer reference to a C function that writes through it. Optimized builds can consequently use a null pointer, causing undefined behavior and crashes. The upstream correction changes the out-argument to a mutable reference; see [gtk-rs-core PR 1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343).

The cached, checksum-verified `glib-0.18.5/src/variant_iter.rs` contains the affected implementation: `impl_get` initializes `p` to null and passes `&p` to `g_variant_get_child`. Therefore the lockfile's version genuinely matches the advisory; this review does not dismiss a scanner false positive.

## Dependency and upgrade assessment

The Linux inverse graph produced by Cargo includes these direct paths:

- `motion-desktop 0.1.0 → tauri 2.11.5 → gtk 0.18.2 → glib 0.18.5`.
- `tauri 2.11.5 → tauri-runtime-wry 2.11.4 → wry 0.55.1 → webkit2gtk 2.0.2 → glib 0.18.5`.
- The same GTK generation also appears through `tauri-runtime 2.11.3`, `tao 0.35.3`, and `muda 0.19.3`; GLib-related wrappers include `gio 0.18.4`, `gdk 0.18.2`, `cairo-rs 0.18.5`, `pango 0.18.3`, and `soup3 0.5.0`.

The resolved manifests require GTK/glib's `0.18` generation. `glib 0.20` is outside those Cargo version requirements; adding a direct newer glib dependency would not replace the affected transitive version. A compatible fix therefore requires a runtime-stack migration or a separately reviewed backport, rather than a lockfile-only glib update.

As an additional upstream check, the [Tauri development manifest](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/Cargo.toml), displaying version `2.12.7` when retrieved, still specifies Linux `gtk = "0.18"` and `webkit2gtk = "2"`. That is evidence that the inspected current upstream branch has not removed this constraint. It is not a claim that every possible downstream fork or future release was evaluated. No dependency-upgrade experiment or patched fork was applied to Motion.

## Call-site evidence

Cargo metadata was resolved independently for each target. Starting at `resolve.root`, every node reachable through `resolve.nodes[].deps[].pkg` was visited. The source directories of those registry packages were then searched with ripgrep, explicitly disabling ignore rules and including hidden files, for `VariantStrIter|array_iter_str` in every `.rs` file.

| Target | Reachable packages including Motion | Registry packages inspected | Rust source files inspected | Matches outside glib |
| --- | ---: | ---: | ---: | ---: |
| Linux x64 | 302 | 301 | 8,223 | 0 |
| Windows x64 MSVC | 251 | 250 | 6,864 | 0 |

Linux produced 17 matching lines, all in `glib 0.18.5`:

- `src/lib.rs` reexports the iterator type.
- `src/variant.rs` imports the type, defines `Variant::array_iter_str`, constructs `VariantStrIter::new(self)`, and contains a rustdoc example plus two test references.
- `src/variant_iter.rs` defines the type and its iterator implementations, and contains four iterator uses inside its `#[cfg(test)]` module.

The iterator's fields are private. Its `new` constructor is `pub(crate)` and the production construction point found in the complete crate source is `Variant::array_iter_str`. No Motion, Tauri, Wry, GTK, WebKitGTK, or other resolved production crate source calls that method or constructs/references this iterator. A separate recursive search of Motion's `apps`, `packages`, and `spikes` Rust sources returned no matches.

The glib test and rustdoc uses are real call sites and should not be described as nonexistent. Dependency unit tests and rustdoc examples are not part of Motion's production application. The defensible statement is that no production caller was found outside the affected crate, with the construction path inspected inside it.

## Windows target exposure

`cargo tree --locked --offline --target x86_64-pc-windows-msvc --invert glib` succeeded with “nothing to print.” The independently traversed Windows metadata graph contains Tauri/Wry and their Windows backends, but no `glib`, `gtk`, `gio`, or `webkit2gtk` package. Consequently this specific affected Rust implementation is not a dependency of the reviewed Windows target.

The shared cross-platform lockfile still includes glib for Linux. A lockfile scanner can therefore continue to report the advisory during a Windows delivery effort. Target non-exposure does not itself remove the repository's existing expiry gate, and this review does not change scanner scope or thresholds.

## Limits and bounded disposition

This is a source-and-resolution review, not a formal reachability proof, binary instrumentation run, or exploit test. It does not cover future feature changes, generated code that could introduce a new constructor use, new plugins, different targets, a different resolved graph, or unrelated GTK/native-library vulnerabilities. Offline operation alone is not the reason for the conclusion: local input can still be untrusted.

If an authorized maintainer decides to renew the exception, the technical evidence supports only a short review interval, no more than 30 days from this review, restricted to this advisory and the reviewed `glib 0.18.5` dependency graph. The rationale should cite the absence of an observed production construction path and the incompatible GTK generation, while retaining a concrete removal condition: upgrade to a compatible runtime that no longer resolves affected glib, or adopt and verify an explicitly reviewed backport. Re-run the source/target checks whenever the relevant dependency graph or feature selection changes, and immediately if a caller of `array_iter_str` or `VariantStrIter` is added.

Until such an authorized decision is made, the expired policy record remains a release blocker. This document is evidence for review, not a human approval record.

## Candidate change prepared after review

The Windows continuation branch proposes a 30-day renewal ending **25 December
2026**, using this review as its technical evidence and retaining the existing
advisory scope, severity thresholds, scanner output and removal requirement.
Jacob's current instruction authorizes continuing the implementation and fixing
release blockers. This draft change does not assert that a human security owner
has approved it: the exact policy diff remains subject to the repository's
CODEOWNERS review before merge or release. The dependency-governance record binds
the proposed bytes and names the responsible review role; it is not a signature
or a substitute for that review. No vulnerable code is represented as patched.

## Reproduction commands

From the repository root, with the reviewed Cargo toolchain available:

```sh
cargo fetch --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
cargo tree --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --target x86_64-unknown-linux-gnu --invert glib
cargo tree --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --target x86_64-pc-windows-msvc --invert glib
cargo metadata --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --format-version 1 --filter-platform x86_64-unknown-linux-gnu
cargo metadata --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --format-version 1 --filter-platform x86_64-pc-windows-msvc
rg -n --glob '*.rs' 'VariantStrIter|array_iter_str' apps packages spikes
```

For each metadata result, traverse from `resolve.root` through each node's `deps[].pkg`, select reached registry packages, and pass their manifest parent directories to:

```sh
rg --no-ignore --hidden -n --glob '*.rs' 'VariantStrIter|array_iter_str' <resolved-registry-source-directories>
```
