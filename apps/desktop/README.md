# Motion desktop shell

This package defines the Tauri 2 boundary for the canonical Motion application service. The UI can only call the allowlisted `motion_ui_load`, `motion_ui_save`, and typed `app_dispatch` commands; it has no SQL or arbitrary filesystem API.

## Current packaging gate

The application-service bundle currently runs in an external Node 24 process. Node is **not yet bundled**, so this shell is not a self-contained production package and must not be described as one. Development requires `node` on `PATH` (or `MOTION_NODE_BINARY`). Each IPC request currently starts a process; replace this with a bundled persistent runtime or a measured Rust-owned implementation before the desktop milestone is accepted.

Linux compilation also requires the Tauri GTK/WebKit development libraries described by the root development documentation.
