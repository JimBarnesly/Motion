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
  return {
    kind: "browser-development",
    durable: true,
    async load() { return validWorkspace(await transact("readonly", store => store.get(WORKSPACE_KEY))); },
    async save(workspace) { await transact("readwrite", store => store.put(validWorkspace(workspace), WORKSPACE_KEY)); },
    async search() { return null; },
    async exportWorkspace() { return null; }
  };
}

function tauriAdapter(invoke) {
  let workspaceId;
  const dispatch = (lane, payload) => invoke("app_dispatch", { request: { protocolVersion: 1, lane, payload } });
  const requiredWorkspaceId = async () => {
    if (workspaceId) return workspaceId;
    const workspaces = await dispatch("query", { type: "workspace.list" });
    workspaceId = workspaces?.[0]?.id;
    if (!workspaceId) throw new Error("Create a workspace before using native search or export");
    return workspaceId;
  };
  return {
    kind: "tauri",
    durable: true,
    async load() {
      return validWorkspace(await invoke("motion_ui_load", { schemaVersion: 1 }));
    },
    async save(workspace) {
      await invoke("motion_ui_save", { document: validWorkspace(workspace), schemaVersion: 1 });
      workspaceId = undefined;
    },
    async search(query, limit = 50) {
      return dispatch("query", { type: "workspace.search", workspaceId: await requiredWorkspaceId(), query, limit });
    },
    async exportWorkspace() {
      return dispatch("query", { type: "workspace.export", workspaceId: await requiredWorkspaceId() });
    }
  };
}

/** @returns {MotionUiAdapter} */
export function createMotionUiAdapter(runtime = window) {
  const invoke = runtime.__TAURI__?.core?.invoke ?? runtime.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === "function" ? tauriAdapter(invoke) : browserDevelopmentAdapter();
}

export { EMPTY_WORKSPACE };
