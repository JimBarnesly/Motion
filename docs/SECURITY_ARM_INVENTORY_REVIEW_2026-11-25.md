# ARM64 validation image inventory review — 2026-11-25

## Decision and scope

The isolated ARM64 validation image rejected five updated Debian binary package
versions. The changes are security updates from three existing source packages;
there are no added or removed package names. This review supports changing only
`image.packageInventorySha256` in `tooling/rust-tauri/policy.json` from
`b0688c9fd001227bf2f166933af39adadd24e677be964a08e332cff06dcc349b` to
`ae8424483f12f431dacc6b7d44cf0bd596a6b4481cd3d86e9c2f3cad20fd6ba2`.

The conclusion comes from reproducing the previous digest, authenticating
Debian package metadata, and reviewing the exact update advisories. It does not
come from accepting an unexplained new hash. This is an AI engineering review,
not an independent human security approval or release acceptance.

The complete observed 677-record inventory, five-record delta, package archive
checksums, metadata signatures, and unchanged pins are retained in
[ARM_INVENTORY_EVIDENCE_2026-11-25.json](ARM_INVENTORY_EVIDENCE_2026-11-25.json).

## Observed failure

[CI run 45594915283, ARM job 139138324966](https://github.com/JimBarnesly/Motion/actions/runs/45594915283/job/139138324966)
built candidate `0f91da4b3439b2b4a51bf43b7d4dd15ef5ab882b` through PR merge
commit `092258fa2f56390a5c53bf04ce886d9cacbb5257`. The validation image ID was
`sha256:710652c099dd6a8be56366f5c2594a66dda7e2bc8e71f2f514fdd6a91bec0b31`.

The confined `/usr/bin/dpkg-query` command exited with status zero, no signal,
and no execution error. All 677 records passed the bounded package/version
parser. The reported reason was `inventory-hash-mismatch`. The image build's
APT output reported zero upgrades, 264 new packages, and zero removals; the
remaining 413 records came from the unchanged digest-pinned Node base image.

[Diagnostic artifact 15012099238](https://github.com/JimBarnesly/Motion/actions/runs/45594915283/artifacts/15012099238)
contained `validation.json.diagnostic.json`. Its downloaded ZIP SHA-256 matched
the upload log:
`9ad96de062a7dc427016aa7d51f7eb034a7f7b8e06d341ae5a4f95719f2a49cb`.
Recomputing SHA-256 from the sorted records, each followed by a single LF,
independently reproduced the reported new inventory digest.

## Exact package delta

| Binary package | Previous version | Observed version | Debian security release |
| --- | --- | --- | --- |
| `gstreamer1.0-plugins-base` | `1.22.0-3+deb12u6` | `1.22.0-3+deb12u7` | DLA-4828-1 |
| `libgstreamer-plugins-base1.0-0` | `1.22.0-3+deb12u6` | `1.22.0-3+deb12u7` | DLA-4828-1 |
| `libgstreamer-gl1.0-0` | `1.22.0-3+deb12u6` | `1.22.0-3+deb12u7` | DLA-4828-1 |
| `gstreamer1.0-plugins-good` | `1.22.0-5+deb12u3` | `1.22.0-5+deb12u4` | DLA-4837-1 |
| `xdg-dbus-proxy` | `0.1.4-3+deb12u1` | `0.1.4-3+deb12u2` | DLA-4856-1 |

Debian's [DLA-4828-1, 8 October 2026](https://lists.debian.org/debian-lts-announce/2026/10/msg00021.html)
identifies the base-plugin update as fixes for CVE-2026-18297 and
CVE-2026-85150, affecting media parsing and RTSP handling.

[DLA-4837-1, 15 October 2026](https://lists.debian.org/debian-lts-announce/2026/10/msg00031.html)
identifies the good-plugin update as fixes for 13 vulnerabilities in processing
media files or RTP streams, including memory safety and information disclosure
issues.

[DLA-4856-1, 23 October 2026](https://lists.debian.org/debian-lts-announce/2026/10/msg00050.html)
identifies the proxy update as the fix for CVE-2026-94422, a D-Bus message
filtering bypass. All five changed binaries were fetched from
`deb.debian.org/debian-security` in the observed CI image build.

## Authentication and reconstruction

1. The old digest was introduced in commit `563f2fd` and remained unchanged in
   the successful [16 August run 31924031479](https://github.com/JimBarnesly/Motion/actions/runs/31924031479).
   That historical job's downloadable logs had expired (HTTP 410), and its
   artifact collection was empty. No historical package list was assumed to
   exist.
2. The review downloaded `InRelease` and `main/binary-arm64/Packages.xz` for
   `bookworm`, `bookworm-updates`, and `bookworm-security` from the official
   [Debian snapshot archive at 20260816T000000Z](https://snapshot.debian.org/archive/debian/20260816T000000Z/).
   The security suite used the corresponding `debian-security` archive.
   [Debian documents](https://snapshot.debian.org/) that a requested timestamp
   resolves to the last available snapshot preceding it.
3. GnuPG, with automatic key retrieval disabled, verified all three historical
   `InRelease` signatures using the already-installed Debian archive keyring.
   Each compressed package index's byte count and SHA-256 matched its signed
   release. The same verification succeeded for all three current indexes
   downloaded independently from `deb.debian.org` on 25 November. The evidence
   file records release timestamps, source URLs, hashes, and valid signing-key
   fingerprints for both sets.
4. All 264 package/version pairs actually downloaded by CI were present in the
   authenticated current metadata. Substituting the historical candidates for
   those same package names changed exactly the five records above. All 672
   other records remained byte-for-byte identical.
5. Hashing that reconstructed 677-record historical list reproduced the prior
   pinned digest **exactly**. Thus the old digest itself authenticates the
   reconstruction, rather than relying on an unverified assumption about
   historical dependency resolution.

The reproduction is also available directly from the committed evidence:

```sh
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const evidence = JSON.parse(readFileSync("docs/ARM_INVENTORY_EVIDENCE_2026-11-25.json", "utf8"));
const digest = lines => createHash("sha256")
  .update([...lines].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join("\n") + "\n")
  .digest("hex");
const previous = new Map(evidence.changes.map(change => [change.package, change.previousVersion]));
const reconstructed = evidence.packages.map(line => {
  const name = line.slice(0, line.indexOf("="));
  return previous.has(name) ? `${name}=${previous.get(name)}` : line;
});
assert.equal(evidence.packages.length, 677);
assert.equal(previous.size, 5);
assert.equal(digest(evidence.packages), evidence.inventory.observedSha256);
assert.equal(digest(reconstructed), evidence.inventory.previousSha256);
console.log("Both inventories reproduced; exactly five versions changed.");
JS
```

## Preserved controls and remaining limits

The nine direct Debian version pins, both base image digests, Node/Rust version
requirements, Rust/Cargo executable hashes, lockfile digests, rootless UID,
read-only root, capability restrictions, network prohibition, and candidate
fingerprint checks remain unchanged by this update. The full inventory equality
check still rejects any further package drift. Governance control paths and
`dependency-policy-change.json` were not edited.

This evidence concerns the validation image's package names, versions, and
provenance. It is not a full filesystem attestation or a complete OS
vulnerability assessment. Debian's
[base-plugin tracker](https://security-tracker.debian.org/tracker/source-package/gst-plugins-base1.0)
and [good-plugin tracker](https://security-tracker.debian.org/tracker/source-package/gst-plugins-good1.0)
still list other open Bookworm issues, including CVE-2026-125040 and
CVE-2026-125041 respectively. This inventory change neither suppresses those
issues nor claims that they are unreachable.

The observed ARM job stopped before the isolated compile/test stage. Updating
the reviewed digest permits that stage to run; only a new CI result can establish
that the later gates pass. No local Docker runtime was available for a new ARM
execution, and no installed-package or Windows acceptance is claimed here.
