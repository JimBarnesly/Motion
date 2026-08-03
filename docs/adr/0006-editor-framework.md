# ADR 0006: Tiptap over an owned ProseMirror schema

- Status: Provisional pending Tiptap browser integration test
- Date: 2026-08-04

## Context

Motion needs a rich, extensible editor with predictable commands, accessible browser integration, stable block identity, and later collaborative editing without a hosted dependency.

## Decision

Prefer Tiptap as the browser-facing convenience layer over a Motion-owned ProseMirror schema, subject to a browser integration spike proving command and serialization ownership. Keep schema definitions, compatibility transforms, commands, persistence envelopes, and exports in Motion packages. Use the open-source Yjs/y-prosemirror integration; Tiptap Cloud is neither required nor part of the local path. The ProseMirror/Yjs foundation is spike-validated; the Tiptap choice is currently architectural judgement.

## Alternatives considered

- Direct ProseMirror: maximum control, but more browser integration work for no demonstrated first-milestone benefit.
- A custom `contenteditable` editor: rejected because selection, history, schema enforcement, and clipboard behavior would become bespoke infrastructure.
- Hosted editor/collaboration services: rejected because local-only use must remain complete.

## Consequences

Tiptap extensions cannot become the canonical data contract. Browser behavior still needs IME, clipboard, keyboard, selection, drag/drop, and accessibility tests.

## Security implications

Imported nodes and rendered attributes must pass Motion-owned validation and sanitisation. No editor extension may silently fetch remote content.

## Data portability implications

Versioned ProseMirror-compatible JSON and canonical exports remain readable independently of Tiptap services.

## Revisit conditions

Accept after a Tiptap extension test proves owned schema serialization, stable IDs, commands, and Yjs reload in a browser. Revisit if Tiptap prevents required schema ownership, accessibility, deterministic serialization, or acceptable licensing.

## Spike evidence

- `spikes/002-editor-yjs/README.md` records a **VALIDATED** verdict and compatible MIT-licensed versions.
- `spikes/002-editor-yjs/test/editor.test.mjs`, test `several block types and stable IDs survive Yjs save/reload`, proves heading, paragraph, task, and page-link round trips.
- The spike README explicitly notes that browser selection, IME, clipboard, keyboard, and drag/drop are not yet validated.
