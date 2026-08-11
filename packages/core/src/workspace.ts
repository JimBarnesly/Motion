import { WORKSPACE_SCHEMA_VERSION, assertWorkspace, migrateWorkspace, type Block, type Database, type DatabaseProperty, type DatabaseRow, type DatabaseView, type FilterExpression, type ID, type Page, type PageLink, type PropertyValue, type SortClause, type Workspace } from "./model.js";
import { DEFAULT_VALIDATION_LIMITS, assertBlockTypePayload, stableId } from "./validation.js";
const now = () => new Date().toISOString();
const id = () => globalThis.crypto.randomUUID();
const walk = (blocks: Block[], fn: (block: Block) => void) => blocks.forEach(b => { fn(b); walk(b.children, fn); });
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
    if (parentId && !this.page(parentId)) throw new Error(`Parent page not found: ${parentId}`); const timestamp = now();
    const page: Page = { id: id(), parentId, title, blocks: [], createdAt: timestamp, updatedAt: timestamp, favourite: false, ...metadata };
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
  addDatabase(database: Omit<Database, "id"> & { id?: ID }): Database { this.requiredPage(database.pageId); const result = { ...database, id: database.id ?? id(), recordPageIds: database.recordPageIds ?? [] }; this.data.databases.push(result); this.touch(); return result; }
  addRecord(databaseId: ID, title: string, values: Record<ID, PropertyValue> = {}): Page { const db = this.requiredDatabase(databaseId); const page = this.addPage(title, db.pageId, { collectionId: db.id, properties: values }); db.recordPageIds ??= []; db.recordPageIds.push(page.id); return page; }
  updateRecord(pageId: ID, title: string | undefined, values: Record<ID, PropertyValue | undefined>) { const page = this.requiredPage(pageId); const db = this.requiredDatabase(page.collectionId ?? ""); if (title !== undefined) page.title = title; page.properties ??= {}; for (const [propertyId, value] of Object.entries(values)) { if (!db.properties.some(property => property.id === propertyId)) throw new Error(`Database property not found: ${propertyId}`); if (value === undefined) delete page.properties[propertyId]; else page.properties[propertyId] = value; } this.touchPage(page); return page; }
  addProperty(databaseId: ID, property: Omit<DatabaseProperty, "id"> & { id?: ID }) { const db = this.requiredDatabase(databaseId); const result = { ...property, id: property.id ?? id() }; db.properties.push(result); for (const view of db.views) { view.visiblePropertyIds.push(result.id); view.propertyOrder = [...(view.propertyOrder ?? view.visiblePropertyIds.filter(propertyId => propertyId !== result.id)), result.id]; } this.touch(); return result; }
  updateProperty(databaseId: ID, propertyId: ID, patch: Partial<Omit<DatabaseProperty, "id">>) { const db = this.requiredDatabase(databaseId); const property = db.properties.find(candidate => candidate.id === propertyId); if (!property) throw new Error(`Database property not found: ${propertyId}`); if (patch.type && patch.type !== property.type) for (const page of this.records(databaseId)) delete page.properties?.[propertyId]; Object.assign(property, patch, { id: propertyId }); this.touch(); return property; }
  deleteProperty(databaseId: ID, propertyId: ID) { const db = this.requiredDatabase(databaseId); if (db.properties.find(candidate => candidate.id === propertyId)?.type === "title") throw new Error("The title property cannot be deleted"); db.properties = db.properties.filter(candidate => candidate.id !== propertyId); for (const page of this.records(databaseId)) delete page.properties?.[propertyId]; for (const view of db.views) { view.visiblePropertyIds = view.visiblePropertyIds.filter(id => id !== propertyId); view.propertyOrder = view.propertyOrder?.filter(id => id !== propertyId); if (view.columnWidths) delete view.columnWidths[propertyId]; view.sorts = view.sorts?.filter(sort => sort.propertyId !== propertyId); if (view.filters && filterReferences(view.filters, propertyId)) delete view.filters; } this.touch(); }
  updateView(databaseId: ID, viewId: ID, patch: Partial<Omit<DatabaseView, "id" | "collectionId" | "type">>) { const db = this.requiredDatabase(databaseId); const view = db.views.find(candidate => candidate.id === viewId); if (!view) throw new Error(`Database view not found: ${viewId}`); Object.assign(view, patch, { id: viewId, collectionId: db.id, type: "table" as const }); this.touch(); return view; }
  links(): PageLink[] { return [...this.data.linkIndex]; }
  backlinks(pageId: ID) { this.requiredPage(pageId); return this.data.linkIndex.filter(link => link.targetPageId === pageId); }
  outgoingLinks(pageId: ID) { this.requiredPage(pageId); return this.data.linkIndex.filter(link => link.sourcePageId === pageId); }
  brokenLinks(pageId?: ID) { return this.data.linkIndex.filter(link => (!pageId || link.sourcePageId === pageId) && !this.page(link.targetPageId)); }
  rebuildLinkIndex() { this.data.linkIndex = []; for (const page of this.data.pages) this.indexPage(page); }
  search(query: string) { const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean); if (!terms.length) return []; return this.data.pages.map(page => { const texts: string[] = []; walk(page.blocks, b => texts.push(b.text)); const haystack = `${page.title}\n${texts.join("\n")}`.toLocaleLowerCase(); const score = terms.reduce((n, term) => n + (page.title.toLocaleLowerCase().includes(term) ? 5 : 0) + haystack.split(term).length - 1, 0); return { page, score, snippets: texts.filter(t => terms.some(term => t.toLocaleLowerCase().includes(term))).slice(0, 3) }; }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt)); }
  records(databaseId: ID): Page[] { const db = this.requiredDatabase(databaseId); return (db.recordPageIds ?? []).map(pid => this.page(pid)).filter((p): p is Page => !!p && !p.deletedAt); }
  queryRecords(databaseId: ID, filter?: FilterExpression, sorts: SortClause[] = []): Page[] { let pages = this.records(databaseId); if (filter) pages = pages.filter(p => evaluateFilter(filter, p.properties ?? {})); return stableSort(pages, sorts); }
  private indexPage(page: Page) { this.data.linkIndex = this.data.linkIndex.filter(l => l.sourcePageId !== page.id); walk(page.blocks, block => { const targets = new Set((block.references ?? []).map(r => r.pageId)); if (block.pageId && (block.type === "page-mention" || block.type === "child-page")) targets.add(block.pageId); for (const match of block.text.matchAll(/\[\[([^\]]+)\]\]/g)) { const target = this.page(match[1]) ?? this.data.pages.find(p => p.title.toLocaleLowerCase() === match[1].toLocaleLowerCase()); if (target) targets.add(target.id); } for (const targetPageId of targets) this.data.linkIndex.push({ sourcePageId: page.id, targetPageId, blockId: block.id }); }); this.data.linkIndex.sort((a,b) => a.sourcePageId.localeCompare(b.sourcePageId) || a.blockId.localeCompare(b.blockId) || a.targetPageId.localeCompare(b.targetPageId)); }
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
  private touchPage(page: Page) { page.updatedAt = now(); this.touch(); }
  private touch() { this.data.updatedAt = now(); }
}

function filterReferences(filter: FilterExpression, propertyId: ID): boolean { if (filter.kind === "condition") return filter.propertyId === propertyId; if (filter.kind === "not") return filterReferences(filter.child, propertyId); return filter.children.some(child => filterReferences(child, propertyId)); }

function evaluateFilter(node: FilterExpression, values: Record<ID, PropertyValue>): boolean {
  if ("children" in node && node.kind === "and") return node.children.every(n => evaluateFilter(n, values));
  if ("children" in node && node.kind === "or") return node.children.some(n => evaluateFilter(n, values));
  if (node.kind === "not") return !evaluateFilter(node.child, values);
  if (node.kind !== "condition") return false;
  const actual: any = values[node.propertyId], expected: any = node.value;
  switch (node.operator) { case "is-empty": return actual == null || actual === "" || (Array.isArray(actual) && !actual.length); case "is-not-empty": return !(actual == null || actual === "" || (Array.isArray(actual) && !actual.length)); case "equals": return JSON.stringify(actual) === JSON.stringify(expected); case "not-equals": return JSON.stringify(actual) !== JSON.stringify(expected); case "contains": return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected)); case "not-contains": return !(Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected))); case "gt": case "after": return actual > expected; case "gte": return actual >= expected; case "lt": case "before": return actual < expected; case "lte": return actual <= expected; case "in": return Array.isArray(expected) && expected.includes(actual); case "relative-date": return false; default: return false; }
}
function stableSort(pages: Page[], sorts: SortClause[]): Page[] { return pages.map((page, index) => ({ page, index })).sort((a,b) => { for (const sort of sorts) { const av: any = a.page.properties?.[sort.propertyId], bv: any = b.page.properties?.[sort.propertyId]; if (av == null || bv == null) { if (av == null && bv == null) continue; return av == null ? (sort.nulls === "first" ? -1 : 1) : (sort.nulls === "first" ? 1 : -1); } const result = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv, sort.locale) : av < bv ? -1 : av > bv ? 1 : 0; if (result) return sort.direction === "asc" ? result : -result; } return a.index - b.index; }).map(x => x.page); }
