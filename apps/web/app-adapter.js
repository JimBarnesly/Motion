import { normalizeWorkspaceV1 } from "./workspace-v1.js";

/**
 * @typedef {{schemaVersion: 1, pages: Array<object>, activePageId: string|null}} WebWorkspaceV1
 * @typedef {{kind: "tauri"|"browser-development", durable: boolean, load(): Promise<WebWorkspaceV1>, save(workspace: WebWorkspaceV1): Promise<void>}} MotionUiAdapter
 */

const EMPTY_WORKSPACE = Object.freeze({ schemaVersion: 1, pages: [], activePageId: null });
const DB_NAME = "motion-web-development";
const STORE_NAME = "workspace";
const WORKSPACE_KEY = "default";

function validWorkspace(value) { return value === undefined ? structuredClone(EMPTY_WORKSPACE) : normalizeWorkspaceV1(value); }

function openDevelopmentDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function browserDevelopmentAdapter() {
  const transact = async (mode, action) => {
    const database = await openDevelopmentDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = action(transaction.objectStore(STORE_NAME));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    } finally {
      database.close();
    }
  };
  const nativeOnly = async () => { throw new Error("Attachments and verified backups require the native Motion application"); };
  return {
    kind: "browser-development",
    durable: true,
    async load() { return validWorkspace(await transact("readonly", store => store.get(WORKSPACE_KEY))); },
    async save(workspace) { await transact("readwrite", store => store.put(validWorkspace(workspace), WORKSPACE_KEY)); },
    async search() { return null; },
    async exportWorkspace() { return null; },
    putAttachment: nativeOnly,
    createBackup: nativeOnly,
    saveBackup: nativeOnly,
    verifyBackup: nativeOnly,
    previewBackup: nativeOnly,
    restoreBackup: nativeOnly
  };
}

function tauriAdapter(invoke) {
  let workspaceSummary;
  const dispatch = (lane, payload) => invoke("app_dispatch", { request: { protocolVersion: 1, lane, payload } });
  const requiredWorkspace = async () => {
    if (workspaceSummary) return workspaceSummary;
    const workspaces = await dispatch("query", { type: "workspace.list" });
    workspaceSummary = workspaces?.[0];
    if (!workspaceSummary?.id || !Number.isSafeInteger(workspaceSummary.revision)) throw new Error("Create a workspace before using this native operation");
    return workspaceSummary;
  };
  return {
    kind: "tauri",
    durable: true,
    async load() {
      return validWorkspace(await invoke("motion_ui_load", { request: { schemaVersion: 1 } }));
    },
    async save(workspace) {
      await invoke("motion_ui_save", { request: { document: validWorkspace(workspace), schemaVersion: 1 } });
      workspaceSummary = undefined;
    },
    async search(query, limit = 50) {
      return dispatch("query", { type: "workspace.search", workspaceId: (await requiredWorkspace()).id, query, limit });
    },
    async exportWorkspace() {
      return dispatch("query", { type: "workspace.export", workspaceId: (await requiredWorkspace()).id });
    },
    async putAttachment({ fileName, mediaType, sha256, bytes }) {
      const current = await requiredWorkspace();
      const result = await dispatch("async-command", { type: "attachment.put", workspaceId: current.id, expectedRevision: current.revision, fileName, mediaType, sha256, bytes: { $motionBytes: Array.from(bytes) } });
      workspaceSummary = { ...current, revision: result.revision };
      return result;
    },
    async createBackup() { return dispatch("async-query", { type: "backup.create", workspaceId: (await requiredWorkspace()).id }); },
    async saveBackup(bundle) { return invoke("motion_backup_save", { request: { schemaVersion: 1, bundle } }); },
    async verifyBackup(bundle) { return dispatch("async-query", { type: "backup.verify", bundle }); },
    async previewBackup(bundle) { return dispatch("async-query", { type: "backup.preview", bundle }); },
    async restoreBackup(bundle) {
      const result = await dispatch("async-command", { type: "backup.restore-new", bundle });
      workspaceSummary = result?.workspace?.id ? { id: result.workspace.id, revision: result.revision } : undefined;
      return result;
    }
  };
}

/** @returns {MotionUiAdapter} */
export function createMotionUiAdapter(runtime = window) {
  const invoke = runtime.__TAURI__?.core?.invoke ?? runtime.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === "function" ? tauriAdapter(invoke) : browserDevelopmentAdapter();
}

export { EMPTY_WORKSPACE };
