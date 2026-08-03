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
}

export interface MotionUiRuntime {
  __TAURI__?: { core?: { invoke(command: string, payload: unknown): Promise<unknown> } };
  __TAURI_INTERNALS__?: { invoke(command: string, payload: unknown): Promise<unknown> };
}

export declare function createMotionUiAdapter(runtime?: MotionUiRuntime): MotionUiAdapter;
export declare const EMPTY_WORKSPACE: Readonly<WebWorkspaceV1>;
