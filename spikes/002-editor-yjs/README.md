# Editor + Yjs feasibility spike

## Verdict: VALIDATED

Question: Can a ProseMirror/Tiptap-compatible schema plus Yjs provide stable block IDs, several block types, save/reload, undo/redo, page links, and explicit schema versions without a paid hosted service?

Evidence: `npm test` exercises four block types, stable IDs, a page-link node, binary Yjs persistence, JSON/base64 reload, Yjs undo/redo, version rejection, and unknown-node preservation.

What worked:

- Stable IDs are node attributes, enforced at the application boundary, and survive Yjs encoding/reload.
- Heading, paragraph, task, and stable-ID page-link nodes round-trip exactly.
- Yjs updates persist locally as bytes and require no network service.
- `Y.UndoManager` supplies local undo/redo; y-prosemirror also provides editor plugins for browser integration.
- An outer versioned envelope makes schema compatibility explicit.
- Unknown future nodes can be losslessly wrapped in an `unsupported` placeholder before ProseMirror parsing.

What failed or surprised us:

- ProseMirror rejects an unknown node type by default. Preservation requires a decode/import compatibility layer; it is not automatic.
- ProseMirror requires nodes in a required content position to be generatable. Block ID attributes therefore need nullable schema defaults plus application-boundary validation, rather than schema-level required attributes.
- This headless spike validates model and persistence behavior, not browser selection, IME, clipboard, keyboard, or drag-and-drop behavior.
- Schema migrations still need explicit, fixture-tested transforms before documents are handed to ProseMirror.

Recommendation: use Tiptap as the browser-facing convenience layer over an explicitly owned ProseMirror schema, with Yjs document state stored locally. Keep block IDs, schema envelope/migrations, unknown-node wrapping, persistence, and exports in Motion-owned packages. Do not depend on Tiptap Cloud or another hosted collaboration service.

## Run

```sh
npm install
npm test
```

## Dependency evidence (checked 2026-08-04)

| Package | Version checked | Licence | Registry last modified |
| --- | ---: | --- | --- |
| `@tiptap/core` | 3.29.2 | MIT | 2026-07-28 |
| `@tiptap/pm` | 3.29.2 | MIT | 2026-07-28 |
| `@tiptap/extension-collaboration` | 3.29.2 | MIT | 2026-07-28 |
| `yjs` | 13.6.31 | MIT | 2026-05-28 |
| `y-prosemirror` | 1.3.7 | MIT | 2025-07-03 |
| `prosemirror-model` | 1.25.11 | MIT | checked from npm registry |

The runnable artifact directly uses ProseMirror + Yjs to prove the essential path does not depend on paid Tiptap services. It is throwaway spike code, not production code.
