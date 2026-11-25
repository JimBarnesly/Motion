# Windows development

Motion's browser development application can run locally on Windows using the
existing web UI. The native desktop application currently targets Linux. Its
Windows port must retain the same structured workspace data, typed service
boundary, offline operation, and recovery guarantees.

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

## Native Windows port: remaining work

| Boundary | Current code | Required Windows work |
| --- | --- | --- |
| Native filesystem boundary | `apps/desktop/src-tauri/src/lib.rs` imports Unix metadata and open flags directly. | Implement equivalent Windows handle, ownership, and reparse-point validation behind a platform boundary. |
| Single writer | `apps/desktop/native-service-lock.mjs` explicitly requires Linux, `/usr/bin/flock`, and `/proc/self/fd`. | Provide a Windows lock that protects the same data root across competing processes and survives crashes and path replacement. |
| Attachment publication | `packages/storage/src/index.ts` publishes from an authenticated descriptor using Linux `/proc` and `ln`. | Preserve atomic publication, identity validation, and interruption recovery on Windows. |
| Verified backups | `apps/desktop/backup-file.mjs` uses Linux process-start identity, POSIX ownership/modes, and directory flushing. | Implement and verify Windows locking, ACL checks, atomic replacement, and durability. |
| Bundled runtime | `apps/desktop/scripts/prepare-node-runtime.mjs` has checksum-pinned Linux Node archives only. | Add an independently verified Windows x64 archive, extraction, executable naming, and native runtime selection. Preparation now rejects unsupported platforms before downloading or writing runtime files. |
| Installer | `apps/desktop/src-tauri/tauri.conf.json` produces `.deb` and AppImage bundles. | Add a Windows override, original `.ico` derivative, per-user installer, and offline WebView2 installation strategy. |
| Acceptance | Native CI runs on Linux x86-64 and ARM64. | Exercise Windows install, launch, editing, restart, concurrent process exclusion, attachment recovery, export/restore, and operation without networking. |

Do not bypass the Linux-only guards to get a Windows build to launch. The guards
protect data and must be replaced with equivalent platform implementations.

### Toolchain for the native port

Tauri's [Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows)
include Microsoft C++ Build Tools with the desktop C++ workload, the Microsoft
Edge WebView2 runtime, and Rust using the MSVC toolchain. The repository's native
CI currently pins Rust `1.97.1`. Installing these tools alone does not resolve
the implementation gaps above.

For the eventual installer, Tauri documents a per-user NSIS install and an
`offlineInstaller` WebView2 option in its
[Windows installer guide](https://v2.tauri.app/distribute/windows-installer/).
The default WebView2 bootstrapper requires a download; select and test the
offline option before claiming installation without network access.
