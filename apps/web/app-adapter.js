import { normalizeWorkspaceV1 } from "./workspace-v1.js";

/**
 * @typedef {{schemaVersion: 1, pages: Array<object>, activePageId: string|null}} WebWorkspaceV1
 * @typedef {{kind: "tauri"|"browser-development", durable: boolean, load(): Promise<WebWorkspaceV1>, save(workspace: WebWorkspaceV1): Promise<void>}} MotionUiAdapter
 */

const EMPTY_WORKSPACE = Object.freeze({ schemaVersion: 1, pages: [], activePageId: null });
const NATIVE_EXECUTE_OPERATIONS = Object.freeze([
  "workspace.create",
  "page.create", "page.rename", "page.move", "page.reorder", "page.set-favourite", "page.trash", "page.restore", "page.replace-blocks",
  "block.create", "block.update-content", "block.transform", "block.move", "block.indent", "block.outdent", "block.duplicate", "block.delete", "block.batch",
  "database.create", "database.property-add", "database.property-update", "database.property-delete", "database.record-create", "database.record-update", "database.view-update"
]);
const nativeExecuteOperations = new Set(NATIVE_EXECUTE_OPERATIONS);
const DB_NAME = "motion-web-development";
const STORE_NAME = "workspace";
const WORKSPACE_KEY = "default";
const UI_STATE_FIELDS = new Set(["workspaceId", "activePageId", "expandedPageIds"]);
const UI_STATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function validUiState(value) {
  const validId = id => id === null || (typeof id === "string" && UI_STATE_ID.test(id));
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !UI_STATE_FIELDS.has(key))
      || !validId(value.workspaceId ?? null) || !validId(value.activePageId ?? null)
      || (value.expandedPageIds !== undefined && (!Array.isArray(value.expandedPageIds)
        || value.expandedPageIds.length > 256 || value.expandedPageIds.some(id => typeof id !== "string" || !validId(id))
        || new Set(value.expandedPageIds).size !== value.expandedPageIds.length))) {
    throw new TypeError("Invalid UI state request");
  }
  return { workspaceId: value.workspaceId ?? null, activePageId: value.activePageId ?? null, expandedPageIds: value.expandedPageIds ?? [] };
}

function validWorkspace(value) {
  if (value === undefined) return structuredClone(EMPTY_WORKSPACE);
  if (value?.schemaVersion === 2 && (value.workspace === null || (value.workspace && Array.isArray(value.workspace.pages) && Array.isArray(value.workspace.databases)))) return structuredClone(value);
  return normalizeWorkspaceV1(value);
}

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
    async importWebV1(document) { const imported=validWorkspace(document); await transact("readwrite", store => store.put(imported, WORKSPACE_KEY)); return imported; },
    async saveUi() {},
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
  const advanceWorkspaceSummary = result => {
    if (result?.workspace?.id && Number.isSafeInteger(result.revision)
        && (!workspaceSummary || workspaceSummary.id !== result.workspace.id || result.revision > workspaceSummary.revision)) {
      workspaceSummary = { id: result.workspace.id, revision: result.revision };
    }
  };
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
      const loaded = await invoke("motion_ui_load", { request: { schemaVersion: 2 } });
      if (loaded?.schemaVersion !== 2) throw new Error("Native Motion returned an unsupported UI document");
      workspaceSummary = loaded.workspace ? { id: loaded.workspace.id, revision: loaded.revision } : undefined;
      return loaded;
    },
    async execute(type, payload = {}) {
      if (!nativeExecuteOperations.has(type)) throw new Error(`Unsupported native command: ${String(type)}`);
      if (type === "workspace.create") {
        const result = await dispatch("command", { ...payload, type });
        advanceWorkspaceSummary(result);
        return result;
      }
      const current = await requiredWorkspace();
      const result = await dispatch("command", { ...payload, type, workspaceId: current.id, expectedRevision: current.revision });
      advanceWorkspaceSummary(result);
      return result;
    },
    async saveUi(uiState) {
      await invoke("motion_ui_save", { request: { document: validUiState(uiState), schemaVersion: 2 } });
    },
    async save() {
      throw new Error("Native whole-workspace save is unavailable; use typed commands or explicit Web-v1 import");
    },
    async importWebV1(document) {
      const candidate = normalizeWorkspaceV1(document);
      const result = await dispatch("web-v1-import", { type: "workspace.import-web-v1", document: candidate });
      workspaceSummary = { id: result.workspace.id, revision: result.revision };
      return result;
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
      advanceWorkspaceSummary(result);
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

export { EMPTY_WORKSPACE, NATIVE_EXECUTE_OPERATIONS };
