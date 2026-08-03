# Motion desktop shell

This package defines the Tauri 2 boundary for the canonical Motion application service. The UI can only call the allowlisted `motion_ui_load`, `motion_ui_save`, and typed `app_dispatch` commands; it has no SQL or arbitrary filesystem API.

## Bundled runtime

The application-service bundle runs in one persistent Node process managed by Tauri. Linux packages include the official Node.js 24.18.0 executable and its licence for their native architecture; packaged resolution always prefers it. The runtime is downloaded only during build preparation from `nodejs.org` and must match the embedded official SHA-256. Installed applications perform no runtime download.

Run `npm run runtime:prepare --workspace @motion/desktop` before packaging. For offline builds, preseed `node-v24.18.0-linux-x64.tar.xz` or `node-v24.18.0-linux-arm64.tar.xz` in `MOTION_NODE_RUNTIME_CACHE`, then set `MOTION_NODE_RUNTIME_OFFLINE=1`. Development without a prepared resource may use `MOTION_NODE_BINARY` or `node` on `PATH`.

Linux compilation also requires the Tauri GTK/WebKit development libraries described by the root development documentation.
