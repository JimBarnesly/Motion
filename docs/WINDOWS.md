# Windows desktop development and installer

The Windows native port and offline installer are active candidates on
`feat/windows-notebook-resume`. The implementation preserves Motion's existing
canonical service, SQLite data model and web interface. A configuration or local
cross-compile is not an installed-Windows pass: consult the **Windows installer**
CI run and `docs/DELIVERY_STATE.json` for the candidate's actual evidence.

The installer includes Node and the offline WebView2 installer. The installed
notebook does not require Git, Node, npm, Rust, WSL, Docker, an account or a
database server. These are development tools only.

## Run the local notebook

Install Git for Windows and Node.js 24.x with npm. Use a regular PowerShell
terminal; administrator access, WSL, Docker, Rust, and a database server are not
required for browser development.

From a checkout of the development branch:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run dev
```

Open <http://127.0.0.1:4173> in Edge or Chrome. Keep the terminal running while
using Motion; press `Ctrl+C` in that terminal to stop it. On subsequent launches,
run `npm.cmd run dev` from the same checkout. The `.cmd` suffix selects npm's
Windows command launcher without requiring a PowerShell execution-policy change.

The first dependency installation requires network access unless the npm cache
is already populated. Once installed, Motion serves its application assets on
loopback and does not require an account or internet access to run.

Use **Add page** to create a document, **New table** for structured records, and
`Ctrl+K` to search. The status area identifies **Browser development mode**.

### Where this mode saves data

The browser adapter saves the versioned workspace in IndexedDB, associated with
the browser profile and the exact origin. Reopen the same browser profile at
`http://127.0.0.1:4173` to return to that workspace. A different port, browser
profile, or `localhost` address has separate browser storage.

Use **Workspace tools → Export JSON** to save a portable copy before clearing
site data or changing profiles. **Restore** imports that JSON into the browser
workspace after a replacement confirmation. Private browsing and deleting site
data can remove the browser copy.

Browser development does not exercise native SQLite persistence. Attachments
and verified native backup/restore are disabled in this mode. These are existing
adapter boundaries, not a Windows desktop installation.

## Browser checks on Windows

Run these from the repository root:

```powershell
npm.cmd run build --workspace @motion/web
npm.cmd run test --workspace @motion/web
node scripts/check-offline-assets.mjs
npx.cmd playwright install chromium
npm.cmd run test:e2e
```

Playwright's browser installation is a one-time download. The tests launch their
own loopback server on port `4187`; the server's environment is configured in
`playwright.config.ts` without Unix shell syntax. Tests use isolated browser
contexts and do not use the regular notebook's port or browser profile.

The desktop, attachment, and complete repository test suites include Linux
filesystem and process guarantees. Browser test success does not establish
Windows native support. Windows execution of these commands remains a validation
step; verification performed on a Linux development host must be reported as
Linux evidence.

## Native implementation and validation

| Boundary | Candidate implementation | Required observed evidence |
| --- | --- | --- |
| Native files | `src-tauri/src/windows_platform` uses Windows handles, private ACLs, identity checks and reparse rejection | Actual Windows hostile-path, mapped-drive, identity and ACL tests |
| Single writer | Native root guardian and process-lifetime handles; SQLite database and sidecars retained through the service lifetime | Competing writers, blocked-runner guardian death, crash release, root replacement rejection |
| Attachments | Existing content-addressed service delegates Windows filesystem operations to the same installed Motion executable | Verified stage/publish/read, deduplication, hard-link rejection and interrupted promotion recovery |
| Backups | Bounded native helper authenticates identity and content before confirmed replacement, flushes and reads back temporary data | No-replace collisions, cancellation, held-handle replacement, private ACL and restore tests |
| Runtime | Official Node `24.18.0` ZIP archives pinned independently for x64/ARM64; exact executable and licence extracted only after SHA-256 verification | Runtime preparation and installed executable/version checks; ARM64 installer is not yet qualified |
| Installer | Windows Tauri override selects per-user NSIS, a Motion icon, local runtime resources and offline WebView2 installation | Build, install, resource verification, normal launch/close, uninstall with data preserved and reinstall |
| Offline behavior | No hosted services; CI blocks installed app, Node and WebView2 outbound traffic before launch | Installed page/attachment/search/restart and reinstall flows; CDP reports only requests observed after connection |

The workflow runs on a disposable **Windows Server 2022 x64** GitHub runner.
That is actual Windows behavior, but it does not establish testing on every
Windows 11 laptop configuration. The existing runner normally has WebView2;
passing that install does not alone prove the missing-WebView2 scenario. The
configuration embeds the offline installer and that scenario remains an explicit
release acceptance item until exercised on a clean Windows image.

### Build the native candidate

Tauri's [Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows)
include Microsoft C++ Build Tools with the desktop C++ workload and Rust using
the MSVC toolchain. Use the repository's locked dependencies and the CI-pinned
Rust `1.97.1` and Node `24.18.0` versions for candidate reproduction.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd run runtime:prepare --workspace @motion/desktop
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
$env:MOTION_NATIVE_HELPER = (Resolve-Path apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/motion-desktop.exe).Path
node --test apps/desktop/test/windows/*.test.mjs packages/storage/dist/test/windows/*.test.js
npm.cmd run tauri:build --workspace @motion/desktop -- --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

The generated setup is under
`apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`.
Building requires downloads on an unprimed development machine; normal installed
use is local. Tauri documents the per-user NSIS and `offlineInstaller` options in
its [Windows installer guide](https://v2.tauri.app/distribute/windows-installer/).

### Installed acceptance evidence

The Windows workflow runs `scripts/windows-installed-acceptance.ps1` only on a
disposable CI profile. It installs the actual NSIS output into a path containing
spaces, verifies bundled resources and the pinned Node version, applies outbound
firewall blocks, then tests installed native operations and the actual WebView.
The UI creates a notebook and attachment, closes normally, relaunches and searches.
The acceptance script then verifies uninstall preserves every notebook file and
reinstallation can reopen the same notebook.

The candidate artifact contains the setup, its SHA-256 and any produced evidence.
Artifacts are uploaded on failure too, for diagnosis: the presence of an artifact
is not acceptance. A passing `acceptance.json`, successful workflow status and
matching source commit are all required. Unsigned development candidates are not
represented as an approved 1.0 release.

Local application data is stored under `%LOCALAPPDATA%\app.motion.desktop`.
Verified backups are written only to a location explicitly selected by the user.
Normal uninstallation preserves notebook data; selecting an explicit application
data deletion option is destructive and is outside that preservation claim.
