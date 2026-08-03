export const WORKSPACE_SCHEMA_VERSION = 2 as const;
export type ID = string;
export type ISODate = string;
export type Scalar = string | number | boolean | null;

export interface Attachment { id: ID; fileName: string; mediaType: string; byteLength: number; sha256: string; path: string; createdAt: ISODate }

export type KnownBlockType = "paragraph" | "heading-1" | "heading-2" | "heading-3" | "bulleted-list" | "numbered-list" | "task" | "toggle" | "quote" | "callout" | "divider" | "code" | "image" | "file" | "bookmark" | "child-page" | "page-mention" | "date-mention" | "simple-table" | "collection-view" | "unsupported";
/** String remains open so newer clients' blocks survive load/save on older clients. */
export type BlockType = KnownBlockType | (string & {});
export interface PageReference { pageId: ID; start?: number; end?: number }
export interface Block {
  id: ID; type: BlockType; text: string; children: Block[];
  checked?: boolean; language?: string; attachmentId?: ID; headingLevel?: 1 | 2 | 3;
  pageId?: ID; viewId?: ID; date?: ISODate; url?: string;
  references?: PageReference[];
  /** Opaque payload retained for an unrecognised/imported block. */
  unknownData?: Record<string, unknown>;
}

export interface Page {
  id: ID; parentId: ID | null; title: string; blocks: Block[]; createdAt: ISODate; updatedAt: ISODate;
  icon?: string; cover?: string; createdBy?: ID; updatedBy?: ID; archivedAt?: ISODate;
  deletedAt?: ISODate; favourite?: boolean; templateOriginId?: ID; collectionId?: ID;
  properties?: Record<ID, PropertyValue>; permissions?: Record<string, unknown>;
}

export type PropertyType = "title" | "plain-text" | "rich-text" | "number" | "checkbox" | "select" | "multi-select" | "status" | "date" | "date-range" | "url" | "email" | "phone" | "files" | "created-time" | "updated-time" | "created-by" | "updated-by" | "relation" | "text" | "page";
export interface RelationConfig { targetCollectionId: ID; reciprocalPropertyId?: ID; cardinality?: "one-to-one" | "one-to-many" | "many-to-many"; maxItems?: number; onDelete?: "retain" | "remove" }
export interface DatabaseProperty { id: ID; name: string; type: PropertyType; relation?: RelationConfig; relationDatabaseId?: ID; options?: { id: ID; name: string; color?: string }[] }
export interface DateRange { start: ISODate; end?: ISODate }
export type PropertyValue = Scalar | string[] | DateRange | { attachmentIds: ID[] };
/** A record's identity and content live in its Page; this object only retains legacy row compatibility. */
export interface DatabaseRow { id: ID; pageId?: ID; values: Record<ID, PropertyValue>; createdAt: ISODate; updatedAt: ISODate }
export type DatabaseViewType = "table" | "list" | "board" | "calendar" | "gallery" | "timeline" | "chart" | "form";
export type FilterOperator = "equals" | "not-equals" | "contains" | "not-contains" | "gt" | "gte" | "lt" | "lte" | "before" | "after" | "is-empty" | "is-not-empty" | "in" | "relative-date";
export type FilterExpression = { kind: "condition"; propertyId: ID; operator: FilterOperator; value?: PropertyValue } | { kind: "and" | "or"; children: FilterExpression[] } | { kind: "not"; child: FilterExpression };
export interface SortClause { propertyId: ID; direction: "asc" | "desc"; nulls?: "first" | "last"; locale?: string }
export interface DatabaseView {
  id: ID; collectionId?: ID; name: string; type: DatabaseViewType; visiblePropertyIds: ID[];
  propertyOrder?: ID[]; columnWidths?: Record<ID, number>; filters?: FilterExpression; sorts?: SortClause[];
  groupByPropertyId?: ID; subgroupByPropertyId?: ID; layout?: Record<string, unknown>; cardPreview?: Record<string, unknown>;
  calendarDatePropertyId?: ID; timelineStartPropertyId?: ID; timelineEndPropertyId?: ID;
  permissions?: Record<string, unknown>; scope?: "personal" | "shared";
}
export interface Database { id: ID; pageId: ID; name: string; properties: DatabaseProperty[]; rows: DatabaseRow[]; recordPageIds?: ID[]; views: DatabaseView[] }
export interface PageLink { sourcePageId: ID; targetPageId: ID; blockId: ID }
export interface Workspace { schemaVersion: typeof WORKSPACE_SCHEMA_VERSION; id: ID; name: string; pages: Page[]; databases: Database[]; attachments: Attachment[]; linkIndex: PageLink[]; createdAt: ISODate; updatedAt: ISODate }

export function migrateWorkspace(input: unknown): Workspace {
  if (!input || typeof input !== "object") throw new Error("Workspace must be an object");
  if ((input as Record<string, unknown>).schemaVersion === 1) {
    const raw = structuredClone(input) as Record<string, any>;
    raw.schemaVersion = 2; raw.linkIndex = [];
    for (const page of raw.pages ?? []) for (const block of flatten(page.blocks ?? [])) {
      const aliases: Record<string, string> = { heading: "heading-2", todo: "task", attachment: "file" };
      block.type = aliases[block.type] ?? block.type;
    }
    for (const db of raw.databases ?? []) db.recordPageIds ??= (db.rows ?? []).map((r: DatabaseRow) => r.pageId).filter(Boolean);
    return raw as Workspace;
  }
  const raw = input as Record<string, any>;
  if (raw.schemaVersion !== 2) throw new Error(`Unsupported workspace schema: ${String(raw.schemaVersion)}`);
  raw.linkIndex ??= [];
  return raw as Workspace;
}
function flatten(blocks: Block[]): Block[] { return blocks.flatMap(block => [block, ...flatten(block.children ?? [])]); }

export function assertWorkspace(value: unknown): asserts value is Workspace {
  // Kept as the public compatibility entry point; the implementation lives in
  // validation.ts so loading and import boundaries use identical rules.
  assertWorkspaceValue(value);
}

import { assertWorkspaceValue } from "./validation.js";
