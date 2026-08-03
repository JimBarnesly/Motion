# Motion web vertical slice

A dependency-free local-first UI slice. From the repository root:

```sh
npm run dev
```

The workspace is persisted as versioned JSON in browser `localStorage` under `motion.workspace.v1`. The sidebar provides versioned JSON export and restore. The `workspaceStore` object in `app.js` is the adapter boundary for a future SQLite/CRDT-backed repository. The UI deliberately starts empty and creates only user-entered content.
