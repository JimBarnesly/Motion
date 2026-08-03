# Motion web vertical slice

A dependency-free local-first UI slice. From the repository root:

```sh
npm run dev
```

The UI uses an explicit asynchronous storage boundary. In Tauri it calls the versioned `motion_ui_load` and `motion_ui_save` IPC commands so the native application can own durable persistence. When run directly in a browser, it uses IndexedDB and clearly identifies itself as **browser development mode**; this fallback does not claim to exercise the native SQLite application service.

The sidebar provides versioned JSON export and restore. All loaded and restored schema-v1 data is strictly normalised before rendering, including stable-ID validation, duplicate detection and page-hierarchy cycle checks. The UI deliberately starts empty and creates only user-entered content.

Native mode also exposes content-addressed attachment ingestion and verified backup/preview/restore through the typed `app_dispatch` boundary. These controls are disabled in browser development mode rather than simulated.
