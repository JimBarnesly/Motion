# Motion 0.1.0 deployment and rollback runbook

Owner: Operations & Security Director  
Applies to: ARM64 Linux AppImage and Debian packages  
Release status: public release approval is withheld; see `QUALITY_RELEASE_STATUS.md`

## Safety and data location

Close Motion before installation, upgrade, rollback, or filesystem backup. Do
not run two Motion versions against the same data directory.

On a standard Linux desktop, Tauri stores Motion data at:

```sh
MOTION_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/app.motion.desktop"
```

The directory contains `motion.sqlite3`, `ui-state.json`, and `attachments/`.
Treat it and any diagnostic archive as private workspace content. Motion 0.1.0
does not encrypt this directory.

## 1. Select and verify the artefact

These commands are non-destructive and were validated on ARM64 against the
staged 0.1.0 artefacts:

```sh
uname -m
cd artifacts/release
sha256sum --check SHA256SUMS
file Motion_0.1.0_aarch64.AppImage Motion_0.1.0_arm64.deb
dpkg-deb --info Motion_0.1.0_arm64.deb
dpkg-deb --contents Motion_0.1.0_arm64.deb
```

Expected results:

- `uname -m` prints `aarch64`;
- both checksum lines report `OK`;
- the AppImage reports `ARM aarch64` and the Debian package reports `arm64`;
- Debian metadata reports package `motion`, version `0.1.0`, architecture
  `arm64`, and dependencies on GTK 3 and WebKitGTK 4.1.

Stop if the architecture or any checksum differs. Obtain the checksum file over
the trusted release channel; a checksum downloaded from the same compromised
location as a package is not independent authentication. The 0.1.0 checksums
are not signed.

Optional dependency preview for the Debian package, also validated on ARM64:

```sh
apt-get -s install "$(pwd)/Motion_0.1.0_arm64.deb"
```

This simulation does not install anything. Review the proposed packages before
the real installation.

## 2. Create a cold rollback copy

If Motion has already created data, close it and make a copy before upgrading:

```sh
MOTION_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/app.motion.desktop"
MOTION_BACKUP_DIR="$HOME/motion-rollback-$(date +%Y%m%d-%H%M%S)"
test -d "$MOTION_DATA_DIR"
cp --archive --reflink=auto -- "$MOTION_DATA_DIR" "$MOTION_BACKUP_DIR"
test -f "$MOTION_BACKUP_DIR/motion.sqlite3"
```

Store the rollback copy on a protected filesystem with access limited to the
user. This procedure copies application data; it does not replace Motion's
verified in-application workspace backup/restore flow.

## 3A. AppImage installation and launch

The AppImage is versioned and does not require root installation:

```sh
chmod 0755 Motion_0.1.0_aarch64.AppImage
./Motion_0.1.0_aarch64.AppImage
```

**Requires a graphical ARM64 Linux host:** launching the AppImage and checking
window creation, create/edit/search, attachment handling, shutdown, restart,
and restored workspace state. The staged AppImage was successfully extracted
without FUSE and its bundled Node runtime reported `v24.18.0`; graphical launch
was not performed on the shared operations host.

If FUSE is unavailable, AppImage extraction is a diagnostic option, not the
supported installation path:

```sh
mkdir motion-appimage-inspect
cd motion-appimage-inspect
../Motion_0.1.0_aarch64.AppImage --appimage-extract
```

## 3B. Debian installation and launch

From the directory containing the verified package:

```sh
sudo apt install ./Motion_0.1.0_arm64.deb
dpkg-query --show --showformat='${Package} ${Version} ${Architecture}\n' motion
motion-desktop
```

Installation changes the host and requires administrator approval. The
dependency simulation and package extraction were validated; actual package
installation was not performed on the shared operations host.

**Requires a graphical ARM64 Linux host:** launching `motion-desktop` and the
same installed-workflow checks listed for the AppImage.

## 4. Upgrade

Before either upgrade, close Motion, verify the new artefact and checksum, make
a cold rollback copy, and retain the previous verified package.

For AppImage, place the new version beside the old version and launch it by its
versioned filename. Do not overwrite the previous AppImage until acceptance
checks pass:

```sh
chmod 0755 Motion_NEW_aarch64.AppImage
./Motion_NEW_aarch64.AppImage
```

For Debian, preview and then install the new local package:

```sh
apt-get -s install "$(pwd)/Motion_NEW_arm64.deb"
sudo apt install ./Motion_NEW_arm64.deb
dpkg-query --show --showformat='${Package} ${Version} ${Architecture}\n' motion
```

**Requires a graphical ARM64 Linux host:** first launch after upgrade and data
migration, create/edit/search, forced close, restart, export, and restore into a
new workspace. Do not accept the upgrade until those checks pass.

## 5. Rollback

Close Motion first. Application rollback does not automatically roll back data.
Try the retained previous application against the current data only when that
version explicitly supports the current schema.

For AppImage, launch the retained verified version:

```sh
./Motion_PREVIOUS_aarch64.AppImage
```

For Debian, verify the retained package, simulate the downgrade, then install
it explicitly:

```sh
sha256sum --check SHA256SUMS_PREVIOUS
apt-get -s install "$(pwd)/Motion_PREVIOUS_arm64.deb"
sudo apt install --allow-downgrades ./Motion_PREVIOUS_arm64.deb
dpkg-query --show --showformat='${Package} ${Version} ${Architecture}\n' motion
```

If the prior version cannot open the current data schema, preserve the failed
state and restore the cold copy without deleting either copy:

```sh
MOTION_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/app.motion.desktop"
MOTION_FAILED_DIR="${MOTION_DATA_DIR}.failed-$(date +%Y%m%d-%H%M%S)"
mv -- "$MOTION_DATA_DIR" "$MOTION_FAILED_DIR"
cp --archive --reflink=auto -- "$MOTION_BACKUP_DIR" "$MOTION_DATA_DIR"
```

Rollback requires a retained older artefact and matching checksum. Only 0.1.0
is staged, so a cross-version rollback could not be exercised. **A graphical
ARM64 host is required** to accept the restored application and workspace.

## 6. Log and diagnostic collection

Motion does not currently write a dedicated application log file. The packaged
service inherits the launching process's standard error. Reproduce from a
terminal and capture only the failing session:

```sh
./Motion_0.1.0_aarch64.AppImage 2>motion-appimage-stderr.log
# or
motion-desktop 2>motion-debian-stderr.log
```

Collect environment and package facts without workspace bodies or attachment
names:

```sh
uname -a >motion-system.txt
printf 'XDG_SESSION_TYPE=%s\n' "${XDG_SESSION_TYPE:-unknown}" >>motion-system.txt
dpkg-query --show --showformat='${Package} ${Version} ${Architecture}\n' motion \
  >motion-package.txt 2>&1
du -sh -- "$MOTION_DATA_DIR" >motion-data-size.txt 2>&1
```

Before sharing diagnostics, inspect them and redact usernames, paths, page
content, filenames, tokens, and credentials. Do not bundle `motion.sqlite3`,
`attachments/`, `ui-state.json`, or a cold rollback copy into a support archive
unless the user explicitly approves disclosure through a trusted channel.

**Requires a graphical ARM64 host:** reproducing a UI failure and capturing its
terminal standard error.

## 7. Uninstall

For AppImage, close Motion and remove only the verified AppImage file or move it
to the desktop trash. No package-manager state was installed.

For Debian:

```sh
sudo apt remove motion
```

Both methods intentionally retain the Motion data directory. Confirm the cold
backup first, then remove the data directory separately only when permanent
workspace deletion is explicitly intended. That deletion is not part of this
runbook.

## 8. Acceptance record

Record the host architecture, OS version, artefact filename and SHA-256, install
method, installed version, data-copy location, acceptance actions, and rollback
artefact. Public release remains blocked until Quality & Release records the
full packaged ARM64 graphical acceptance evidence.
