# Operations and security board review

Owner: Operations & Security Director  
Decision authority: Managing Director  
Reviewed: 2026-08-05

## Outcome

The board is effective at moving the local desktop baseline toward release, but
Motion has not yet met its own security acceptance gate. Feature-parity work may
continue; public release approval should remain withheld until the release
security checks below have evidence.

## Director effectiveness

| Director | Evidence reviewed | Assessment | Boundary / follow-up |
| --- | --- | --- | --- |
| Product | `FEATURE_PARITY.md` maps Notion capability areas to repository evidence and routes scope decisions to the Managing Director. | Effective: the parity target is explicit and prioritised. | Product owns capability scope and monthly competitor review; Operations does not reprioritise the register. |
| Engineering | Recent `main` commits added packaged-runtime restart testing, offline-host preservation, trash restore, icons, and architecture-specific release handling. | Effective on the release-critical local baseline. | Engineering owns implementation. Security findings below should become engineering tasks only after Managing Director approval. |
| Quality & Release | Native CI builds both Linux architectures and runs a packaged AppImage offline across restart; release artefact hashes are staged. | Effective but incomplete against the documented release gate. | Quality owns release evidence and must reject a release lacking the required security jobs. |
| Operations & Security | `SECURITY.md`, `THREAT_MODEL.md`, CI, release artefacts, and local security scripts were reviewed. | Security direction is sound; enforcement coverage is incomplete. | Operations owns gate definition and evidence review, not product scope, implementation, or release execution. |

## Security gate status

Verified on 2026-08-05:

- tracked-file secret scan passed across 174 files;
- offline asset scan passed with no remote asset or API URLs in application sources;
- staged ARM64 AppImage and Debian package hashes match `SHA256SUMS`;
- CI uses read-only repository permissions and pinned Node/Rust versions.

Open release blockers from `THREAT_MODEL.md`:

1. CI now has dependency-vulnerability, licence, and first-party static-analysis gates; hosted Clippy evidence remains required before this blocker is closed.
2. No hostile import/archive suite demonstrates traversal, active-content, malformed-data, and resource-exhaustion failures leave canonical data unchanged.
3. No automated evidence proves secrets and representative page content stay out of logs, crash output, and support bundles.
4. Encrypted-vault acceptance is not applicable to the 0.1.0 scope, but release wording must continue to state that application-level encryption is not shipped.
5. Release artefacts have checksums but no signed-release or provenance policy. This is a distribution-hardening decision, not a blocker for an explicitly internal preview.

## Release-gate decision

### Dependency vulnerability policy

CI scans the committed npm and Cargo lockfiles with npm CLI 11.6.2 and
`cargo-audit` 0.22.2. Production npm findings fail at **high** or **critical**
severity. Every RustSec vulnerability fails because RustSec advisories do not
provide a severity scale directly comparable with npm's in all cases. Scanner
errors and malformed reports fail closed. Raw scanner output is held only in
collector memory. CI retains mode-0600 atomic envelopes containing the exact
scanner identity, collector status, lockfile digest, and an allowlisted subset
of advisory, package, severity, and remediation fields; raw output is never
uploaded.

Temporary exceptions are stored only in `vulnerability-policy.json`. Each must
identify the ecosystem, advisory and owner; provide rationale, unreachable-code
evidence and a removal plan; and use an explicit ISO expiry date. Expired,
malformed, or duplicate exceptions fail CI. Unsound RustSec warnings are routed
through the same gate and exceptions do not suppress scanner output from the
machine-readable CI artifacts.

Local validation on 2026-08-05 recorded zero npm production vulnerability
packages and zero Cargo vulnerabilities against the committed lockfiles. The
Cargo report also retained 16 unmaintained warnings. The one unsound advisory,
RUSTSEC-2024-0429, is enforced through the time-limited exception policy after
source-graph inspection found no caller of the affected `VariantStrIter` path.

Motion 0.1.0 remains an **internal preview**. It must not be published or
described as a public release until blockers 1–3 have automated CI evidence and
Quality & Release records a passing run against the release commit. Internal
preview distribution must remain limited to controlled testers, be labelled as
unreleased software, and use the published checksums; it is not authority to
bypass the separate native-package acceptance gate.

The first public download requires both authenticated artefacts and build
provenance. The release workflow must:

1. publish a signed release manifest (a signed `SHA256SUMS` is sufficient) that
   binds every AppImage and Debian artefact to its digest, version, architecture,
   and release tag;
2. publish verifiable CI-generated provenance for every artefact, identifying
   the source repository, immutable commit, workflow, and build inputs; and
3. verify the signatures, digests, and provenance in the release gate before
   publication, with the user verification path documented in `RELEASE.md`.

A checksum hosted beside an unsigned binary is corruption detection, not
publisher authentication. Signing and provenance are therefore not deferred
for the first public download. The exact signing service or key custody design
is an Engineering and Quality implementation choice, provided verification does
not require a Motion account or compromise local-first operation.

Sync, collaboration, plugins, AI, MCP, and encryption remain outside 0.1.0;
each activates additional threat-model gates before implementation or release.

## Evidence required to lift this gate

- Dependency and licence checks cover both npm and Cargo lockfiles, have an
  explicit allowed-licence and vulnerability-triage policy, and fail CI on
  unaccepted findings. Static analysis covers TypeScript/JavaScript and Rust.
- Hostile import tests cover traversal (including absolute paths, links, and
  encoded variants), active HTML/SVG/script content, malformed structures, and
  bounded file/count/depth/expansion/resource failures. Every rejection must
  prove canonical workspace and attachment state is unchanged and staging data
  is cleaned up.
- Leakage tests inject unique canary secrets, page bodies, private filenames,
  raw queries, and attachment content through representative error paths, then
  assert their absence from default logs, serialised crashes, support-bundle
  previews, and generated support bundles. Existing unit redaction examples are
  useful but do not by themselves cover these end-to-end paths.
- Quality records the CI run, release commit, tool/policy versions, findings or
  accepted exceptions, artefact digests, signature verification, and provenance
  verification. Document-only claims do not close a blocker.

## Monitoring rule

Operations will review this gate whenever a new parser, network destination,
privileged desktop command, credential, updater, integration, or distribution
channel is introduced. Status changes require a command, test, CI run, or
artefact as evidence; document-only claims do not close a blocker.
