# Motion Linux release

Public release approval is currently withheld. See
[`QUALITY_RELEASE_STATUS.md`](QUALITY_RELEASE_STATUS.md) for the verified gates
and evidence still required. Deployment, upgrade, diagnostics, rollback, and
uninstall procedures are in
[`DEPLOYMENT_ROLLBACK_RUNBOOK.md`](DEPLOYMENT_ROLLBACK_RUNBOOK.md).

Motion 0.1.0 is distributed as architecture-specific AppImage and Debian
packages. Release files and their signed deterministic manifest are staged in
`artifacts/release/`. That directory is ignored by Git because release binaries
are build outputs. The manual **Release provenance** workflow builds both
architectures from one resolved 40-character commit. It uploads build outputs
for review but does not create or publish a GitHub Release.

After deterministic manifest generation, a read-only preflight job runs the
fixed local secret, unsafe-default, diagnostic-leakage, runtime-confinement,
backup-integrity, and release-manifest gates. A checksum-pinned cache restores
the Gitleaks 8.28.0 archive and executable; preflight verifies the archive or
approved executable hash, Linux architecture, and exact version before use.
The chain is offline after that controlled bundle is available, scans
non-ignored untracked source plus staged release files, and
writes only mode-`0600` status evidence without captured command output. Any
missing command or failing gate stops the verified unsigned bundle before it
enters the separate OIDC signing/attestation job. The manifest gate binds the
independently expected version, commit and repository to exactly four canonical
architecture/format names, sizes, and SHA-256 hashes.

## Install and launch

The AppImage is the least invasive option:

```sh
chmod +x artifacts/release/Motion_0.1.0_aarch64.AppImage
./artifacts/release/Motion_0.1.0_aarch64.AppImage
```

Use the artifact whose architecture suffix matches the target system.

Install the Debian package with its local dependencies:

```sh
sudo apt install ./artifacts/release/Motion_0.1.0_arm64.deb
motion-desktop
```

It can also be launched as **Motion** from the desktop application menu. Remove
the Debian package with `sudo apt remove motion`; user workspace data is
retained so uninstalling the program does not silently delete it.

## Verify a downloaded artifact

Install current `cosign` and GitHub CLI releases, authenticate `gh` for the
repository if it is private, then run from the repository root:

```sh
npm run verify:release -- \
  --directory artifacts/release \
  --version <expected-motion-version> \
  --commit <full-40-character-commit> \
  --repository <owner/repo> \
  --certificate-identity-regexp '^https://github.com/<owner>/<repo>/.github/workflows/release-provenance.yml@refs/(heads/main|tags/v[0-9].*)$'
```

The verifier requires an independently expected Motion version and commit, plus
exactly one AppImage and Debian package for `x86_64` and `aarch64`. It rejects
wrong-version, missing, additional, renamed, substituted, modified, or
wrong-commit packages before invoking trust tooling. It then verifies
`release-manifest.sigstore.json` with Sigstore's GitHub Actions OIDC issuer and
verifies every package against `release-provenance.jsonl` using `gh attestation`.

Trust assumptions: GitHub Actions ran the workflow file at an identity accepted
by the supplied certificate identity expression; GitHub's OIDC issuer and
Sigstore transparency infrastructure were not compromised; the expected commit
was obtained independently from the reviewed source/tag; and the local `cosign`
and `gh` executables are trusted. Do not broaden the identity expression to an
entire organisation or accept an unreviewed branch. No repository signing key
or long-lived signing secret is used.

The CI package gate extracts each AppImage and uses only the bundled runtime and
service code to save a workspace with networking denied, terminate the service,
restart it, and reload the same content from SQLite.

## First release scope

This release provides local persistent workspaces, nested page creation and
organisation, typed block editing, table pages, full-text search, links and
backlinks, reversible trash, attachments, JSON export/restore, and verified
native backup/restore. It requires no account or cloud service. Sync,
collaboration, encryption, AI, and MCP integrations are not part of this release.
