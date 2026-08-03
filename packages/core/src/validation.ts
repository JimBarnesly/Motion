import type { Attachment, Block, Database, DatabaseProperty, ID, Page, PropertyValue, Workspace } from "./model.js";

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
const PROPERTY_TYPES = new Set(["title", "plain-text", "rich-text", "number", "checkbox", "select", "multi-select", "status", "date", "date-range", "url", "email", "phone", "files", "created-time", "updated-time", "created-by", "updated-by", "relation", "text", "page"]);
const VIEW_TYPES = new Set(["table", "list", "board", "calendar", "gallery", "timeline", "chart", "form"]);
const FILTER_OPERATORS = new Set(["equals", "not-equals", "contains", "not-contains", "gt", "gte", "lt", "lte", "before", "after", "is-empty", "is-not-empty", "in", "relative-date"]);
function oneOf(value: unknown, values: Set<string>, path: string, limits: ValidationLimits): string {
  const result = string(value, path, limits);
  if (!values.has(result)) fail(`${path} has unsupported value ${result}`);
  return result;
}
function validatePropertyValue(value: unknown, property: DatabaseProperty, path: string, limits: ValidationLimits): void {
  if (value === null) return;
  const type = property.type;
  if (["title", "plain-text", "rich-text", "select", "status", "url", "email", "phone", "created-by", "updated-by", "text", "page", "created-time", "updated-time", "date"].includes(type)) {
    string(value, path, limits, true);
    if (["created-time", "updated-time", "date"].includes(type) && value !== "") timestamp(value, path, limits);
  } else if (type === "number") { if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} must be a finite number`); }
  else if (type === "checkbox") { if (typeof value !== "boolean") fail(`${path} must be a boolean`); }
  else if (["multi-select", "relation"].includes(type)) {
    if (!Array.isArray(value)) fail(`${path} must be an array`);
    (value as unknown[]).forEach((entry, index) => string(entry, `${path}[${index}]`, limits));
  } else if (type === "date-range") {
    if (!plain(value)) fail(`${path} must be a date range`);
    const range = value as Record<string, unknown>;
    timestamp(range.start, `${path}.start`, limits);
    if (range.end !== undefined) timestamp(range.end, `${path}.end`, limits);
  } else if (type === "files") {
    if (!plain(value) || !Array.isArray(value.attachmentIds)) fail(`${path} must contain attachmentIds`);
    ((value as Record<string, unknown>).attachmentIds as unknown[]).forEach((entry, index) => string(entry, `${path}.attachmentIds[${index}]`, limits));
  } else fail(`${path} has unsupported property type`);
}
function validateFilter(value: unknown, path: string, limits: ValidationLimits, properties: Map<ID, DatabaseProperty>, depth = 0): void {
  if (depth > limits.maxBlockDepth || !plain(value)) fail(`${path} must be a valid filter object`);
  const filter = value as Record<string, unknown>;
  if (filter.kind === "condition") {
    const propertyId = string(filter.propertyId, `${path}.propertyId`, limits), property = properties.get(propertyId);
    if (!property) fail(`${path} references unknown property ${propertyId}`);
    oneOf(filter.operator, FILTER_OPERATORS, `${path}.operator`, limits);
    if (filter.value !== undefined) validatePropertyValue(filter.value, property!, `${path}.value`, limits);
  } else if (filter.kind === "and" || filter.kind === "or") {
    if (!Array.isArray(filter.children)) fail(`${path}.children must be an array`);
    (filter.children as unknown[]).forEach((child, index) => validateFilter(child, `${path}.children[${index}]`, limits, properties, depth + 1));
  } else if (filter.kind === "not") validateFilter(filter.child, `${path}.child`, limits, properties, depth + 1);
  else fail(`${path}.kind is invalid`);
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
    const properties = new Map<ID, DatabaseProperty>(); for (const [p, prop] of db.properties.entries()) { const here = `${path}.properties[${p}]`; if (!plain(prop)) fail(`${here} must be a plain object`); const propId = unique(prop.id, `${here}.id`, limits, allIds); properties.set(propId, prop as DatabaseProperty); string(prop.name, `${here}.name`, limits, true); oneOf(prop.type, PROPERTY_TYPES, `${here}.type`, limits); if (prop.options !== undefined) { if (!Array.isArray(prop.options)) fail(`${here}.options must be an array`); const optionIds = new Set<ID>(); for (const [o, option] of prop.options.entries()) { if (!plain(option)) fail(`${here}.options[${o}] must be a plain object`); unique(option.id, `${here}.options[${o}].id`, limits, optionIds); string(option.name, `${here}.options[${o}].name`, limits, true); if (option.color !== undefined) string(option.color, `${here}.options[${o}].color`, limits); } } if (prop.relation !== undefined) { if (!plain(prop.relation)) fail(`${here}.relation must be a plain object`); string(prop.relation.targetCollectionId, `${here}.relation.targetCollectionId`, limits); if (prop.relation.reciprocalPropertyId !== undefined) string(prop.relation.reciprocalPropertyId, `${here}.relation.reciprocalPropertyId`, limits); if (prop.relation.cardinality !== undefined) oneOf(prop.relation.cardinality, new Set(["one-to-one", "one-to-many", "many-to-many"]), `${here}.relation.cardinality`, limits); if (prop.relation.maxItems !== undefined && (!Number.isSafeInteger(prop.relation.maxItems) || prop.relation.maxItems < 1)) fail(`${here}.relation.maxItems must be a positive safe integer`); if (prop.relation.onDelete !== undefined) oneOf(prop.relation.onDelete, new Set(["retain", "remove"]), `${here}.relation.onDelete`, limits); } if (prop.relationDatabaseId !== undefined) string(prop.relationDatabaseId, `${here}.relationDatabaseId`, limits); }
    for (const [r, row] of db.rows.entries()) { if (!plain(row) || !plain(row.values)) fail(`${path}.rows[${r}] must be a plain row`); unique(row.id, `${path}.rows[${r}].id`, limits, allIds); if (row.pageId !== undefined && !pageIds.has(string(row.pageId, `${path}.rows[${r}].pageId`, limits))) fail(`${path}.rows[${r}] references missing page`); timestamp(row.createdAt, `${path}.rows[${r}].createdAt`, limits); timestamp(row.updatedAt, `${path}.rows[${r}].updatedAt`, limits); for (const [propertyId, propertyValue] of Object.entries(row.values)) { const property = properties.get(propertyId); if (!property) fail(`${path}.rows[${r}].values references unknown property ${propertyId}`); validatePropertyValue(propertyValue, property!, `${path}.rows[${r}].values.${propertyId}`, limits); } }
    for (const [v, view] of db.views.entries()) { const here = `${path}.views[${v}]`; if (!plain(view)) fail(`${here} must be a plain object`); unique(view.id, `${here}.id`, limits, allIds); if (view.collectionId !== undefined && string(view.collectionId, `${here}.collectionId`, limits) !== id) fail(`${here} references another collection`); string(view.name, `${here}.name`, limits, true); oneOf(view.type, VIEW_TYPES, `${here}.type`, limits); if (!Array.isArray(view.visiblePropertyIds)) fail(`${here}.visiblePropertyIds must be an array`); const propertyRefs = [view.visiblePropertyIds, view.propertyOrder ?? []]; for (const refs of propertyRefs) { if (!Array.isArray(refs)) fail(`${here} property IDs must be arrays`); for (const ref of refs) if (!properties.has(string(ref, `${here} property ID`, limits))) fail(`${here} references unknown property ${ref}`); } if (view.columnWidths !== undefined) { if (!plain(view.columnWidths)) fail(`${here}.columnWidths must be a plain object`); for (const [propertyId, width] of Object.entries(view.columnWidths)) { if (!properties.has(propertyId)) fail(`${here}.columnWidths references unknown property ${propertyId}`); if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) fail(`${here}.columnWidths.${propertyId} must be positive`); } } if (view.filters !== undefined) validateFilter(view.filters, `${here}.filters`, limits, properties); if (view.sorts !== undefined) { if (!Array.isArray(view.sorts)) fail(`${here}.sorts must be an array`); for (const [s, sort] of view.sorts.entries()) { if (!plain(sort)) fail(`${here}.sorts[${s}] must be a plain object`); const propertyId = string(sort.propertyId, `${here}.sorts[${s}].propertyId`, limits); if (!properties.has(propertyId)) fail(`${here}.sorts[${s}] references unknown property`); oneOf(sort.direction, new Set(["asc", "desc"]), `${here}.sorts[${s}].direction`, limits); if (sort.nulls !== undefined) oneOf(sort.nulls, new Set(["first", "last"]), `${here}.sorts[${s}].nulls`, limits); if (sort.locale !== undefined) string(sort.locale, `${here}.sorts[${s}].locale`, limits); } } for (const field of ["groupByPropertyId", "subgroupByPropertyId", "calendarDatePropertyId", "timelineStartPropertyId", "timelineEndPropertyId"] as const) if (view[field] !== undefined && !properties.has(string(view[field], `${here}.${field}`, limits))) fail(`${here}.${field} references unknown property`); for (const field of ["layout", "cardPreview", "permissions"] as const) if (view[field] !== undefined) safeObject(view[field], `${here}.${field}`, limits); if (view.scope !== undefined) oneOf(view.scope, new Set(["personal", "shared"]), `${here}.scope`, limits); }
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
