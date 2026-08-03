import { Schema } from 'prosemirror-model'
import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'

export const DOCUMENT_SCHEMA_VERSION = 1

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'inline*', attrs: { id: { default: null } } },
    heading: { group: 'block', content: 'inline*', attrs: { id: { default: null }, level: { default: 1 } } },
    task: { group: 'block', content: 'inline*', attrs: { id: { default: null }, checked: { default: false } } },
    page_link: {
      group: 'block',
      atom: true,
      attrs: { id: { default: null }, pageId: { default: null }, label: { default: '' } }
    },
    unsupported: {
      group: 'block',
      atom: true,
      attrs: { id: { default: null }, originalType: { default: '' }, raw: { default: '{}' } }
    }
  }
})

export function preserveUnknownNodes(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(preserveUnknownNodes)
  if (typeof value.type === 'string' && !schema.nodes[value.type]) {
    return {
      type: 'unsupported',
      attrs: {
        id: value.attrs?.id ?? crypto.randomUUID(),
        originalType: value.type,
        raw: JSON.stringify(value)
      }
    }
  }
  return {
    ...value,
    ...(value.content ? { content: value.content.map(preserveUnknownNodes) } : {})
  }
}

export function encodeDocument(json) {
  const validated = schema.nodeFromJSON(preserveUnknownNodes(json)).toJSON()
  for (const block of validated.content ?? []) {
    if (!block.attrs?.id) throw new Error(`Block ${block.type} is missing a stable ID`)
  }
  const ydoc = prosemirrorJSONToYDoc(schema, validated, 'content')
  return Y.encodeStateAsUpdate(ydoc)
}

export function decodeDocument(update) {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, update)
  return yDocToProsemirrorJSON(ydoc, 'content')
}

export function exportEnvelope(update) {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    yjsUpdateBase64: Buffer.from(update).toString('base64')
  }
}

export function importEnvelope(envelope) {
  if (envelope.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported document schema version: ${envelope.schemaVersion}`)
  }
  return decodeDocument(Buffer.from(envelope.yjsUpdateBase64, 'base64'))
}
