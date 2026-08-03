import assert from 'node:assert/strict'
import test from 'node:test'
import * as Y from 'yjs'
import {
  decodeDocument,
  encodeDocument,
  exportEnvelope,
  importEnvelope,
  preserveUnknownNodes,
  schema
} from '../editor.mjs'

const document = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: 'block-heading', level: 1 }, content: [{ type: 'text', text: 'Motion' }] },
    { type: 'paragraph', attrs: { id: 'block-paragraph' }, content: [{ type: 'text', text: 'Local first.' }] },
    { type: 'task', attrs: { id: 'block-task', checked: false }, content: [{ type: 'text', text: 'Test persistence' }] },
    { type: 'page_link', attrs: { id: 'block-link', pageId: 'page-2', label: 'Linked page' } }
  ]
}

test('several block types and stable IDs survive Yjs save/reload', () => {
  const update = encodeDocument(document)
  const reloaded = decodeDocument(update)
  assert.deepEqual(reloaded, document)
  assert.deepEqual(reloaded.content.map(block => block.attrs.id), [
    'block-heading', 'block-paragraph', 'block-task', 'block-link'
  ])
})

test('versioned envelope round-trips without a server', () => {
  const envelope = exportEnvelope(encodeDocument(document))
  assert.equal(envelope.schemaVersion, 1)
  assert.deepEqual(importEnvelope(JSON.parse(JSON.stringify(envelope))), document)
  assert.throws(() => importEnvelope({ ...envelope, schemaVersion: 99 }), /Unsupported/)
})

test('Yjs undo and redo restore structured editor state', () => {
  const ydoc = new Y.Doc()
  const blocks = ydoc.getArray('blocks')
  const undo = new Y.UndoManager(blocks)
  blocks.push([{ id: 'block-1', type: 'paragraph', text: 'one' }])
  undo.stopCapturing()
  blocks.push([{ id: 'block-2', type: 'task', text: 'two', checked: false }])
  assert.equal(blocks.length, 2)
  undo.undo()
  assert.equal(blocks.length, 1)
  undo.redo()
  assert.equal(blocks.length, 2)
  assert.equal(blocks.get(1).id, 'block-2')
})

test('unknown future nodes are preserved as lossless placeholders', () => {
  const future = {
    type: 'doc',
    content: [{ type: 'chart_v9', attrs: { id: 'future-1', mode: 'scatter' }, vendorData: { x: [1, 2] } }]
  }
  assert.throws(() => schema.nodeFromJSON(future), /Unknown node type/)
  const safe = preserveUnknownNodes(future)
  const parsed = schema.nodeFromJSON(safe)
  assert.equal(parsed.firstChild.type.name, 'unsupported')
  assert.equal(parsed.firstChild.attrs.id, 'future-1')
  assert.deepEqual(JSON.parse(parsed.firstChild.attrs.raw), future.content[0])
})
