import type { Attachment, Block, Database, ID, Page, Workspace } from "./model.js";

export interface ValidationLimits {
  maxPages: number; maxBlocks: number; maxBlockDepth: number; maxDatabases: number;
  maxRows: number; maxAttachments: number; maxStringLength: number; maxObjectKeys: number;
}

export const DEFAULT_VALIDATION_LIMITS: Readonly<ValidationLimits> = Object.freeze({
  maxPages: 100_000, maxBlocks: 1_000_000, maxBlockDepth: 64, maxDatabases: 10_000,
  maxRows: 1_000_000, maxAttachments: 100_000, maxStringLength: 10_000_000, maxObjectKeys: 100_000
});

const fail = (message: string): never => { throw new Error(`Invalid workspace: ${message}`); };
const plain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const string = (value: unknown, path: string, limits: ValidationLimits, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(`${path} must be a ${allowEmpty ? "string" : "non-empty string"}`);
  const result = value as string;
  if (result.length > limits.maxStringLength) fail(`${path} exceeds string limit`);
  return result;
};
const timestamp = (value: unknown, path: string, limits: ValidationLimits): string => {
  const result = string(value, path, limits);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result) || Number.isNaN(Date.parse(result))) fail(`${path} must be a UTC ISO timestamp`);
  return result;
};
function safeObject(value: unknown, path: string, limits: ValidationLimits, seen = new Set<object>()): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "string") string(value, path, limits, true);
    if (typeof value === "number" && !Number.isFinite(value)) fail(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object" || seen.has(value as object)) fail(`${path} must contain an acyclic JSON value`);
  seen.add(value as object);
  if (Array.isArray(value)) value.forEach((entry, index) => safeObject(entry, `${path}[${index}]`, limits, seen));
  else {
    if (!plain(value)) fail(`${path} must be a plain object`);
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > limits.maxObjectKeys) fail(`${path} exceeds object key limit`);
    for (const [key, entry] of entries) {
      string(key, `${path} key`, limits, true);
      if (["__proto__", "prototype", "constructor"].includes(key)) fail(`${path} contains a forbidden key`);
      safeObject(entry, `${path}.${key}`, limits, seen);
    }
  }
  seen.delete(value as object);
}
function unique(id: unknown, path: string, limits: ValidationLimits, ids: Set<ID>): ID {
  const result = string(id, path, limits);
  if (ids.has(result)) fail(`duplicate ID ${result}`);
  ids.add(result); return result;
}
function validateBlocks(blocks: unknown, path: string, limits: ValidationLimits, ids: Set<ID>, pageId: ID, blockOwners: Map<ID, ID>, attachmentIds: Set<ID>, state: { count: number }, depth = 0): void {
  if (!Array.isArray(blocks)) fail(`${path} must be an array`);
  const list = blocks as unknown[];
  if (depth > limits.maxBlockDepth) fail(`${path} exceeds block depth limit`);
  for (let index = 0; index < list.length; index++) {
    const block = list[index] as Block; const here = `${path}[${index}]`;
    if (!plain(block)) fail(`${here} must be a plain object`);
    if (++state.count > limits.maxBlocks) fail(`block count exceeds limit`);
    const blockId = unique(block.id, `${here}.id`, limits, ids); blockOwners.set(blockId, pageId);
    string(block.type, `${here}.type`, limits); string(block.text, `${here}.text`, limits, true);
    if (block.attachmentId !== undefined && !attachmentIds.has(string(block.attachmentId, `${here}.attachmentId`, limits))) fail(`${here} references a missing attachment`);
    if (block.pageId !== undefined) string(block.pageId, `${here}.pageId`, limits);
    if (block.references !== undefined) {
      if (!Array.isArray(block.references)) fail(`${here}.references must be an array`);
      for (const [refIndex, ref] of block.references.entries()) {
        if (!plain(ref)) fail(`${here}.references[${refIndex}] must be a plain object`);
        string(ref.pageId, `${here}.references[${refIndex}].pageId`, limits);
      }
    }
    if (block.unknownData !== undefined) safeObject(block.unknownData, `${here}.unknownData`, limits);
    validateBlocks(block.children, `${here}.children`, limits, ids, pageId, blockOwners, attachmentIds, state, depth + 1);
  }
}

export function assertWorkspaceValue(value: unknown, overrides: Partial<ValidationLimits> = {}): asserts value is Workspace {
  const limits = { ...DEFAULT_VALIDATION_LIMITS, ...overrides };
  if (!plain(value)) fail("root must be a plain object");
  const w = value as unknown as Workspace;
  if (w.schemaVersion !== 2) fail("schemaVersion must be 2");
  string(w.id, "id", limits); string(w.name, "name", limits); timestamp(w.createdAt, "createdAt", limits); timestamp(w.updatedAt, "updatedAt", limits);
  if (!Array.isArray(w.pages) || w.pages.length > limits.maxPages) fail("pages must be an array within limits");
  if (!Array.isArray(w.databases) || w.databases.length > limits.maxDatabases) fail("databases must be an array within limits");
  if (!Array.isArray(w.attachments) || w.attachments.length > limits.maxAttachments) fail("attachments must be an array within limits");
  if (!Array.isArray(w.linkIndex)) fail("linkIndex must be an array");
  const pageIds = new Set<ID>(), databaseIds = new Set<ID>(), attachmentIds = new Set<ID>(), allIds = new Set<ID>(), blockOwners = new Map<ID, ID>();
  for (const [index, item] of w.attachments.entries()) {
    const attachment = item as Attachment; const path = `attachments[${index}]`;
    if (!plain(attachment)) fail(`${path} must be a plain object`);
    const id = unique(attachment.id, `${path}.id`, limits, allIds); attachmentIds.add(id);
    string(attachment.fileName, `${path}.fileName`, limits); string(attachment.mediaType, `${path}.mediaType`, limits);
    string(attachment.path, `${path}.path`, limits); timestamp(attachment.createdAt, `${path}.createdAt`, limits);
    if (!Number.isSafeInteger(attachment.byteLength) || attachment.byteLength < 0) fail(`${path}.byteLength must be a non-negative safe integer`);
    if (typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(attachment.sha256)) fail(`${path}.sha256 must be a SHA-256 hex digest`);
  }
  for (const [index, item] of w.pages.entries()) {
    const page = item as Page; const path = `pages[${index}]`;
    if (!plain(page)) fail(`${path} must be a plain object`);
    const id = unique(page.id, `${path}.id`, limits, allIds); pageIds.add(id);
    string(page.title, `${path}.title`, limits, true); timestamp(page.createdAt, `${path}.createdAt`, limits); timestamp(page.updatedAt, `${path}.updatedAt`, limits);
  }
  const blockState = { count: 0 };
  for (const [index, page] of w.pages.entries()) {
    if (page.parentId !== null && !pageIds.has(string(page.parentId, `pages[${index}].parentId`, limits))) fail(`missing parent ${page.parentId}`);
    for (const field of ["archivedAt", "deletedAt"] as const) if (page[field] !== undefined) timestamp(page[field], `pages[${index}].${field}`, limits);
    if (page.collectionId !== undefined) string(page.collectionId, `pages[${index}].collectionId`, limits);
    if (page.properties !== undefined) safeObject(page.properties, `pages[${index}].properties`, limits);
    if (page.permissions !== undefined) safeObject(page.permissions, `pages[${index}].permissions`, limits);
    const visited = new Set<ID>(); let current: Page | undefined = page;
    while (current?.parentId) { if (visited.has(current.id)) fail(`page hierarchy cycle at ${current.id}`); visited.add(current.id); current = w.pages.find(candidate => candidate.id === current!.parentId); }
    validateBlocks(page.blocks, `pages[${index}].blocks`, limits, allIds, page.id, blockOwners, attachmentIds, blockState);
  }
  let rows = 0;
  for (const [index, item] of w.databases.entries()) {
    const db = item as Database; const path = `databases[${index}]`;
    if (!plain(db)) fail(`${path} must be a plain object`);
    const id = unique(db.id, `${path}.id`, limits, allIds); databaseIds.add(id);
    if (!pageIds.has(string(db.pageId, `${path}.pageId`, limits))) fail(`${path} references missing page`);
    string(db.name, `${path}.name`, limits, true);
    if (!Array.isArray(db.properties) || !Array.isArray(db.rows) || !Array.isArray(db.views)) fail(`${path} collections must be arrays`);
    rows += db.rows.length; if (rows > limits.maxRows) fail("row count exceeds limit");
    const propertyIds = new Set<ID>(); for (const [p, prop] of db.properties.entries()) { if (!plain(prop)) fail(`${path}.properties[${p}] must be a plain object`); const propId = string(prop.id, `${path}.properties[${p}].id`, limits); if (propertyIds.has(propId)) fail(`duplicate property ID ${propId}`); propertyIds.add(propId); string(prop.name, `${path}.properties[${p}].name`, limits, true); }
    const rowIds = new Set<ID>(); for (const [r, row] of db.rows.entries()) { if (!plain(row) || !plain(row.values)) fail(`${path}.rows[${r}] must be a plain row`); const rowId = string(row.id, `${path}.rows[${r}].id`, limits); if (rowIds.has(rowId)) fail(`duplicate row ID ${rowId}`); rowIds.add(rowId); if (row.pageId !== undefined && !pageIds.has(string(row.pageId, `${path}.rows[${r}].pageId`, limits))) fail(`${path}.rows[${r}] references missing page`); timestamp(row.createdAt, `${path}.rows[${r}].createdAt`, limits); timestamp(row.updatedAt, `${path}.rows[${r}].updatedAt`, limits); safeObject(row.values, `${path}.rows[${r}].values`, limits); }
    for (const recordPageId of db.recordPageIds ?? []) if (!pageIds.has(string(recordPageId, `${path}.recordPageIds`, limits))) fail(`${path} references missing record page`);
  }
  for (const [index, db] of w.databases.entries()) for (const [propertyIndex, property] of db.properties.entries()) {
    const target = property.relation?.targetCollectionId ?? property.relationDatabaseId;
    if (target !== undefined && !databaseIds.has(target)) fail(`databases[${index}].properties[${propertyIndex}] references missing database`);
  }
  for (const [index, page] of w.pages.entries()) if (page.collectionId !== undefined && !databaseIds.has(page.collectionId)) fail(`pages[${index}] references missing collection`);
  for (const [index, link] of w.linkIndex.entries()) {
    if (!plain(link)) fail(`linkIndex[${index}] must be a plain object`);
    if (!pageIds.has(string(link.sourcePageId, `linkIndex[${index}].sourcePageId`, limits))) fail(`linkIndex[${index}] has missing source page`);
    string(link.targetPageId, `linkIndex[${index}].targetPageId`, limits); const blockId = string(link.blockId, `linkIndex[${index}].blockId`, limits);
    if (blockOwners.get(blockId) !== link.sourcePageId) fail(`linkIndex[${index}] references a block outside its source page`);
  }
}
