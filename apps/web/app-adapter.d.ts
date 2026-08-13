export interface WebWorkspaceV1 {
  schemaVersion: 1;
  pages: Array<Record<string, unknown>>;
  activePageId: string | null;
}

export interface NativeBlockReference { pageId: string; start?: number; end?: number }
export interface NativeBlock {
  id: string;
  type: string;
  text: string;
  children: NativeBlock[];
  checked?: boolean;
  language?: string;
  attachmentId?: string;
  headingLevel?: 1 | 2 | 3;
  pageId?: string;
  viewId?: string;
  date?: string;
  url?: string;
  references?: NativeBlockReference[];
  unknownData?: Record<string, unknown>;
}
export interface NativeBlockSiblingPosition { parentBlockId: string | null; beforeBlockId: string | null }
export interface NativeBlockPosition extends NativeBlockSiblingPosition { pageId: string }
export interface NativeBlockTransform {
  type: string;
  checked?: boolean;
  language?: string;
  attachmentId?: string;
  headingLevel?: 1 | 2 | 3;
  pageId?: string;
  viewId?: string;
  date?: string;
  url?: string;
}
export type NativeBlockOperation =
  | { type: "block.create"; pageId: string; position: NativeBlockSiblingPosition; block: NativeBlock }
  | { type: "block.update-content"; pageId: string; blockId: string; content: { text: string; references?: NativeBlockReference[] } }
  | { type: "block.transform"; pageId: string; blockId: string; transform: NativeBlockTransform }
  | { type: "block.move"; pageId: string; blockId: string; target: NativeBlockPosition }
  | { type: "block.indent"; pageId: string; blockId: string }
  | { type: "block.outdent"; pageId: string; blockId: string }
  | { type: "block.delete"; pageId: string; blockId: string }
  | { type: "block.duplicate"; pageId: string; blockId: string; newBlockId: string };

export type NativePropertyValue = string | number | boolean | null | string[] | { start: string; end?: string } | { attachmentIds: string[] };
export type NativeDatabasePropertyType = "title" | "plain-text" | "rich-text" | "number" | "checkbox" | "select" | "multi-select" | "status" | "date" | "date-range" | "url" | "email" | "phone" | "files" | "created-time" | "updated-time" | "created-by" | "updated-by" | "relation" | "text" | "page";
export interface NativeDatabasePropertyInput {
  name: string;
  type: NativeDatabasePropertyType;
  relation?: { targetCollectionId: string; reciprocalPropertyId?: string; cardinality?: "one-to-one" | "one-to-many" | "many-to-many"; maxItems?: number; onDelete?: "retain" | "remove" };
  relationDatabaseId?: string;
  options?: Array<{ id: string; name: string; color?: string }>;
}
export type NativeDatabasePropertyPatch = Partial<NativeDatabasePropertyInput>;
export type NativeFilterOperator = "equals" | "not-equals" | "contains" | "not-contains" | "gt" | "gte" | "lt" | "lte" | "before" | "after" | "is-empty" | "is-not-empty" | "in" | "relative-date";
export type NativeFilterExpression =
  | { kind: "condition"; propertyId: string; operator: NativeFilterOperator; value?: NativePropertyValue }
  | { kind: "and" | "or"; children: NativeFilterExpression[] }
  | { kind: "not"; child: NativeFilterExpression };
export type NativeDatabaseViewType = "table" | "list" | "board" | "calendar" | "gallery" | "timeline" | "chart" | "form";
export interface NativeDatabaseViewPatch {
  name?: string;
  visiblePropertyIds?: string[];
  propertyOrder?: string[];
  columnWidths?: Record<string, number>;
  filters?: NativeFilterExpression;
  sorts?: Array<{ propertyId: string; direction: "asc" | "desc"; nulls?: "first" | "last"; locale?: string }>;
  groupByPropertyId?: string;
  subgroupByPropertyId?: string;
  layout?: Record<string, unknown>;
  cardPreview?: Record<string, unknown>;
  calendarDatePropertyId?: string;
  timelineStartPropertyId?: string;
  timelineEndPropertyId?: string;
  permissions?: Record<string, unknown>;
  scope?: "personal" | "shared";
}

type PayloadFor<T extends NativeBlockOperation["type"]> = Omit<Extract<NativeBlockOperation, { type: T }>, "type">;
export interface NativeCommandPayloads {
  "workspace.create": { name: string };
  "page.create": { title: string; parentId?: string | null };
  "page.rename": { pageId: string; title: string };
  "page.move": { pageId: string; parentId: string | null };
  "page.reorder": { pageId: string; beforePageId: string | null };
  "page.set-favourite": { pageId: string; favourite: boolean };
  "page.trash": { pageId: string };
  "page.restore": { pageId: string };
  "page.replace-blocks": { pageId: string; blocks: readonly NativeBlock[] };
  "block.create": PayloadFor<"block.create">;
  "block.update-content": PayloadFor<"block.update-content">;
  "block.transform": PayloadFor<"block.transform">;
  "block.move": PayloadFor<"block.move">;
  "block.indent": PayloadFor<"block.indent">;
  "block.outdent": PayloadFor<"block.outdent">;
  "block.duplicate": PayloadFor<"block.duplicate">;
  "block.delete": PayloadFor<"block.delete">;
  "block.batch": { commands: readonly NativeBlockOperation[] };
  "database.create": { title: string; parentId?: string | null };
  "database.property-add": { databaseId: string; property: NativeDatabasePropertyInput };
  "database.property-update": { databaseId: string; propertyId: string; patch: NativeDatabasePropertyPatch };
  "database.property-delete": { databaseId: string; propertyId: string };
  "database.record-create": { databaseId: string; title: string; values?: Record<string, NativePropertyValue> };
  "database.record-update": { pageId: string; title?: string; values: Record<string, NativePropertyValue | undefined> };
  "database.view-create": { databaseId: string; view: NativeDatabaseViewPatch & { id?: string; name: string; type: NativeDatabaseViewType; visiblePropertyIds: string[] } };
  "database.view-update": { databaseId: string; viewId: string; patch: NativeDatabaseViewPatch };
  "database.view-duplicate": { databaseId: string; viewId: string; name?: string; newViewId?: string };
  "database.view-reorder": { databaseId: string; viewId: string; beforeViewId: string | null };
  "database.view-delete": { databaseId: string; viewId: string };
}

export declare const NATIVE_EXECUTE_OPERATIONS: readonly [
  "workspace.create",
  "page.create", "page.rename", "page.move", "page.reorder", "page.set-favourite", "page.trash", "page.restore", "page.replace-blocks",
  "block.create", "block.update-content", "block.transform", "block.move", "block.indent", "block.outdent", "block.duplicate", "block.delete", "block.batch",
  "database.create", "database.property-add", "database.property-update", "database.property-delete", "database.record-create", "database.record-update",
  "database.view-create", "database.view-update", "database.view-duplicate", "database.view-reorder", "database.view-delete"
];
export type NativeExecuteOperation = typeof NATIVE_EXECUTE_OPERATIONS[number];
type AssertTrue<T extends true> = T;
type ExactCommandKeys = [Exclude<NativeExecuteOperation, keyof NativeCommandPayloads>, Exclude<keyof NativeCommandPayloads, NativeExecuteOperation>] extends [never, never] ? true : false;
export type NativeCommandContractAssertion = AssertTrue<ExactCommandKeys>;

export interface NativeMutationResult {
  workspace: Readonly<Record<string, unknown> & { id: string }>;
  revision: number;
  saved: true;
}
export type NativeCommandResults = { [K in keyof NativeCommandPayloads]: NativeMutationResult };

interface MotionUiAdapterBase {
  readonly durable: true;
  load(): Promise<WebWorkspaceV1>;
  save(workspace: WebWorkspaceV1): Promise<void>;
  importWebV1(document: WebWorkspaceV1): Promise<unknown>;
  saveUi(uiState: unknown): Promise<void>;
  search(query: string, limit?: number): Promise<NativeSearchHit[] | null>;
  exportWorkspace(): Promise<NativeFullExport | null>;
  ingestAttachmentBlock(input: { pageId: string; position: { parentBlockId: string | null; beforeBlockId: string | null }; fileName: string; mediaType: string; sha256: string; bytes: Uint8Array }): Promise<Record<string, unknown>>;
  readAttachment(attachmentId: string): Promise<{ attachment: { fileName: string; mediaType: string }; bytes: Uint8Array }>;
  createBackup(): Promise<Record<string, unknown>>;
  verifyBackup(bundle: unknown): Promise<Record<string, unknown>>;
  previewBackup(bundle: unknown): Promise<Record<string, unknown>>;
  restoreBackup(bundle: unknown): Promise<Record<string, unknown>>;
  saveBackup(bundle: unknown): Promise<{saved: boolean; cancelled: boolean; replaced?: boolean; byteLength?: number}>;
}

export interface TauriMotionUiAdapter extends MotionUiAdapterBase {
  readonly kind: "tauri";
  execute<C extends keyof NativeCommandPayloads>(type: C, payload: NativeCommandPayloads[C]): Promise<NativeCommandResults[C]>;
  importWebV1(document: WebWorkspaceV1): Promise<NativeMutationResult & { activePageId: string | null }>;
}
export interface BrowserDevelopmentMotionUiAdapter extends MotionUiAdapterBase { readonly kind: "browser-development" }
export type MotionUiAdapter = TauriMotionUiAdapter | BrowserDevelopmentMotionUiAdapter;

export interface NativeSearchHit {
  workspaceId: string;
  entityId: string;
  entityType: "page" | "block" | "row" | "entity";
  ownerEntityId?: string;
  title: string;
  snippet: string;
}
export interface NativeFullExport { schemaVersion: 1; files: Record<string, string>; attachments: Array<{ archivePath: string; sourcePath: string; sha256: string; byteLength: number }> }

export interface MotionUiRuntime {
  __TAURI__?: { core?: { invoke(command: string, payload: unknown): Promise<unknown> } };
  __TAURI_INTERNALS__?: { invoke(command: string, payload: unknown): Promise<unknown> };
}

export declare function createMotionUiAdapter(runtime?: MotionUiRuntime): MotionUiAdapter;
export declare const EMPTY_WORKSPACE: Readonly<WebWorkspaceV1>;
