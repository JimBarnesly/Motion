import { WORKSPACE_SCHEMA_VERSION, type Block, type Database, type Page, type PageLink, type Workspace } from "../model.js";
import { assertWorkspaceValue } from "../validation.js";

const EPOCH = "1970-01-01T00:00:00.000Z";
export interface WebV1UiState { activePageId: string | null }
export interface WebV1MigrationResult { workspace: Workspace; uiState: WebV1UiState }
export interface WebV1MigrationOptions { workspaceId?: string; workspaceName?: string; migratedAt?: string }
type JsonObject = Record<string, any>;
const plain = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const requiredString = (value: unknown, path: string) => { if (typeof value !== "string" || !value) throw new Error(`Invalid web v1 workspace: ${path}`); return value; };
const aliases: Record<string, Block["type"]> = { heading1: "heading-1", heading2: "heading-2", heading3: "heading-3", bullet: "bulleted-list", number: "numbered-list" };

export function migrateWebWorkspaceV1(input: unknown, options: WebV1MigrationOptions = {}): WebV1MigrationResult {
  if (!plain(input) || input.schemaVersion !== 1 || !Array.isArray(input.pages)) throw new Error("Invalid web v1 workspace root");
  const rawPages = input.pages as JsonObject[];
  const pageIds = new Set(rawPages.map((page, index) => requiredString(page?.id, `pages[${index}].id`)));
  if (pageIds.size !== rawPages.length) throw new Error("Invalid web v1 workspace: duplicate page ID");
  const titleMap = new Map<string, string>();
  for (const page of rawPages) if (typeof page.title === "string" && !titleMap.has(page.title.trim().toLocaleLowerCase())) titleMap.set(page.title.trim().toLocaleLowerCase(), page.id);
  const databases: Database[] = [];
  const pages: Page[] = rawPages.map((raw, pageIndex) => {
    if (!plain(raw)) throw new Error(`Invalid web v1 workspace: pages[${pageIndex}]`);
    const parentId = raw.parentId === null || raw.parentId === undefined ? null : requiredString(raw.parentId, `pages[${pageIndex}].parentId`);
    if (parentId !== null && !pageIds.has(parentId)) throw new Error(`Invalid web v1 workspace: missing parent ${parentId}`);
    const blocks: Block[] = [];
    for (const [blockIndex, source] of (Array.isArray(raw.blocks) ? raw.blocks : []).entries()) {
      if (!plain(source)) throw new Error(`Invalid web v1 workspace: pages[${pageIndex}].blocks[${blockIndex}]`);
      const originalType = requiredString(source.type, `pages[${pageIndex}].blocks[${blockIndex}].type`);
      const known = new Set(["paragraph", "heading1", "heading2", "heading3", "bullet", "number", "task", "toggle", "quote", "code", "divider"]);
      const text = typeof source.text === "string" ? source.text : "";
      const references = (Array.isArray(source.links) ? source.links : []).flatMap(link => plain(link) && typeof link.pageId === "string" && pageIds.has(link.pageId) ? [{ pageId: link.pageId }] : []);
      for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) { const target = titleMap.get(match[1].trim().toLocaleLowerCase()); if (target && !references.some(ref => ref.pageId === target)) references.push({ pageId: target }); }
      blocks.push({ id: requiredString(source.id, `pages[${pageIndex}].blocks[${blockIndex}].id`), type: known.has(originalType) ? (aliases[originalType] ?? originalType) : "unsupported", text, children: [], checked: originalType === "task" ? Boolean(source.checked) : undefined, references: references.length ? references : undefined, unknownData: known.has(originalType) ? undefined : { importedType: originalType, source: structuredClone(source) } });
    }
    if (raw.type === "database") {
      const properties = (Array.isArray(raw.columns) ? raw.columns : []).map((column, columnIndex) => { if (!plain(column)) throw new Error(`Invalid web v1 column ${columnIndex}`); return { id: requiredString(column.id, `column.id`), name: typeof column.name === "string" ? column.name : "", type: "plain-text" as const }; });
      databases.push({ id: `database:${raw.id}`, pageId: raw.id, name: typeof raw.title === "string" ? raw.title : "", properties, rows: (Array.isArray(raw.rows) ? raw.rows : []).map((row, rowIndex) => { if (!plain(row) || !plain(row.values)) throw new Error(`Invalid web v1 row ${rowIndex}`); return { id: requiredString(row.id, `row.id`), values: structuredClone(row.values), createdAt: EPOCH, updatedAt: EPOCH }; }), views: [{ id: `view:${raw.id}:table`, collectionId: `database:${raw.id}`, name: "Table", type: "table", visiblePropertyIds: properties.map(property => property.id) }] });
    }
    return { id: raw.id, parentId, title: typeof raw.title === "string" ? raw.title : "", blocks, createdAt: EPOCH, updatedAt: EPOCH, archivedAt: raw.archived ? EPOCH : undefined, deletedAt: raw.deleted ? EPOCH : undefined };
  });
  const linkIndex: PageLink[] = [];
  for (const page of pages) for (const block of page.blocks) for (const ref of block.references ?? []) linkIndex.push({ sourcePageId: page.id, targetPageId: ref.pageId, blockId: block.id });
  linkIndex.sort((a, b) => a.sourcePageId.localeCompare(b.sourcePageId) || a.blockId.localeCompare(b.blockId) || a.targetPageId.localeCompare(b.targetPageId));
  const migratedAt = options.migratedAt ?? EPOCH;
  const workspace: Workspace = { schemaVersion: WORKSPACE_SCHEMA_VERSION, id: options.workspaceId ?? "web-workspace-v1", name: options.workspaceName ?? "Motion Workspace", pages, databases, attachments: [], linkIndex, createdAt: migratedAt, updatedAt: migratedAt };
  assertWorkspaceValue(workspace);
  const activePageId = typeof input.activePageId === "string" && pageIds.has(input.activePageId) && !rawPages.find(page => page.id === input.activePageId)?.deleted ? input.activePageId : null;
  return { workspace, uiState: { activePageId } };
}
