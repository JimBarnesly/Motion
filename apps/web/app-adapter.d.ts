export interface WebWorkspaceV1 {
  schemaVersion: 1;
  pages: Array<Record<string, unknown>>;
  activePageId: string | null;
}

export interface MotionUiAdapter {
  readonly kind: "tauri" | "browser-development";
  readonly durable: true;
  load(): Promise<WebWorkspaceV1>;
  save(workspace: WebWorkspaceV1): Promise<void>;
  search(query: string, limit?: number): Promise<NativeSearchHit[] | null>;
  exportWorkspace(): Promise<NativeFullExport | null>;
  putAttachment(input: { fileName: string; mediaType: string; sha256: string; bytes: Uint8Array }): Promise<Record<string, unknown>>;
  createBackup(): Promise<Record<string, unknown>>;
  verifyBackup(bundle: unknown): Promise<Record<string, unknown>>;
  previewBackup(bundle: unknown): Promise<Record<string, unknown>>;
  restoreBackup(bundle: unknown): Promise<Record<string, unknown>>;
}

export interface NativeSearchHit { workspaceId: string; entityId: string; title: string; snippet: string }
export interface NativeFullExport { schemaVersion: 1; files: Record<string, string>; attachments: Array<{ archivePath: string; sourcePath: string; sha256: string; byteLength: number }> }

export interface MotionUiRuntime {
  __TAURI__?: { core?: { invoke(command: string, payload: unknown): Promise<unknown> } };
  __TAURI_INTERNALS__?: { invoke(command: string, payload: unknown): Promise<unknown> };
}

export declare function createMotionUiAdapter(runtime?: MotionUiRuntime): MotionUiAdapter;
export declare const EMPTY_WORKSPACE: Readonly<WebWorkspaceV1>;
