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

function decodeBinary(value) {
  if (Array.isArray(value)) return value.map(decodeBinary);
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && Array.isArray(value.$motionBytes)) return Uint8Array.from(value.$motionBytes);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeBinary(child)]));
  }
  return value;
}

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
    ingestAttachmentBlock: nativeOnly,
    readAttachment: nativeOnly,
    createBackup: nativeOnly,
    saveBackup: nativeOnly,
    verifyBackup: nativeOnly,
    previewBackup: nativeOnly,
    restoreBackup: nativeOnly
  };
}

function tauriAdapter(invoke) {
  let workspaceSummary;
  let workspaceEpoch = 0;
  let activeTransitionEpoch = null;
  let selectionRecoveryRequired = false;
  let selectionKnown = false;
  let selectionRecoveryPromise = null;
  let pendingUiSaves = 0;
  let uiSaveTail = Promise.resolve();
  const workspaceChanged = () => new Error("Native workspace changed while the operation was running");
  const assertCurrentWorkspace = (epoch, id) => {
    if (epoch !== workspaceEpoch || workspaceSummary?.id !== id) throw workspaceChanged();
  };
  const assertCurrentSelection = (epoch, id) => {
    if (epoch !== workspaceEpoch || (workspaceSummary?.id ?? null) !== id || activeTransitionEpoch !== null) throw workspaceChanged();
  };
  const advanceWorkspaceSummary = (result, current) => {
    if (result?.workspace?.id !== current.id || !Number.isSafeInteger(result.revision)
        || result.revision <= Math.max(current.revision, workspaceSummary?.revision ?? -1)) {
      throw new Error("Native mutation returned a non-monotonic workspace revision");
    }
    workspaceSummary = { id: current.id, revision: result.revision };
  };
  const dispatch = async (lane, payload) => decodeBinary(await invoke("app_dispatch", { request: { protocolVersion: 1, lane, payload } }));
  const validSummary = summary => typeof summary?.id === "string" && UI_STATE_ID.test(summary.id)
    && Number.isSafeInteger(summary.revision) && summary.revision >= 0;
  const transitionSummary = (result, allowEmpty) => {
    if (allowEmpty && result?.workspace === null && Number.isSafeInteger(result.revision) && result.revision >= 0) return undefined;
    const summary = { id: result?.workspace?.id, revision: result?.revision };
    if (!validSummary(summary)) {
      throw new Error("Native transition returned an invalid workspace summary");
    }
    return summary;
  };
  const transitionWorkspace = async (operation, allowEmpty = false) => {
    if (pendingUiSaves > 0) throw new Error("Native workspace selection update is running");
    const transitionEpoch = ++workspaceEpoch;
    activeTransitionEpoch = transitionEpoch;
    selectionRecoveryPromise = null;
    workspaceSummary = undefined;
    selectionKnown = false;
    try {
      const result = await operation();
      if (transitionEpoch !== workspaceEpoch || activeTransitionEpoch !== transitionEpoch) throw workspaceChanged();
      workspaceSummary = transitionSummary(result, allowEmpty);
      selectionRecoveryRequired = false;
      selectionKnown = true;
      activeTransitionEpoch = null;
      return result;
    } catch (error) {
      if (activeTransitionEpoch === transitionEpoch) {
        workspaceSummary = undefined;
        selectionRecoveryRequired = true;
        selectionKnown = false;
        activeTransitionEpoch = null;
      }
      throw error;
    }
  };
  const requiredWorkspace = async () => {
    if (activeTransitionEpoch !== null) throw workspaceChanged();
    if (workspaceSummary) return workspaceSummary;
    if (selectionKnown) throw new Error("Create a workspace before using this native operation");
    const discoveryEpoch = workspaceEpoch;
    if (selectionRecoveryRequired) {
      if (!selectionRecoveryPromise) {
        const recoveryEpoch = discoveryEpoch;
        const recovery = (async () => {
          const loaded = await invoke("motion_ui_load", { request: { schemaVersion: 2 } });
          if (recoveryEpoch !== workspaceEpoch || activeTransitionEpoch !== null) throw workspaceChanged();
          if (loaded?.schemaVersion !== 2) throw new Error("Native Motion returned an unsupported UI document");
          workspaceSummary = transitionSummary(loaded, true);
          selectionRecoveryRequired = false;
          selectionKnown = true;
          return workspaceSummary;
        })();
        selectionRecoveryPromise = recovery.finally(() => {
          if (selectionRecoveryPromise === recoveryWithCleanup) selectionRecoveryPromise = null;
        });
        const recoveryWithCleanup = selectionRecoveryPromise;
      }
      const recovered = await selectionRecoveryPromise;
      if (!recovered) throw new Error("Create a workspace before using this native operation");
      return recovered;
    }
    const workspaces = await dispatch("query", { type: "workspace.list" });
    if (discoveryEpoch !== workspaceEpoch) return requiredWorkspace();
    workspaceSummary = workspaces?.[0];
    if (!validSummary(workspaceSummary)) throw new Error("Create a workspace before using this native operation");
    selectionKnown = true;
    return workspaceSummary;
  };
  const dispatchCurrentWorkspace = async (lane, payload) => {
    const operationEpoch = workspaceEpoch;
    const current = await requiredWorkspace();
    assertCurrentWorkspace(operationEpoch, current.id);
    const result = await dispatch(lane, { ...payload, workspaceId: current.id });
    assertCurrentWorkspace(operationEpoch, current.id);
    return result;
  };
  return {
    kind: "tauri",
    durable: true,
    async load() {
      return transitionWorkspace(async () => {
        const loaded = await invoke("motion_ui_load", { request: { schemaVersion: 2 } });
        if (loaded?.schemaVersion !== 2) throw new Error("Native Motion returned an unsupported UI document");
        return loaded;
      }, true);
    },
    async execute(type, payload = {}) {
      const operationEpoch = workspaceEpoch;
      if (!nativeExecuteOperations.has(type)) throw new Error(`Unsupported native command: ${String(type)}`);
      if (type === "workspace.create") {
        return transitionWorkspace(() => dispatch("command", { ...payload, type }));
      }
      const current = await requiredWorkspace();
      assertCurrentWorkspace(operationEpoch, current.id);
      const result = await dispatch("command", { ...payload, type, workspaceId: current.id, expectedRevision: current.revision });
      assertCurrentWorkspace(operationEpoch, current.id);
      if (result?.workspace?.id !== current.id) throw workspaceChanged();
      advanceWorkspaceSummary(result, current);
      return result;
    },
    async saveUi(uiState) {
      if (activeTransitionEpoch !== null || selectionRecoveryRequired) throw workspaceChanged();
      const document = validUiState(uiState);
      const saveEpoch = workspaceEpoch;
      const workspaceId = workspaceSummary?.id ?? null;
      if (document.workspaceId !== workspaceId) throw workspaceChanged();
      pendingUiSaves += 1;
      const save = uiSaveTail.then(async () => {
        assertCurrentSelection(saveEpoch, workspaceId);
        await invoke("motion_ui_save", { request: { document, schemaVersion: 2 } });
        assertCurrentSelection(saveEpoch, workspaceId);
      });
      uiSaveTail = save.catch(() => {});
      try {
        await save;
      } finally {
        pendingUiSaves -= 1;
      }
    },
    async save() {
      throw new Error("Native whole-workspace save is unavailable; use typed commands or explicit Web-v1 import");
    },
    async importWebV1(document) {
      const candidate = normalizeWorkspaceV1(document);
      return transitionWorkspace(() => dispatch("web-v1-import", { type: "workspace.import-web-v1", document: candidate }));
    },
    async search(query, limit = 50) {
      return dispatchCurrentWorkspace("query", { type: "workspace.search", query, limit });
    },
    async exportWorkspace() {
      return dispatchCurrentWorkspace("query", { type: "workspace.export" });
    },
    async ingestAttachmentBlock({ pageId, position, fileName, mediaType, sha256, bytes }) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 3 * 1024 * 1024) throw new Error("Attachments must not exceed 3 MiB");
      const operationEpoch = workspaceEpoch;
      const current = await requiredWorkspace();
      assertCurrentWorkspace(operationEpoch, current.id);
      const result = await dispatch("async-command", { type: "attachment.ingest-block", workspaceId: current.id, expectedRevision: current.revision,
        pageId, position, fileName, mediaType, sha256, bytes: { $motionBytes: Array.from(bytes) } });
      assertCurrentWorkspace(operationEpoch, current.id);
      if (result?.workspace?.id !== current.id) throw workspaceChanged();
      advanceWorkspaceSummary(result, current);
      return result;
    },
    async readAttachment(attachmentId) { return dispatchCurrentWorkspace("async-query", { type: "attachment.read", attachmentId }); },
    async createBackup() { return dispatchCurrentWorkspace("async-query", { type: "backup.create" }); },
    async saveBackup(bundle) { return invoke("motion_backup_save", { request: { schemaVersion: 1, bundle } }); },
    async verifyBackup(bundle) { return dispatch("async-query", { type: "backup.verify", bundle }); },
    async previewBackup(bundle) { return dispatch("async-query", { type: "backup.preview", bundle }); },
    async restoreBackup(bundle) {
      return transitionWorkspace(() => dispatch("async-command", { type: "backup.restore-new", bundle }));
    }
  };
}

/** @returns {MotionUiAdapter} */
export function createMotionUiAdapter(runtime = window) {
  const invoke = runtime.__TAURI__?.core?.invoke ?? runtime.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === "function" ? tauriAdapter(invoke) : browserDevelopmentAdapter();
}

export { EMPTY_WORKSPACE, NATIVE_EXECUTE_OPERATIONS };
