# Motion Linux release

Motion 0.1.0 is distributed as architecture-specific AppImage and Debian
packages. Release files and their `SHA256SUMS` file are staged in
`artifacts/release/`. That directory is ignored by Git because release binaries
are build outputs; CI and GitHub Releases are the durable distribution path.

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
the Debian package with `sudo apt remove motion-desktop`; user workspace data is
retained so uninstalling the program does not silently delete it.

## Verify a downloaded artifact

From the repository root:

```sh
cd artifacts/release
sha256sum --check SHA256SUMS
```

The CI package gate extracts each AppImage and uses only the bundled runtime and
service code to save a workspace with networking denied, terminate the service,
restart it, and reload the same content from SQLite.

## First release scope

This release provides local persistent workspaces, nested page creation and
organisation, typed block editing, table pages, full-text search, links and
backlinks, reversible trash, attachments, JSON export/restore, and verified
native backup/restore. It requires no account or cloud service. Sync,
collaboration, encryption, AI, and MCP integrations are not part of this release.
