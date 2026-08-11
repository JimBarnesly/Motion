# Motion desktop shell

This package defines the Tauri 2 boundary for the canonical Motion application service. The UI can only call the allowlisted `motion_ui_load`, schema-v2 UI-state-only `motion_ui_save`, `motion_backup_save`, and typed `app_dispatch` commands; it has no SQL or arbitrary filesystem API. Canonical Web-v1 migration is confined to the explicitly privileged `web-v1-import` dispatch lane.

## IPC capability map

| Native command | UI caller | Validated boundary |
| --- | --- | --- |
| `motion_ui_load` | `app-adapter.js` `load()` | Closed request object; schema version 1 compatibility or canonical schema version 2 |
| `motion_ui_save` | `app-adapter.js` `saveUi()` | Closed request object; schema version 2 UI selection state only; schema-v1 whole-workspace save rejected |
| `motion_backup_save` | `app-adapter.js` `saveBackup()` | Closed request object; native-owned save dialog; no caller path; verified private target and explicit native replacement confirmation |
| `app_dispatch` | `app-adapter.js` typed edits, explicit `importWebV1`, search, export, attachment-write, backup and restore methods | Protocol version 1; fixed lane-to-operation allowlist; `web-v1-import` accepts only the import discriminator and document; closed top-level fields; app-service domain validation |

Attachments cross IPC only as a checked byte envelope and are stored beneath the
application-owned local data directory by content hash. Backups and restores
cross as structured bundle data, never caller-selected filesystem paths.

The dedicated native backup command uses `backup-file.mjs` after obtaining a
destination through its native save dialog. It writes a canonical verified bundle to
an owner-private exclusive temporary file, flushes it, verifies the persisted
bytes, and atomically publishes a new file with a same-filesystem no-replace
link. Replacement requires an owned, single-link, verified Motion backup plus
explicit confirmation, safely tightens an overly permissive owner-controlled
file to mode `0600`, and uses a same-directory atomic rename. Its
lock records PID, process-start identity, timestamp, nonce, and the owned
temporary's exact name, device, and inode. Recovery authenticates the private
regular lock and temporary together—including UID, mode and link count—before
removing either. Missing, malformed, mismatched, or symbolic evidence remains
untouched for manual inspection. The WebView cannot supply or receive the path
and has no generic filesystem or dialog command.

The `main-window` capability intentionally grants no Tauri plugins. Motion does
not include shell, filesystem, dialog, opener, or HTTP plugins and cannot open a
caller-supplied path, command, or URL. The CSP denies network connections,
frames, workers, forms, media, and object embedding; only packaged scripts,
styles, fonts, and images are allowed.

The native allowlist exposes only `workspace.list`, `workspace.search`,
`workspace.export`, `attachment.put`, `backup.create`, `backup.verify`,
`backup.preview`, and `backup.restore-new`. Other app-service domain operations
are deliberately unavailable to WebView IPC until a production UI caller and
boundary test require them.

## Bundled runtime

The application-service bundle runs in one persistent Node process managed by Tauri. Linux packages include the official Node.js 24.18.0 executable and its licence for their native architecture; packaged resolution always prefers it. The runtime is downloaded only during build preparation from `nodejs.org` and must match the embedded official SHA-256. Installed applications perform no runtime download.

Run `npm run runtime:prepare --workspace @motion/desktop` before packaging. For offline builds, preseed `node-v24.18.0-linux-x64.tar.xz` or `node-v24.18.0-linux-arm64.tar.xz` in `MOTION_NODE_RUNTIME_CACHE`, then set `MOTION_NODE_RUNTIME_OFFLINE=1`. Development without a prepared resource may use `MOTION_NODE_BINARY` or `node` on `PATH`.

Linux compilation also requires the Tauri GTK/WebKit development libraries described by the root development documentation.
