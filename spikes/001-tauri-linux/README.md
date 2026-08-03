# Tauri 2 Linux feasibility spike

## Verdict: PARTIAL

Question: Can this OpenClaw Linux host build, launch, and package a minimal Tauri 2 desktop application with Motion's intended web-UI/native-command boundary?

Evidence:

- Host: Debian-based Linux `aarch64`, kernel `6.18.34+rpt-rpi-2712`.
- `node --version`: `v24.18.0`; `npm --version`: `11.16.0`.
- `npm test`: two boundary tests pass.
- `npm run build:web`: produces the complete static frontend in `dist/` without fetching dependencies.
- `cargo --version`, `rustc --version`, and `rustup --version`: commands are unavailable.
- `pkg-config` cannot find `gtk+-3.0`, `webkit2gtk-4.1`, `javascriptcoregtk-4.1`, or `libsoup-3.0`.
- `npm run tauri:build`: fails immediately because `cargo` is unavailable.
- `npm_config_offline=true npm run tauri:build`: fails identically, proving the immediate blocker is the missing local toolchain rather than network access.

What worked: The tracked frontend builds offline, remains usable as a browser preview, and calls one explicit Tauri command (`runtime_label`) through a narrow injectable boundary. The Rust side defines and registers the matching command using the Tauri 2 API.

What failed or surprised us: This host is a Raspberry Pi-class `aarch64` Debian machine rather than an Ubuntu desktop build host. It has neither Rust nor the Linux WebView development libraries, so no honest native compile, launch, or `.deb` packaging result is possible without installing system prerequisites. No packages were installed and no sudo command was used.

Recommendation: Adjust the build environment before adopting Tauri 2 as validated. On an Ubuntu Linux desktop/CI runner, install the current Tauri 2 Linux prerequisites (Rust stable, GTK3, WebKitGTK 4.1, JavaScriptCoreGTK 4.1, libsoup 3, and standard build/package tools), then run the commands below and record a successful native launch and `.deb` artifact. Keep the web/native boundary demonstrated here; rewrite the spike normally when creating the production desktop app.

## Commands

```sh
cd Motion/spikes/001-tauri-linux
npm test
npm run build:web
npm run tauri:build
npm_config_offline=true npm run tauri:build
```
