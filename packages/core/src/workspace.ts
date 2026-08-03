import { WORKSPACE_SCHEMA_VERSION, assertWorkspace, type Block, type Database, type ID, type Page, type PageLink, type Workspace } from "./model.js";

const now = () => new Date().toISOString();
const id = () => globalThis.crypto.randomUUID();
const walk = (blocks: Block[], fn: (block: Block) => void) => blocks.forEach(b => { fn(b); walk(b.children, fn); });

export function createWorkspace(name: string): Workspace {
  const timestamp = now();
  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, id: id(), name, pages: [], databases: [], attachments: [], createdAt: timestamp, updatedAt: timestamp };
}

export class WorkspaceDocument {
  constructor(public readonly data: Workspace) { assertWorkspace(data); }

  addPage(title: string, parentId: ID | null = null): Page {
    if (parentId && !this.page(parentId)) throw new Error(`Parent page not found: ${parentId}`);
    const timestamp = now();
    const page = { id: id(), parentId, title, blocks: [], createdAt: timestamp, updatedAt: timestamp };
    this.data.pages.push(page); this.touch(); return page;
  }
  page(pageId: ID) { return this.data.pages.find(p => p.id === pageId); }
  children(parentId: ID | null) { return this.data.pages.filter(p => p.parentId === parentId); }
  movePage(pageId: ID, parentId: ID | null) {
    const page = this.requiredPage(pageId);
    if (parentId === pageId || (parentId && this.descendants(pageId).some(p => p.id === parentId))) throw new Error("Page hierarchy cannot contain cycles");
    if (parentId) this.requiredPage(parentId);
    page.parentId = parentId; page.updatedAt = now(); this.touch();
  }
  descendants(pageId: ID): Page[] { const direct = this.children(pageId); return direct.flatMap(p => [p, ...this.descendants(p.id)]); }
  addBlock(pageId: ID, block: Omit<Block, "id" | "children"> & { id?: ID; children?: Block[] }): Block {
    const result: Block = { ...block, id: block.id ?? id(), children: block.children ?? [] };
    const page = this.requiredPage(pageId); page.blocks.push(result); page.updatedAt = now(); this.touch(); return result;
  }
  addDatabase(database: Omit<Database, "id"> & { id?: ID }): Database {
    this.requiredPage(database.pageId);
    const result = { ...database, id: database.id ?? id() }; this.data.databases.push(result); this.touch(); return result;
  }
  links(): PageLink[] {
    const links: PageLink[] = [];
    for (const page of this.data.pages) walk(page.blocks, block => {
      for (const match of block.text.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const target = this.page(match[1]) ?? this.data.pages.find(p => p.title.toLocaleLowerCase() === match[1].toLocaleLowerCase());
        if (target) links.push({ sourcePageId: page.id, targetPageId: target.id, blockId: block.id });
      }
    });
    return links;
  }
  backlinks(pageId: ID) { this.requiredPage(pageId); return this.links().filter(link => link.targetPageId === pageId); }
  search(query: string): { page: Page; score: number; snippets: string[] }[] {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return this.data.pages.map(page => {
      const texts: string[] = []; walk(page.blocks, b => texts.push(b.text));
      const haystack = `${page.title}\n${texts.join("\n")}`.toLocaleLowerCase();
      const score = terms.reduce((n, term) => n + (page.title.toLocaleLowerCase().includes(term) ? 5 : 0) + haystack.split(term).length - 1, 0);
      return { page, score, snippets: texts.filter(t => terms.some(term => t.toLocaleLowerCase().includes(term))).slice(0, 3) };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt));
  }
  private requiredPage(pageId: ID) { const page = this.page(pageId); if (!page) throw new Error(`Page not found: ${pageId}`); return page; }
  private touch() { this.data.updatedAt = now(); }
}
