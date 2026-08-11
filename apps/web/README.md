# Motion web vertical slice

A dependency-free local-first UI slice. From the repository root:

```sh
npm run dev
```

The UI uses an explicit asynchronous storage boundary. In Tauri, canonical edits are typed, revisioned `app_dispatch` commands and only confirmed command responses replace the local snapshot. `motion_ui_save` stores schema-v2 UI selection state only; whole-workspace native save fails closed. Web-v1 enters native storage solely through the explicit privileged `web-v1-import` migration lane. When run directly in a browser, the separate browser-development adapter retains IndexedDB snapshot compatibility and does not claim to exercise native SQLite persistence.

The sidebar provides versioned JSON export and restore. All loaded and restored schema-v1 data is strictly normalised before rendering, including stable-ID validation, duplicate detection and page-hierarchy cycle checks. The UI deliberately starts empty and creates only user-entered content.

Native mode also exposes content-addressed attachment ingestion and verified backup/preview/restore through the typed `app_dispatch` boundary. These controls are disabled in browser development mode rather than simulated.
