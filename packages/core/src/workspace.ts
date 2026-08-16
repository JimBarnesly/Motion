import { CANONICAL_MAX_ID_LENGTH, WORKSPACE_SCHEMA_VERSION, assertWorkspace, migrateWorkspace, type Block, type Database, type DatabaseProperty, type DatabaseRow, type DatabaseView, type FilterExpression, type ID, type Page, type PageLink, type PropertyValue, type SortClause, type Workspace } from "./model.js";
import { DEFAULT_VALIDATION_LIMITS, assertBlockTypePayload, stableId } from "./validation.js";
import { matchesRelativeDate, type RelativeDatePreset } from "./relative-date.js";
const now = () => new Date().toISOString();
const id = () => globalThis.crypto.randomUUID();
const walk = (blocks: Block[], fn: (block: Block) => void) => blocks.forEach(b => { fn(b); walk(b.children, fn); });
/** Legacy title matching uses NFC plus locale-independent Unicode default casing. */
const normalizeLegacyTitle = (title: string): string => title.trim().normalize("NFC").toLowerCase();
/** Stable LSD counting order over bounded canonical IDs: O(items * ID fields * 160), with no comparison sort. */
export function canonicalIdOrder<T>(items: readonly T[], keys: readonly ((item: T) => ID)[]): T[] {
  let result = [...items], scratch = new Array<T>(items.length); if (result.length < 2) return result;
  for (let field = keys.length - 1; field >= 0; field--) {
    let width = 0; for (const item of result) width = Math.max(width, keys[field]!(item).length);
    if (width > CANONICAL_MAX_ID_LENGTH) throw new Error("Canonical ID exceeds bounded ordering width");
    for (let offset = width - 1; offset >= 0; offset--) {
      const counts = new Uint32Array(128);
      for (const item of result) { const value = keys[field]!(item); counts[offset < value.length ? value.charCodeAt(offset) + 1 : 0]!++; }
      let cursor = 0; for (let code = 0; code < counts.length; code++) { const count = counts[code]!; counts[code] = cursor; cursor += count; }
      for (const item of result) { const value = keys[field]!(item); scratch[counts[offset < value.length ? value.charCodeAt(offset) + 1 : 0]!] = item; counts[offset < value.length ? value.charCodeAt(offset) + 1 : 0]!++; }
      [result, scratch] = [scratch, result];
    }
  }
  return result;
}
const canonicalLinkOrder = (links: readonly PageLink[]): PageLink[] => canonicalIdOrder(links,
  [link => link.sourcePageId, link => link.blockId, link => link.targetPageId]);
const COMPUTED_PROPERTY_FIELDS = Object.freeze({
  "created-time": "createdAt", "updated-time": "updatedAt", "created-by": "createdBy", "updated-by": "updatedBy"
} as const);
export function projectRecordProperties(database: Database, page: Page): Record<ID, PropertyValue> {
  const liveIds = new Set(database.properties.filter(property => property.deletedAt === undefined).map(property => property.id));
  const values = Object.fromEntries(Object.entries(structuredClone(page.properties ?? {})).filter(([propertyId]) => liveIds.has(propertyId)));
  for (const property of database.properties.filter(property => property.deletedAt === undefined)) {
    const field = COMPUTED_PROPERTY_FIELDS[property.type as keyof typeof COMPUTED_PROPERTY_FIELDS];
    if (field !== undefined) values[property.id] = page[field] ?? null;
  }
  return values;
}
const linkScopes = (links: readonly PageLink[]): Map<ID, string> => {
  const grouped = new Map<ID, PageLink[]>();
  for (const link of links) { const scoped = grouped.get(link.sourcePageId); if (scoped) scoped.push(link); else grouped.set(link.sourcePageId, [link]); }
  return new Map([...grouped].map(([pageId, scoped]) => [pageId, JSON.stringify(scoped)]));
};
export interface LinkRebuildStats { pagesVisited: number; blocksVisited: number; referencesVisited: number; wikiTokensVisited: number; idLookups: number; titleLookups: number; linkFilterChecks: number; linksEmitted: number; associationCandidatesVisited?: number; conflictGroupOperations?: number }
interface LinkLookup { pagesById: ReadonlyMap<ID, Page>; uniquePagesByTitle: ReadonlyMap<string, Page | null> }
interface WikiToken { text: string; start: number; end: number }
const radixNumberOrder = <T>(items: readonly T[], key: (item: T) => number): T[] => {
  let result = [...items], scratch = new Array<T>(items.length);
  for (let byte = 0; byte < 7; byte++) {
    const divisor = 2 ** (byte * 8), counts = new Uint32Array(256);
    for (const item of result) counts[Math.floor(key(item) / divisor) % 256]!++;
    let cursor = 0; for (let value = 0; value < counts.length; value++) { const count = counts[value]!; counts[value] = cursor; cursor += count; }
    for (const item of result) { const value = Math.floor(key(item) / divisor) % 256; scratch[counts[value]!] = item; counts[value]!++; }
    [result, scratch] = [scratch, result];
  }
  return result;
};
export interface BlockPosition { pageId: ID; parentBlockId: ID | null; beforeBlockId: ID | null }
export interface BlockContent { text: string; references?: Block["references"] }
export type BlockTransform = Pick<Block, "type"> & Partial<Pick<Block, "checked" | "language" | "attachmentId" | "headingLevel" | "pageId" | "viewId" | "date" | "url">>;
interface BlockLocation { page: Page; parent: Block | null; siblings: Block[]; index: number; block: Block }
const LEAF_BLOCK_TYPES = new Set(["divider", "image", "file", "bookmark", "child-page", "page-mention", "date-mention", "simple-table", "collection-view"]);
const KNOWN_BLOCK_TYPES = new Set(["paragraph", "heading-1", "heading-2", "heading-3", "bulleted-list", "numbered-list", "task", "toggle", "quote", "callout", "divider", "code", "image", "file", "bookmark", "child-page", "page-mention", "date-mention", "simple-table", "collection-view"]);
export function createWorkspace(name: string): Workspace { const timestamp = now(); return { schemaVersion: WORKSPACE_SCHEMA_VERSION, id: id(), name, pages: [], databases: [], attachments: [], linkIndex: [], createdAt: timestamp, updatedAt: timestamp }; }

export class WorkspaceDocument {
  public readonly data: Workspace;
  constructor(data: Workspace | unknown) { this.data = migrateWorkspace(data); assertWorkspace(this.data); this.rebuildLinkIndex(); }
  addPage(title: string, parentId: ID | null = null, metadata: Partial<Omit<Page, "id" | "title" | "parentId" | "blocks" | "createdAt" | "updatedAt">> = {}): Page {
    if (metadata.collectionId !== undefined) throw new Error("Record pages must be created with addRecord so collection membership is registered");
    if (parentId && !this.page(parentId)) throw new Error(`Parent page not found: ${parentId}`); const timestamp = now();
    const page: Page = { id: id(), parentId, title, blocks: [], createdAt: timestamp, updatedAt: timestamp, favourite: false, ...structuredClone(metadata) };
    const candidate = structuredClone(this.data); candidate.pages.push(structuredClone(page)); assertWorkspace(candidate);
    this.data.pages.push(page); this.touch(); return page;
  }
  page(pageId: ID) { return this.data.pages.find(p => p.id === pageId); }
  children(parentId: ID | null) { return this.data.pages.filter(p => p.parentId === parentId && !p.deletedAt); }
  movePage(pageId: ID, parentId: ID | null) { const page = this.requiredPage(pageId); if (parentId === pageId || (parentId && this.descendants(pageId).some(p => p.id === parentId))) throw new Error("Page hierarchy cannot contain cycles"); if (parentId) this.requiredPage(parentId); page.parentId = parentId; this.touchPage(page); }
  reorderPage(pageId: ID, beforePageId: ID | null) {
    const page = this.requiredPage(pageId); const siblings = this.children(page.parentId).filter(candidate => candidate.id !== pageId);
    if (beforePageId !== null && !siblings.some(candidate => candidate.id === beforePageId)) throw new Error("Reorder target must be a sibling page");
    const ordered = beforePageId === null ? [...siblings, page] : siblings.flatMap(candidate => candidate.id === beforePageId ? [page, candidate] : [candidate]);
    const siblingIds = new Set(ordered.map(candidate => candidate.id)); const first = this.data.pages.findIndex(candidate => siblingIds.has(candidate.id));
    this.data.pages = this.data.pages.filter(candidate => !siblingIds.has(candidate.id)); this.data.pages.splice(first < 0 ? this.data.pages.length : first, 0, ...ordered); this.touchPage(page);
  }
  descendants(pageId: ID): Page[] { const direct = this.children(pageId); return direct.flatMap(p => [p, ...this.descendants(p.id)]); }
  addBlock(pageId: ID, block: Omit<Block, "id" | "children"> & { id?: ID; children?: Block[] }): Block { return this.createBlock({ pageId, parentBlockId: null, beforeBlockId: null }, { ...block, id: block.id ?? id(), children: block.children ?? [] }); }
  updateBlock(pageId: ID, blockId: ID, patch: Partial<Block>) { const location = this.requiredBlock(pageId, blockId); const candidate = Object.assign(structuredClone(location.block), structuredClone(patch), { id: blockId }); location.siblings[location.index] = candidate; try { this.assertMutableState(); } catch (error) { location.siblings[location.index] = location.block; throw error; } this.changedPages(location.page); return candidate; }
  createBlock(position: BlockPosition, block: Block): Block {
    this.assertNewBlockIds(block); this.assertBlockNesting(block); const candidate = structuredClone(block);
    const siblings = this.targetSiblings(position); const index = this.targetIndex(siblings, position.beforeBlockId);
    siblings.splice(index, 0, candidate);
    try { this.assertMutableState(); } catch (error) { siblings.splice(index, 1); throw error; }
    this.changedPages(this.requiredPage(position.pageId)); return candidate;
  }
  updateBlockContent(pageId: ID, blockId: ID, content: BlockContent): Block {
    const location = this.requiredBlock(pageId, blockId); const candidate = structuredClone(location.block); candidate.text = content.text;
    if (Object.hasOwn(content, "references")) candidate.references = structuredClone(content.references);
    location.siblings[location.index] = candidate;
    try { this.assertMutableState(); } catch (error) { location.siblings[location.index] = location.block; throw error; }
    this.changedPages(location.page); return candidate;
  }
  transformBlock(pageId: ID, blockId: ID, transform: BlockTransform): Block {
    const location = this.requiredBlock(pageId, blockId);
    if (LEAF_BLOCK_TYPES.has(transform.type) && location.block.children.length) throw new Error(`Block type ${transform.type} cannot contain children`);
    const candidate = structuredClone(location.block); const transformKeys = new Set(Object.keys(transform)); candidate.type = transform.type; const canonical = KNOWN_BLOCK_TYPES.has(transform.type);
    for (const key of ["checked", "language", "attachmentId", "headingLevel", "pageId", "viewId", "date", "url"] as const) {
      if (transformKeys.has(key)) candidate[key] = transform[key] as never; else if (canonical) delete candidate[key];
    }
    assertBlockTypePayload(candidate as unknown as Record<string, unknown>); location.siblings[location.index] = candidate;
    try { this.assertMutableState(); } catch (error) { location.siblings[location.index] = location.block; throw error; }
    this.changedPages(location.page); return candidate;
  }
  moveBlock(pageId: ID, blockId: ID, position: BlockPosition): Block {
    const source = this.requiredBlock(pageId, blockId);
    if (position.parentBlockId === blockId || this.containsBlock(source.block, position.parentBlockId)) throw new Error("Block hierarchy cannot contain cycles");
    const targetPage = this.requiredPage(position.pageId); const target = this.targetSiblings(position);
    if (position.beforeBlockId === blockId) throw new Error("Block cannot be positioned before itself");
    source.siblings.splice(source.index, 1); let targetIndex = -1;
    try { targetIndex = this.targetIndex(target, position.beforeBlockId); target.splice(targetIndex, 0, source.block); this.assertMutableState(); }
    catch (error) { if (targetIndex >= 0) target.splice(targetIndex, 1); source.siblings.splice(source.index, 0, source.block); throw error; }
    this.changedPages(source.page, targetPage); return source.block;
  }
  indentBlock(pageId: ID, blockId: ID): Block {
    const location = this.requiredBlock(pageId, blockId); if (location.index === 0) throw new Error("Block has no previous sibling to indent under");
    const parent = location.siblings[location.index - 1]!; if (LEAF_BLOCK_TYPES.has(parent.type)) throw new Error(`Block type ${parent.type} cannot contain children`);
    location.siblings.splice(location.index, 1); parent.children.push(location.block);
    try { this.assertMutableState(); } catch (error) { parent.children.pop(); location.siblings.splice(location.index, 0, location.block); throw error; }
    this.changedPages(location.page); return location.block;
  }
  outdentBlock(pageId: ID, blockId: ID): Block {
    const location = this.requiredBlock(pageId, blockId); if (!location.parent) throw new Error("Top-level block cannot be outdented");
    const parentLocation = this.requiredBlock(pageId, location.parent.id); location.siblings.splice(location.index, 1);
    parentLocation.siblings.splice(parentLocation.index + 1, 0, location.block);
    try { this.assertMutableState(); } catch (error) { parentLocation.siblings.splice(parentLocation.index + 1, 1); location.siblings.splice(location.index, 0, location.block); throw error; }
    this.changedPages(location.page); return location.block;
  }
  duplicateBlock(pageId: ID, blockId: ID, newBlockId: ID): Block {
    const location = this.requiredBlock(pageId, blockId); const copy = structuredClone(location.block); copy.id = newBlockId; this.refreshDescendantIds(copy);
    this.assertNewBlockIds(copy); location.siblings.splice(location.index + 1, 0, copy);
    try { this.assertMutableState(); } catch (error) { location.siblings.splice(location.index + 1, 1); throw error; }
    this.changedPages(location.page); return copy;
  }
  deleteBlock(pageId: ID, blockId: ID): Block {
    const location = this.requiredBlock(pageId, blockId); location.siblings.splice(location.index, 1); this.changedPages(location.page); return location.block;
  }
  addDatabase(database: Omit<Database, "id"> & { id?: ID }): Database {
    this.requiredPage(database.pageId); const databaseId = database.id ?? id();
    const taggedRecordPageIds = this.data.pages.filter(page => page.collectionId === databaseId).map(page => page.id);
    const titleProperties = database.properties.filter(property => property.type === "title" && property.deletedAt === undefined);
    const result: Database = { ...structuredClone(database), id: databaseId, propertyOrder: structuredClone(database.propertyOrder ?? database.properties.filter(property => property.deletedAt === undefined).map(property => property.id)), ...(database.titlePropertyId !== undefined ? { titlePropertyId: database.titlePropertyId } : titleProperties.length === 1 ? { titlePropertyId: titleProperties[0]!.id } : {}), recordPageIds: structuredClone(database.recordPageIds ?? taggedRecordPageIds) };
    const candidate = structuredClone(this.data); candidate.databases.push(structuredClone(result)); assertWorkspace(candidate);
    this.data.databases.push(result); this.touch(); return result;
  }
  addRecord(databaseId: ID, title: string, values: Record<ID, PropertyValue> = {}): Page {
    const db = this.requiredDatabase(databaseId); this.assertRecordPropertyIds(db, values);
    const timestamp = now(); const page: Page = { id: id(), parentId: db.pageId, title, blocks: [], createdAt: timestamp, updatedAt: timestamp, favourite: false, collectionId: db.id, properties: structuredClone(values) };
    const candidate = structuredClone(this.data); const candidateDatabase = candidate.databases.find(database => database.id === db.id)!;
    candidate.pages.push(structuredClone(page)); candidateDatabase.recordPageIds ??= []; candidateDatabase.recordPageIds.push(page.id); assertWorkspace(candidate);
    this.data.pages.push(page); db.recordPageIds ??= []; db.recordPageIds.push(page.id); this.touch(); return page;
  }
  updateRecord(pageId: ID, title: string | undefined, values: Record<ID, PropertyValue | undefined>) {
    const page = this.requiredPage(pageId); const memberships = this.data.databases.filter(database => (database.recordPageIds ?? []).includes(page.id));
    if (memberships.length !== 1 || page.collectionId !== memberships[0]!.id) throw new Error(`Invalid record target: page is not an indexed record: ${pageId}`);
    const db = memberships[0]!; this.assertRecordPropertyIds(db, values);
    const candidateData = structuredClone(this.data); const candidatePage = candidateData.pages.find(item => item.id === page.id)!;
    if (title !== undefined) candidatePage.title = title; candidatePage.properties ??= {};
    for (const [propertyId, value] of Object.entries(values)) { if (value === undefined) delete candidatePage.properties[propertyId]; else candidatePage.properties[propertyId] = value; }
    const timestamp = now(); candidatePage.updatedAt = timestamp; candidateData.updatedAt = timestamp; assertWorkspace(candidateData);
    Object.assign(page, candidatePage); this.data.updatedAt = timestamp; return page;
  }
  reorderRecords(databaseId: ID, orderedRecordPageIds: readonly ID[]): void {
    const db = this.requiredDatabase(databaseId), indexed = db.recordPageIds ?? [];
    const live = indexed.map(pageId => this.page(pageId)).filter((page): page is Page => page !== undefined && page.deletedAt === undefined);
    const liveIds = new Set(live.filter(page => page.collectionId === db.id).map(page => page.id));
    if (liveIds.size !== live.length || orderedRecordPageIds.length !== live.length
        || new Set(orderedRecordPageIds).size !== orderedRecordPageIds.length
        || orderedRecordPageIds.some(pageId => !liveIds.has(pageId))) {
      throw new Error("Record order must contain every live record in the target collection exactly once");
    }
    let next = 0;
    db.recordPageIds = indexed.map(pageId => liveIds.has(pageId) ? orderedRecordPageIds[next++]! : pageId);
    this.touch();
  }
  addProperty(databaseId: ID, property: Omit<DatabaseProperty, "id" | "deletedAt"> & { id?: ID }) { const db = this.requiredDatabase(databaseId); const result = { ...structuredClone(property), id: property.id ?? id() }; const candidate = structuredClone(this.data), candidateDatabase = candidate.databases.find(database => database.id === db.id)!; candidateDatabase.properties.push(structuredClone(result)); candidateDatabase.propertyOrder ??= candidateDatabase.properties.filter(candidateProperty => candidateProperty.id !== result.id && candidateProperty.deletedAt === undefined).map(candidateProperty => candidateProperty.id); candidateDatabase.propertyOrder.push(result.id); for (const view of candidateDatabase.views) { view.visiblePropertyIds.push(result.id); view.propertyOrder = [...(view.propertyOrder ?? view.visiblePropertyIds.filter(propertyId => propertyId !== result.id)), result.id]; } assertWorkspace(candidate); db.properties.push(result); db.propertyOrder ??= db.properties.filter(candidateProperty => candidateProperty.id !== result.id && candidateProperty.deletedAt === undefined).map(candidateProperty => candidateProperty.id); db.propertyOrder.push(result.id); for (const view of db.views) { view.visiblePropertyIds.push(result.id); view.propertyOrder = [...(view.propertyOrder ?? view.visiblePropertyIds.filter(propertyId => propertyId !== result.id)), result.id]; } this.touch(); return result; }
  updateProperty(databaseId: ID, propertyId: ID, patch: Partial<Omit<DatabaseProperty, "id" | "deletedAt">>) { const db = this.requiredDatabase(databaseId); const property = db.properties.find(candidate => candidate.id === propertyId); if (!property) throw new Error(`Database property not found: ${propertyId}`); if (property.deletedAt) throw new Error(`Database property is tombstoned: ${propertyId}`); if (patch.type && patch.type !== property.type && (property.type === "title" || patch.type === "title")) throw new Error("The title property type is immutable"); if (patch.type && patch.type !== property.type && this.indexedRecords(db).some(page => page.properties?.[propertyId] !== undefined)) throw new Error(`Populated property type change requires an explicit conversion preview: ${propertyId}`); const candidate = structuredClone(this.data), candidateProperty = candidate.databases.find(database => database.id === db.id)!.properties.find(item => item.id === propertyId)!; Object.assign(candidateProperty, structuredClone(patch), { id: propertyId }); assertWorkspace(candidate); Object.assign(property, structuredClone(patch), { id: propertyId }); this.touch(); return property; }
  reorderProperties(databaseId: ID, orderedPropertyIds: readonly ID[]): void { const db = this.requiredDatabase(databaseId); const live = db.properties.filter(property => property.deletedAt === undefined), liveIds = new Set(live.map(property => property.id)); if (orderedPropertyIds.length !== live.length || new Set(orderedPropertyIds).size !== orderedPropertyIds.length || orderedPropertyIds.some(propertyId => !liveIds.has(propertyId))) throw new Error("Property order must contain every live property exactly once"); if (!orderedPropertyIds.some(propertyId => live.find(property => property.id === propertyId)?.type === "title")) throw new Error("Property order must retain the title property"); const byId = new Map(db.properties.map(property => [property.id, property] as const)); db.propertyOrder = [...orderedPropertyIds]; db.properties = [...orderedPropertyIds.map(propertyId => byId.get(propertyId)!), ...db.properties.filter(property => property.deletedAt !== undefined)]; this.touch(); }
  deleteProperty(databaseId: ID, propertyId: ID) { const db = this.requiredDatabase(databaseId), property = db.properties.find(candidate => candidate.id === propertyId); if (!property) throw new Error(`Database property not found: ${propertyId}`); if (property.deletedAt) throw new Error(`Database property is already tombstoned: ${propertyId}`); if (property.type === "title") throw new Error("The title property cannot be deleted"); property.deletedAt = now(); db.propertyOrder = (db.propertyOrder ?? db.properties.map(candidate => candidate.id)).filter(id => id !== propertyId); for (const view of db.views) { view.visiblePropertyIds = view.visiblePropertyIds.filter(id => id !== propertyId); view.propertyOrder = view.propertyOrder?.filter(id => id !== propertyId); if (view.columnWidths) delete view.columnWidths[propertyId]; view.sorts = view.sorts?.filter(sort => sort.propertyId !== propertyId); view.filters = view.filters ? removeFilterProperty(view.filters, propertyId) : undefined; for (const field of ["groupByPropertyId", "subgroupByPropertyId", "calendarDatePropertyId", "timelineStartPropertyId", "timelineEndPropertyId"] as const) if (view[field] === propertyId) delete view[field]; } this.touch(); }
  addView(databaseId: ID, view: Omit<DatabaseView, "collectionId">): DatabaseView {
    const db = this.requiredDatabase(databaseId), result: DatabaseView = { ...structuredClone(view), collectionId: db.id };
    const candidate = structuredClone(this.data), candidateDatabase = candidate.databases.find(database => database.id === db.id)!;
    candidateDatabase.views.push(structuredClone(result)); assertWorkspace(candidate); db.views.push(result); this.touch(); return result;
  }
  updateView(databaseId: ID, viewId: ID, patch: Partial<Omit<DatabaseView, "id" | "collectionId" | "type">>) {
    const db = this.requiredDatabase(databaseId), index = db.views.findIndex(candidate => candidate.id === viewId); if (index < 0) throw new Error(`Database view not found: ${viewId}`);
    const patchValue = structuredClone(patch) as Partial<DatabaseView>, { id: _patchId, collectionId: _patchCollectionId, type: _patchType, ...safePatch } = patchValue;
    const result = { ...structuredClone(db.views[index]!), ...safePatch, id: viewId, collectionId: db.id, type: db.views[index]!.type };
    const candidate = structuredClone(this.data), candidateDatabase = candidate.databases.find(database => database.id === db.id)!; candidateDatabase.views[index] = structuredClone(result); assertWorkspace(candidate);
    db.views[index] = result; this.touch(); return result;
  }
  duplicateView(databaseId: ID, viewId: ID, identity: { id?: ID; name?: string } = {}): DatabaseView {
    const db = this.requiredDatabase(databaseId), source = db.views.find(candidate => candidate.id === viewId); if (!source) throw new Error(`Database view not found: ${viewId}`);
    return this.addView(databaseId, { ...structuredClone(source), id: identity.id ?? id(), name: identity.name ?? `${source.name} copy` });
  }
  reorderView(databaseId: ID, viewId: ID, beforeViewId: ID | null): void {
    const db = this.requiredDatabase(databaseId), from = db.views.findIndex(view => view.id === viewId); if (from < 0) throw new Error(`Database view not found: ${viewId}`);
    if (beforeViewId === viewId) return;
    const candidate = [...db.views], [view] = candidate.splice(from, 1); const to = beforeViewId === null ? candidate.length : candidate.findIndex(item => item.id === beforeViewId);
    if (to < 0) throw new Error(`Database view not found: ${beforeViewId}`); candidate.splice(to, 0, view!); db.views = candidate; this.touch();
  }
  deleteView(databaseId: ID, viewId: ID): DatabaseView {
    const db = this.requiredDatabase(databaseId), index = db.views.findIndex(view => view.id === viewId); if (index < 0) throw new Error(`Database view not found: ${viewId}`);
    if (db.views.length === 1) throw new Error("Cannot delete the last view"); const [removed] = db.views.splice(index, 1); this.touch(); return removed!;
  }
  links(): PageLink[] { return [...this.data.linkIndex]; }
  backlinks(pageId: ID) { this.requiredPage(pageId); return this.data.linkIndex.filter(link => link.targetPageId === pageId); }
  outgoingLinks(pageId: ID) { this.requiredPage(pageId); return this.data.linkIndex.filter(link => link.sourcePageId === pageId); }
  brokenLinks(pageId?: ID) { return this.data.linkIndex.filter(link => (!pageId || link.sourcePageId === pageId) && !this.page(link.targetPageId)); }
  rebuildLinkIndex(stats?: LinkRebuildStats): ID[] {
    const before = linkScopes(this.data.linkIndex);
    const lookup = this.linkLookup(stats); const links: PageLink[] = [];
    for (const page of this.data.pages) { if (stats) stats.pagesVisited++; for (const link of this.pageLinks(page, lookup, stats)) links.push(link); }
    this.data.linkIndex = canonicalLinkOrder(links);
    const after = linkScopes(this.data.linkIndex);
    return canonicalIdOrder([...new Set([...before.keys(), ...after.keys()])].filter(pageId => before.get(pageId) !== after.get(pageId)), [pageId => pageId]);
  }
  search(query: string) { const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean); if (!terms.length) return []; return this.data.pages.map(page => { const texts: string[] = []; walk(page.blocks, b => texts.push(b.text)); const haystack = `${page.title}\n${texts.join("\n")}`.toLocaleLowerCase(); const score = terms.reduce((n, term) => n + (page.title.toLocaleLowerCase().includes(term) ? 5 : 0) + haystack.split(term).length - 1, 0); return { page, score, snippets: texts.filter(t => terms.some(term => t.toLocaleLowerCase().includes(term))).slice(0, 3) }; }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt)); }
  records(databaseId: ID): Page[] { const db = this.requiredDatabase(databaseId); return (db.recordPageIds ?? []).map(pid => this.page(pid)).filter((p): p is Page => !!p && !p.deletedAt); }
  queryRecords(databaseId: ID, filter?: FilterExpression, sorts: SortClause[] = [], clock: () => Date = () => new Date()): Page[] { const db = this.requiredDatabase(databaseId); let pages = this.records(databaseId).map(page => ({ ...structuredClone(page), properties: projectRecordProperties(db, page) })); if (filter) { const instant = clock(); pages = pages.filter(p => evaluateFilter(filter, p.properties ?? {}, instant)); } return stableSort(pages, sorts); }
  private linkLookup(stats?: LinkRebuildStats): LinkLookup {
    const pagesById = new Map<ID, Page>(), uniquePagesByTitle = new Map<string, Page | null>();
    for (const page of this.data.pages) {
      if (stats) stats.pagesVisited++;
      pagesById.set(page.id, page); const title = normalizeLegacyTitle(page.title);
      uniquePagesByTitle.set(title, uniquePagesByTitle.has(title) ? null : page);
    }
    return { pagesById, uniquePagesByTitle };
  }
  private pageLinks(page: Page, lookup: LinkLookup, stats?: LinkRebuildStats): PageLink[] {
    const links: PageLink[] = [];
    walk(page.blocks, block => {
      const references = block.references ?? [];
      if (stats) { stats.blocksVisited++; stats.referencesVisited += references.length; }
      const targets = new Set(references.map(reference => reference.pageId));
      if (block.pageId && (block.type === "page-mention" || block.type === "child-page")) targets.add(block.pageId);
      const wikiTokens: WikiToken[] = [...block.text.matchAll(/\[\[([^\]]+)\]\]/g)].map(match =>
        ({ text: match[1]!, start: match.index, end: match.index + match[0].length }));
      if (!wikiTokens.length) { for (const targetPageId of targets) links.push({ sourcePageId: page.id, targetPageId, blockId: block.id }); return; }
      const exactTokens = new Map<string, number>();
      for (let index = 0; index < wikiTokens.length; index++) { const token = wikiTokens[index]!; exactTokens.set(`${token.start}:${token.end}`, index); }
      const associated = new Uint8Array(wikiTokens.length), matchedReferences = new Uint8Array(references.length);
      const protectedTexts = new Set<string>();
      const associate = (referenceIndex: number, tokenIndex: number) => {
        associated[tokenIndex] = 1; matchedReferences[referenceIndex] = 1;
        protectedTexts.add(normalizeLegacyTitle(wikiTokens[tokenIndex]!.text));
      };
      // Sweep half-open prior ranges into transitive overlap groups. A group is one historical
      // association claim: all of its explicit IDs remain authoritative, but the group may consume
      // at most one current token. This prevents a losing duplicate/overlap from escaping into a
      // distant token. Merely touching ranges remain independent.
      let rangedReferences = references.map((reference, index) => ({ reference, index })).filter(item =>
        item.reference.start !== undefined && item.reference.end !== undefined);
      rangedReferences = radixNumberOrder(radixNumberOrder(radixNumberOrder(rangedReferences, item => item.index), item => item.reference.end!), item => item.reference.start!);
      const rangeGroups: { members: typeof rangedReferences; start: number; end: number }[] = [];
      for (const item of rangedReferences) {
        if (stats?.conflictGroupOperations !== undefined) stats.conflictGroupOperations++;
        const group = rangeGroups[rangeGroups.length - 1];
        if (group && item.reference.start! < group.end) { group.members.push(item); group.end = Math.max(group.end, item.reference.end!); }
        else rangeGroups.push({ members: [item], start: item.reference.start!, end: item.reference.end! });
      }
      for (const group of rangeGroups) {
        let exactReference = -1, exactToken = -1;
        for (const item of group.members) {
          if (stats?.conflictGroupOperations !== undefined) stats.conflictGroupOperations++;
          const tokenIndex = exactTokens.get(`${item.reference.start}:${item.reference.end}`);
          if (tokenIndex !== undefined && (exactToken < 0 || tokenIndex < exactToken)) { exactReference = item.index; exactToken = tokenIndex; }
        }
        if (exactToken >= 0) associate(exactReference, exactToken);
        if (exactToken >= 0) for (const item of group.members) matchedReferences[item.index] = 1;
      }
      // Non-exact groups are ordered by prior coordinates and greedily consume one nearest
      // remaining token (overlap, start displacement, token offset).
      const staleRanges = rangeGroups.filter(group => !group.members.some(item => matchedReferences[item.index]));
      const previous = new Int32Array(wikiTokens.length), next = new Int32Array(wikiTokens.length);
      let available = -1, tail = -1; for (let index = 0; index < wikiTokens.length; index++) { previous[index] = available; if (!associated[index]) { available = index; tail = index; } }
      available = -1; for (let index = wikiTokens.length - 1; index >= 0; index--) { next[index] = available; if (!associated[index]) available = index; }
      const removeToken = (index: number) => { const left = previous[index]!, right = next[index]!; if (left >= 0) next[left] = right; if (right >= 0) previous[right] = left; else tail = left; associated[index] = 1; };
      let cursor = available;
      for (const group of staleRanges) {
        while (cursor >= 0 && wikiTokens[cursor]!.start < group.start) cursor = next[cursor]!;
        const left = cursor >= 0 ? previous[cursor]! : tail;
        const candidates = [left, cursor].filter(index => index >= 0);
        let best = -1, bestGap = Number.POSITIVE_INFINITY, bestShift = Number.POSITIVE_INFINITY;
        for (const tokenIndex of candidates) {
          if (stats?.associationCandidatesVisited !== undefined) stats.associationCandidatesVisited++;
          const token = wikiTokens[tokenIndex]!;
          const gap = token.end <= group.start ? group.start - token.end : token.start >= group.end ? token.start - group.end : 0;
          const shift = Math.abs(token.start - group.start);
          if (gap < bestGap || (gap === bestGap && (shift < bestShift || (shift === bestShift && token.start < wikiTokens[best]?.start!)))) { best = tokenIndex; bestGap = gap; bestShift = shift; }
        }
        for (const item of group.members) matchedReferences[item.index] = 1;
        if (best >= 0) { associate(group.members[0]!.index, best); const successor = next[best]!; removeToken(best); if (cursor === best) cursor = successor; }
      }
      // Unranged references associate only through unique identity, or when exactly one reference
      // and one token remain. Ambiguous references consume nothing; unrelated tokens stay visible.
      const uniqueTokenByText = new Map<string, number | null>();
      for (let index = 0; index < wikiTokens.length; index++) if (!associated[index]) {
        const key = normalizeLegacyTitle(wikiTokens[index]!.text); uniqueTokenByText.set(key, uniqueTokenByText.has(key) ? null : index);
      }
      for (let index = 0; index < references.length; index++) if (!matchedReferences[index] && references[index]!.start === undefined) {
        const reference = references[index]!, target = lookup.pagesById.get(reference.pageId);
        const keys = new Set([normalizeLegacyTitle(reference.pageId), ...(target ? [normalizeLegacyTitle(target.title)] : [])]);
        const candidates = [...keys].map(key => uniqueTokenByText.get(key)).filter((value): value is number => value !== undefined && value !== null && !associated[value]);
        if (stats?.associationCandidatesVisited !== undefined) stats.associationCandidatesVisited += keys.size;
        if (candidates.length === 1) associate(index, candidates[0]!);
      }
      const remainingReferences = references.map((reference, index) => ({ reference, index })).filter(item => !matchedReferences[item.index] && item.reference.start === undefined);
      const remainingTokens = wikiTokens.map((token, index) => ({ token, index })).filter(item => !associated[item.index]);
      if (remainingReferences.length === 1 && remainingTokens.length === 1) associate(remainingReferences[0]!.index, remainingTokens[0]!.index);
      else if (remainingReferences.length && remainingTokens.length) for (const item of remainingTokens) {
        // A canonical stable-ID token proves its own unrelated identity even when legacy-title
        // association is ambiguous; fail closed only for tokens that could be stale labels.
        if (!lookup.pagesById.has(item.token.text)) associated[item.index] = 1;
      }
      for (let tokenIndex = 0; tokenIndex < wikiTokens.length; tokenIndex++) {
        const token = wikiTokens[tokenIndex]!;
        if (stats) stats.wikiTokensVisited++;
        if (associated[tokenIndex] || protectedTexts.has(normalizeLegacyTitle(token.text))) continue;
        if (stats) stats.idLookups++; const byId = lookup.pagesById.get(token.text);
        if (!byId && stats) stats.titleLookups++;
        const target = byId ?? lookup.uniquePagesByTitle.get(normalizeLegacyTitle(token.text)) ?? undefined;
        if (target) targets.add(target.id);
      }
      for (const targetPageId of targets) links.push({ sourcePageId: page.id, targetPageId, blockId: block.id });
    });
    if (stats) stats.linksEmitted += links.length;
    return links;
  }
  private indexPage(page: Page) {
    this.data.linkIndex = this.data.linkIndex.filter(link => link.sourcePageId !== page.id);
    for (const link of this.pageLinks(page, this.linkLookup())) this.data.linkIndex.push(link);
    this.data.linkIndex = canonicalLinkOrder(this.data.linkIndex);
  }
  private blockLocation(page: Page, blockId: ID, blocks: Block[] = page.blocks, parent: Block | null = null): BlockLocation | undefined {
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!; if (block.id === blockId) return { page, parent, siblings: blocks, index, block };
      const nested = this.blockLocation(page, blockId, block.children, block); if (nested) return nested;
    }
    return undefined;
  }
  private requiredBlock(pageId: ID, blockId: ID): BlockLocation { const page = this.requiredPage(pageId); const location = this.blockLocation(page, blockId); if (!location) throw new Error(`Block not found: ${blockId}`); return location; }
  private targetSiblings(position: BlockPosition): Block[] {
    const page = this.requiredPage(position.pageId); if (position.parentBlockId === null) return page.blocks;
    const parent = this.requiredBlock(page.id, position.parentBlockId).block;
    if (LEAF_BLOCK_TYPES.has(parent.type)) throw new Error(`Block type ${parent.type} cannot contain children`);
    return parent.children;
  }
  private targetIndex(siblings: Block[], beforeBlockId: ID | null): number {
    if (beforeBlockId === null) return siblings.length; const index = siblings.findIndex(block => block.id === beforeBlockId);
    if (index < 0) throw new Error(`Position target not found: ${beforeBlockId}`); return index;
  }
  private containsBlock(root: Block, blockId: ID | null): boolean { if (blockId === null) return false; return root.children.some(child => child.id === blockId || this.containsBlock(child, blockId)); }
  private allStableIds(): Set<ID> {
    const ids = new Set<ID>([this.data.id]);
    for (const attachment of this.data.attachments) ids.add(attachment.id);
    for (const page of this.data.pages) { ids.add(page.id); walk(page.blocks, block => ids.add(block.id)); }
    for (const database of this.data.databases) { ids.add(database.id); for (const property of database.properties) { ids.add(property.id); for (const option of property.options ?? []) ids.add(option.id); } for (const row of database.rows) ids.add(row.id); for (const view of database.views) ids.add(view.id); }
    return ids;
  }
  private assertNewBlockIds(root: Block): void {
    const existing = this.allStableIds(), candidate = new Set<ID>(), pending = [{ block: root, depth: 0 }]; let count = 0;
    while (pending.length) {
      const { block, depth } = pending.pop()!;
      if (!block || typeof block !== "object" || depth > DEFAULT_VALIDATION_LIMITS.maxBlockDepth || ++count > DEFAULT_VALIDATION_LIMITS.maxBlocks || !Array.isArray(block.children)) throw new Error("Block subtree exceeds limits");
      stableId(block.id); if (existing.has(block.id) || candidate.has(block.id)) throw new Error(`duplicate ID ${block.id}`); candidate.add(block.id);
      if (depth >= DEFAULT_VALIDATION_LIMITS.maxBlockDepth && block.children.length) throw new Error("Block subtree exceeds limits");
      if (block.children.length > DEFAULT_VALIDATION_LIMITS.maxBlocks - count - pending.length) throw new Error("Block subtree exceeds limits");
      for (let index = 0; index < block.children.length; index++) pending.push({ block: block.children[index]!, depth: depth + 1 });
    }
  }
  private assertBlockNesting(root: Block): void {
    const pending = [{ block: root, depth: 0 }]; let count = 0;
    while (pending.length) {
      const { block, depth } = pending.pop()!;
      if (!block || typeof block !== "object" || depth > DEFAULT_VALIDATION_LIMITS.maxBlockDepth || ++count > DEFAULT_VALIDATION_LIMITS.maxBlocks || !Array.isArray(block.children)) throw new Error("Block subtree exceeds limits");
      if (LEAF_BLOCK_TYPES.has(block.type) && block.children.length) throw new Error(`Block type ${block.type} cannot contain children`);
      if (depth >= DEFAULT_VALIDATION_LIMITS.maxBlockDepth && block.children.length) throw new Error("Block subtree exceeds limits");
      if (block.children.length > DEFAULT_VALIDATION_LIMITS.maxBlocks - count - pending.length) throw new Error("Block subtree exceeds limits");
      for (let index = 0; index < block.children.length; index++) pending.push({ block: block.children[index]!, depth: depth + 1 });
    }
  }
  private refreshDescendantIds(root: Block): void {
    const pending: { block: Block; path: string; depth: number }[] = []; let count = 1;
    if (root.children.length > DEFAULT_VALIDATION_LIMITS.maxBlocks - count) throw new Error("Block subtree exceeds limits");
    for (let index = 0; index < root.children.length; index++) pending.push({ block: root.children[index]!, path: String(index), depth: 1 });
    while (pending.length) {
      const { block, path, depth } = pending.pop()!;
      if (!block || typeof block !== "object" || depth > DEFAULT_VALIDATION_LIMITS.maxBlockDepth || ++count > DEFAULT_VALIDATION_LIMITS.maxBlocks || !Array.isArray(block.children)) throw new Error("Block subtree exceeds limits");
      block.id = `${root.id}:${path}`;
      if (depth >= DEFAULT_VALIDATION_LIMITS.maxBlockDepth && block.children.length) throw new Error("Block subtree exceeds limits");
      if (block.children.length > DEFAULT_VALIDATION_LIMITS.maxBlocks - count - pending.length) throw new Error("Block subtree exceeds limits");
      for (let index = 0; index < block.children.length; index++) pending.push({ block: block.children[index]!, path: `${path}.${index}`, depth: depth + 1 });
    }
  }
  private assertMutableState(): void { assertWorkspace({ ...this.data, linkIndex: [] }); }
  private changedPages(...pages: Page[]): void { for (const page of new Set(pages)) { page.updatedAt = now(); this.indexPage(page); } this.touch(); }
  private requiredPage(pageId: ID) { const page = this.page(pageId); if (!page) throw new Error(`Page not found: ${pageId}`); return page; }
  private requiredDatabase(databaseId: ID) { const db = this.data.databases.find(d => d.id === databaseId); if (!db) throw new Error(`Database not found: ${databaseId}`); return db; }
  private indexedRecords(database: Database): Page[] { return (database.recordPageIds ?? []).map(pageId => this.page(pageId)).filter((page): page is Page => page !== undefined); }
  private assertRecordPropertyIds(db: Database, values: Record<ID, PropertyValue | undefined>): void { for (const propertyId of Object.keys(values)) { const property = db.properties.find(candidate => candidate.id === propertyId); if (!property) throw new Error(`Invalid record property for collection: ${propertyId}`); if (property.deletedAt) throw new Error(`Database property is tombstoned: ${propertyId}`); if (Object.hasOwn(COMPUTED_PROPERTY_FIELDS, property.type)) throw new Error(`Computed record property is read-only and derives from page metadata: ${propertyId}`); } }
  private touchPage(page: Page) { page.updatedAt = now(); this.touch(); }
  private touch() { this.data.updatedAt = now(); }
}

function removeFilterProperty(filter: FilterExpression, propertyId: ID): FilterExpression | undefined { if (filter.kind === "condition") return filter.propertyId === propertyId ? undefined : filter; if (filter.kind === "not") { const child = removeFilterProperty(filter.child, propertyId); return child ? { ...filter, child } : undefined; } const children = filter.children.map(child => removeFilterProperty(child, propertyId)).filter((child): child is FilterExpression => child !== undefined); if (!children.length) return undefined; if (children.length === 1) return children[0]; return { ...filter, children }; }
function evaluateFilter(node: FilterExpression, values: Record<ID, PropertyValue>, instant: Date): boolean {
  if ("children" in node && node.kind === "and") return node.children.every(n => evaluateFilter(n, values, instant));
  if ("children" in node && node.kind === "or") return node.children.some(n => evaluateFilter(n, values, instant));
  if (node.kind === "not") return !evaluateFilter(node.child, values, instant);
  if (node.kind !== "condition") return false;
  const actual: any = values[node.propertyId], expected: any = node.value;
  switch (node.operator) { case "is-empty": return actual == null || actual === "" || (Array.isArray(actual) && !actual.length); case "is-not-empty": return !(actual == null || actual === "" || (Array.isArray(actual) && !actual.length)); case "equals": return JSON.stringify(actual) === JSON.stringify(expected); case "not-equals": return JSON.stringify(actual) !== JSON.stringify(expected); case "contains": return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected)); case "not-contains": return !(Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected))); case "gt": case "after": return actual > expected; case "gte": return actual >= expected; case "lt": case "before": return actual < expected; case "lte": return actual <= expected; case "in": return Array.isArray(expected) && expected.includes(actual); case "relative-date": return matchesRelativeDate(actual, expected as RelativeDatePreset, instant); default: return false; }
}
function stableSort(pages: Page[], sorts: SortClause[]): Page[] { return pages.map((page, index) => ({ page, index })).sort((a,b) => { for (const sort of sorts) { const av: any = a.page.properties?.[sort.propertyId], bv: any = b.page.properties?.[sort.propertyId]; if (av == null || bv == null) { if (av == null && bv == null) continue; return av == null ? (sort.nulls === "first" ? -1 : 1) : (sort.nulls === "first" ? 1 : -1); } const result = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv, sort.locale) : av < bv ? -1 : av > bv ? 1 : 0; if (result) return sort.direction === "asc" ? result : -result; } return a.index - b.index; }).map(x => x.page); }
