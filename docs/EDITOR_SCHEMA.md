# Editor Schema

Documents use a versioned ordered tree of blocks. Every block has a globally unique stable ID, type, parent/order information, typed content, metadata, creation/modification data, and deletion semantics. Unknown types retain their raw payload and render as an unsupported-block placeholder.

## Initial nodes

Paragraph; headings 1–3; bulleted and numbered items; task; toggle; quote; callout; divider; code; image; file; bookmark; child-page link; page mention; date mention; simple table; collection view; and unknown/imported placeholder. Inline marks include inline code and links.

References store target page/block IDs, never titles alone. Titles are presentation data. Link extraction updates a materialised index in the same durable mutation.

## Commands and serialisation

Commands cover insert, update, transform, duplicate, delete, move, indent/outdent, multi-selection, paste, Markdown copy, and undo/redo. Ordering must be deterministic. Persisted documents include `schemaVersion`; migrations are explicit and reversible where practical. Unknown fields are preserved.

The current core implements typed stable-ID blocks and deterministic JSON/Markdown export, but the browser editor is a lightweight vertical slice rather than the specified ProseMirror/Tiptap editor. Yjs representation and its relationship to canonical snapshots remain design work before collaboration.
