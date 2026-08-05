# Motion desktop shell

This package defines the Tauri 2 boundary for the canonical Motion application service. The UI can only call the allowlisted `motion_ui_load`, `motion_ui_save`, and typed `app_dispatch` commands; it has no SQL or arbitrary filesystem API.

## IPC capability map

| Native command | UI caller | Validated boundary |
| --- | --- | --- |
| `motion_ui_load` | `app-adapter.js` `load()` | Closed request object; schema version 1 only |
| `motion_ui_save` | `app-adapter.js` `save()` | Closed request object; schema version 1; workspace normalization plus 16 MiB envelope limit |
| `app_dispatch` | `app-adapter.js` search, export, attachment-write, backup and restore methods | Protocol version 1; fixed lane-to-operation allowlist; closed top-level fields; app-service domain validation |

Attachments cross IPC only as a checked byte envelope and are stored beneath the
application-owned local data directory by content hash. Backups and restores
cross as structured bundle data, never caller-selected filesystem paths. Browser
downloads use an in-memory Blob and do not grant native file access.

Trusted desktop code can use `backup-file.mjs` after obtaining a destination
through a native user-selection flow. It writes a canonical verified bundle to
an owner-private exclusive temporary file, flushes it, verifies the persisted
bytes, and atomically publishes it with a same-filesystem no-replace link. Its
lock records PID, process-start identity, timestamp, nonce, and the owned
temporary's exact name, device, and inode. Recovery authenticates the private
regular lock and temporary together—including UID, mode and link count—before
removing either. Missing, malformed, mismatched, or symbolic evidence remains
untouched for manual inspection. This helper is
not exposed to WebView IPC, so browser-controlled downloads retain their normal
ownership and overwrite semantics.

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
