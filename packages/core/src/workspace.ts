import { WORKSPACE_SCHEMA_VERSION, assertWorkspace, migrateWorkspace, type Block, type Database, type DatabaseRow, type FilterExpression, type ID, type Page, type PageLink, type PropertyValue, type SortClause, type Workspace } from "./model.js";
const now = () => new Date().toISOString();
const id = () => globalThis.crypto.randomUUID();
const walk = (blocks: Block[], fn: (block: Block) => void) => blocks.forEach(b => { fn(b); walk(b.children, fn); });
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
  descendants(pageId: ID): Page[] { const direct = this.children(pageId); return direct.flatMap(p => [p, ...this.descendants(p.id)]); }
  addBlock(pageId: ID, block: Omit<Block, "id" | "children"> & { id?: ID; children?: Block[] }): Block { const result: Block = { ...block, id: block.id ?? id(), children: block.children ?? [] }; const page = this.requiredPage(pageId); page.blocks.push(result); this.touchPage(page); this.indexPage(page); return result; }
  updateBlock(pageId: ID, blockId: ID, patch: Partial<Block>) { const page = this.requiredPage(pageId); let found: Block | undefined; walk(page.blocks, b => { if (b.id === blockId) found = b; }); if (!found) throw new Error(`Block not found: ${blockId}`); Object.assign(found, patch, { id: blockId }); this.touchPage(page); this.indexPage(page); return found; }
  addDatabase(database: Omit<Database, "id"> & { id?: ID }): Database { this.requiredPage(database.pageId); const result = { ...database, id: database.id ?? id(), recordPageIds: database.recordPageIds ?? [] }; this.data.databases.push(result); this.touch(); return result; }
  addRecord(databaseId: ID, title: string, values: Record<ID, PropertyValue> = {}): Page { const db = this.requiredDatabase(databaseId); const page = this.addPage(title, db.pageId, { collectionId: db.id, properties: values }); db.recordPageIds ??= []; db.recordPageIds.push(page.id); return page; }
  links(): PageLink[] { return [...this.data.linkIndex]; }
  backlinks(pageId: ID) { this.requiredPage(pageId); return this.data.linkIndex.filter(link => link.targetPageId === pageId); }
  outgoingLinks(pageId: ID) { this.requiredPage(pageId); return this.data.linkIndex.filter(link => link.sourcePageId === pageId); }
  brokenLinks(pageId?: ID) { return this.data.linkIndex.filter(link => (!pageId || link.sourcePageId === pageId) && !this.page(link.targetPageId)); }
  rebuildLinkIndex() { this.data.linkIndex = []; for (const page of this.data.pages) this.indexPage(page); }
  search(query: string) { const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean); if (!terms.length) return []; return this.data.pages.map(page => { const texts: string[] = []; walk(page.blocks, b => texts.push(b.text)); const haystack = `${page.title}\n${texts.join("\n")}`.toLocaleLowerCase(); const score = terms.reduce((n, term) => n + (page.title.toLocaleLowerCase().includes(term) ? 5 : 0) + haystack.split(term).length - 1, 0); return { page, score, snippets: texts.filter(t => terms.some(term => t.toLocaleLowerCase().includes(term))).slice(0, 3) }; }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt)); }
  records(databaseId: ID): Page[] { const db = this.requiredDatabase(databaseId); return (db.recordPageIds ?? []).map(pid => this.page(pid)).filter((p): p is Page => !!p && !p.deletedAt); }
  queryRecords(databaseId: ID, filter?: FilterExpression, sorts: SortClause[] = []): Page[] { let pages = this.records(databaseId); if (filter) pages = pages.filter(p => evaluateFilter(filter, p.properties ?? {})); return stableSort(pages, sorts); }
  private indexPage(page: Page) { this.data.linkIndex = this.data.linkIndex.filter(l => l.sourcePageId !== page.id); walk(page.blocks, block => { const targets = new Set((block.references ?? []).map(r => r.pageId)); if (block.pageId && (block.type === "page-mention" || block.type === "child-page")) targets.add(block.pageId); for (const match of block.text.matchAll(/\[\[([^\]]+)\]\]/g)) { const target = this.page(match[1]) ?? this.data.pages.find(p => p.title.toLocaleLowerCase() === match[1].toLocaleLowerCase()); if (target) targets.add(target.id); } for (const targetPageId of targets) this.data.linkIndex.push({ sourcePageId: page.id, targetPageId, blockId: block.id }); }); this.data.linkIndex.sort((a,b) => a.sourcePageId.localeCompare(b.sourcePageId) || a.blockId.localeCompare(b.blockId) || a.targetPageId.localeCompare(b.targetPageId)); }
  private requiredPage(pageId: ID) { const page = this.page(pageId); if (!page) throw new Error(`Page not found: ${pageId}`); return page; }
  private requiredDatabase(databaseId: ID) { const db = this.data.databases.find(d => d.id === databaseId); if (!db) throw new Error(`Database not found: ${databaseId}`); return db; }
  private touchPage(page: Page) { page.updatedAt = now(); this.touch(); }
  private touch() { this.data.updatedAt = now(); }
}

function evaluateFilter(node: FilterExpression, values: Record<ID, PropertyValue>): boolean {
  if ("children" in node && node.kind === "and") return node.children.every(n => evaluateFilter(n, values));
  if ("children" in node && node.kind === "or") return node.children.some(n => evaluateFilter(n, values));
  if (node.kind === "not") return !evaluateFilter(node.child, values);
  if (node.kind !== "condition") return false;
  const actual: any = values[node.propertyId], expected: any = node.value;
  switch (node.operator) { case "is-empty": return actual == null || actual === "" || (Array.isArray(actual) && !actual.length); case "is-not-empty": return !(actual == null || actual === "" || (Array.isArray(actual) && !actual.length)); case "equals": return JSON.stringify(actual) === JSON.stringify(expected); case "not-equals": return JSON.stringify(actual) !== JSON.stringify(expected); case "contains": return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected)); case "not-contains": return !(Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected))); case "gt": case "after": return actual > expected; case "gte": return actual >= expected; case "lt": case "before": return actual < expected; case "lte": return actual <= expected; case "in": return Array.isArray(expected) && expected.includes(actual); case "relative-date": return false; default: return false; }
}
function stableSort(pages: Page[], sorts: SortClause[]): Page[] { return pages.map((page, index) => ({ page, index })).sort((a,b) => { for (const sort of sorts) { const av: any = a.page.properties?.[sort.propertyId], bv: any = b.page.properties?.[sort.propertyId]; if (av == null || bv == null) { if (av == null && bv == null) continue; return av == null ? (sort.nulls === "first" ? -1 : 1) : (sort.nulls === "first" ? 1 : -1); } const result = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv, sort.locale) : av < bv ? -1 : av > bv ? 1 : 0; if (result) return sort.direction === "asc" ? result : -result; } return a.index - b.index; }).map(x => x.page); }
