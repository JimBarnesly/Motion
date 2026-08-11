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

type PayloadFor<T extends NativeBlockOperation["type"]> = Omit<Extract<NativeBlockOperation, { type: T }>, "type">;
export interface NativeCommandPayloads {
  "workspace.create": { name: string };
  "page.rename": { pageId: string; title: string };
  "page.replace-blocks": { pageId: string; blocks: readonly NativeBlock[] };
  "database.record-update": { pageId: string; title?: string; values: Record<string, unknown> };
  "database.view-update": { databaseId: string; viewId: string; patch: Record<string, unknown> };
  "block.create": PayloadFor<"block.create">;
  "block.update-content": PayloadFor<"block.update-content">;
  "block.transform": PayloadFor<"block.transform">;
  "block.move": PayloadFor<"block.move">;
  "block.indent": PayloadFor<"block.indent">;
  "block.outdent": PayloadFor<"block.outdent">;
  "block.duplicate": PayloadFor<"block.duplicate">;
  "block.delete": PayloadFor<"block.delete">;
  "block.batch": { commands: readonly NativeBlockOperation[] };
}

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
  saveUi(uiState: unknown): Promise<void>;
  search(query: string, limit?: number): Promise<NativeSearchHit[] | null>;
  exportWorkspace(): Promise<NativeFullExport | null>;
  putAttachment(input: { fileName: string; mediaType: string; sha256: string; bytes: Uint8Array }): Promise<Record<string, unknown>>;
  createBackup(): Promise<Record<string, unknown>>;
  verifyBackup(bundle: unknown): Promise<Record<string, unknown>>;
  previewBackup(bundle: unknown): Promise<Record<string, unknown>>;
  restoreBackup(bundle: unknown): Promise<Record<string, unknown>>;
  saveBackup(bundle: unknown): Promise<{saved: boolean; cancelled: boolean; replaced?: boolean; byteLength?: number}>;
}

export interface TauriMotionUiAdapter extends MotionUiAdapterBase {
  readonly kind: "tauri";
  execute<C extends keyof NativeCommandPayloads>(type: C, payload: NativeCommandPayloads[C]): Promise<NativeCommandResults[C]>;
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
