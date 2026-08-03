export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export type ID = string;
export type ISODate = string;
export type Scalar = string | number | boolean | null;

export interface Attachment {
  id: ID;
  fileName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  /** Path relative to the workspace attachment root. */
  path: string;
  createdAt: ISODate;
}

export type BlockType = "paragraph" | "heading" | "quote" | "code" | "todo" | "bulleted-list" | "numbered-list" | "attachment";
export interface Block {
  id: ID;
  type: BlockType;
  text: string;
  checked?: boolean;
  language?: string;
  attachmentId?: ID;
  children: Block[];
}

export interface Page {
  id: ID;
  parentId: ID | null;
  title: string;
  blocks: Block[];
  createdAt: ISODate;
  updatedAt: ISODate;
  archivedAt?: ISODate;
}

export type PropertyType = "text" | "number" | "checkbox" | "date" | "select" | "multi-select" | "relation" | "page";
export interface DatabaseProperty { id: ID; name: string; type: PropertyType; relationDatabaseId?: ID }
export type PropertyValue = Scalar | string[];
export interface DatabaseRow { id: ID; values: Record<ID, PropertyValue>; createdAt: ISODate; updatedAt: ISODate }
export type DatabaseViewType = "table" | "board" | "list" | "calendar";
export interface DatabaseView { id: ID; name: string; type: DatabaseViewType; visiblePropertyIds: ID[]; groupByPropertyId?: ID }
export interface Database { id: ID; pageId: ID; name: string; properties: DatabaseProperty[]; rows: DatabaseRow[]; views: DatabaseView[] }

export interface Workspace {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  id: ID;
  name: string;
  pages: Page[];
  databases: Database[];
  attachments: Attachment[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface PageLink { sourcePageId: ID; targetPageId: ID; blockId: ID }

export function assertWorkspace(value: unknown): asserts value is Workspace {
  if (!value || typeof value !== "object") throw new Error("Workspace must be an object");
  const w = value as Partial<Workspace>;
  if (w.schemaVersion !== WORKSPACE_SCHEMA_VERSION) throw new Error(`Unsupported workspace schema: ${String(w.schemaVersion)}`);
  if (!w.id || !w.name || !Array.isArray(w.pages) || !Array.isArray(w.databases) || !Array.isArray(w.attachments)) {
    throw new Error("Invalid workspace structure");
  }
  const pageIds = new Set(w.pages.map(p => p.id));
  for (const page of w.pages) {
    if (page.parentId !== null && !pageIds.has(page.parentId)) throw new Error(`Missing parent ${page.parentId} for page ${page.id}`);
    let cursor: Page | undefined = page;
    const visited = new Set<ID>();
    while (cursor?.parentId) {
      if (visited.has(cursor.id)) throw new Error(`Page hierarchy cycle at ${cursor.id}`);
      visited.add(cursor.id);
      cursor = w.pages.find(p => p.id === cursor!.parentId);
    }
  }
}
