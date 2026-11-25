import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { MotionAppService, MotionAppError } from "@motion/app-service";
import { SqliteWorkspaceStore, ContentAddressedAttachmentStore, hardenPrivateFile } from "@motion/storage";
import { createAtomicBackupFile, inspectAtomicBackupDestination } from "./backup-file.mjs";
import { isValidUiState } from "./ui-state-validation.mjs";
import { acquireNativeServiceLock } from "./native-service-lock.mjs";
import { createWindowsUiStateStore } from "./windows-ui-state.mjs";

const [dataRoot] = process.argv.slice(2);
if (!dataRoot) throw new Error("Usage: service-runner <data-root>");

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
const requests = lines[Symbol.asyncIterator]();
if (process.env.MOTION_SERVICE_START_GATE === "1") {
  const gate = await requests.next();
  if (gate.done || gate.value !== "MOTION_SERVICE_START") throw new Error("Native service startup was not authorized");
}

const revive = value => {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && Array.isArray(value.$motionBytes)) {
      if (value.$motionBytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error("Invalid byte envelope");
      return Uint8Array.from(value.$motionBytes);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, revive(child)]));
  }
  return value;
};
const encode = value => value instanceof Uint8Array ? { $motionBytes: Array.from(value) }
  : Array.isArray(value) ? value.map(encode)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]))
  : value;

const ownership = await acquireNativeServiceLock(dataRoot);
const mutableRoot = ownership.mutableRoot;
let store;
try {
store = new SqliteWorkspaceStore(join(mutableRoot, "motion.sqlite3"));
const service = new MotionAppService(store, new ContentAddressedAttachmentStore(join(mutableRoot, "attachments")));
const uiStatePath = join(mutableRoot, "ui-state.json");
const windowsUiState = process.platform === "win32" ? createWindowsUiStateStore(uiStatePath) : undefined;
const readUiState = () => { if (windowsUiState) return windowsUiState.read(); try { hardenPrivateFile(uiStatePath); return JSON.parse(readFileSync(uiStatePath, "utf8")); } catch (error) { if (error?.code === "ENOENT") return {}; throw error; } };
const writeUiState = state => {
  const document = { schemaVersion: 1, workspaceId: state.workspaceId, activePageId: state.activePageId ?? null, expandedPageIds: Array.isArray(state.expandedPageIds) ? state.expandedPageIds : [], activeViewIds: state.activeViewIds ?? {} };
  if (windowsUiState) { windowsUiState.write(document); return; }
  const temporary = `${uiStatePath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(document), { flag: "wx", mode: 0o600 });
  renameSync(temporary, uiStatePath);
  hardenPrivateFile(uiStatePath);
};
async function dispatch(rawRequest) {
  const request = revive(rawRequest);
  let result;
  switch (request.lane) {
    case "native-backup-inspect": {
      if (typeof request.payload?.destination !== "string" || Object.keys(request.payload).some(key => key !== "destination")) throw new MotionAppError("INVALID_INPUT", "Invalid native backup inspection request");
      try { result = await inspectAtomicBackupDestination(request.payload.destination); }
      catch { throw new MotionAppError("VALIDATION_FAILED", "Selected target is not a valid private Motion backup"); }
      break;
    }
    case "native-backup-save": {
      const windows = process.platform === "win32";
      const allowed = windows ? ["destination", "replaceConfirmed", "bundle", "expectedIdentity"]
        : ["destination", "replaceConfirmed", "bundle"];
      if (typeof request.payload?.destination !== "string" || typeof request.payload?.replaceConfirmed !== "boolean"
          || !request.payload?.bundle || Object.keys(request.payload).some(key => !allowed.includes(key))
          || (windows && (request.payload.replaceConfirmed
            ? typeof request.payload.expectedIdentity !== "string" || !/^[a-f0-9]{64}$/.test(request.payload.expectedIdentity)
            : Object.hasOwn(request.payload, "expectedIdentity")))) {
        throw new MotionAppError("INVALID_INPUT", "Invalid native backup save request");
      }
      try {
        result = await createAtomicBackupFile(request.payload.destination, request.payload.bundle,
          request.payload.replaceConfirmed ? { confirmReplace: async () => true,
            ...(windows ? { expectedIdentity: request.payload.expectedIdentity } : {}) } : {});
      } catch {
        throw new MotionAppError("STORAGE_FAILURE", windows
          ? "Backup could not be confirmed; check the destination before retrying"
          : "Backup could not be written safely; existing data was preserved");
      }
      break;
    }
    case "command": result = service.execute(request.payload); break;
    case "web-v1-import": {
      if (request.payload?.type !== "workspace.import-web-v1" || !Object.hasOwn(request.payload, "document") || Object.keys(request.payload).some(key => !["type", "document"].includes(key))) throw new MotionAppError("INVALID_INPUT", "Invalid Web-v1 import request");
      result = service.execute(request.payload);
      writeUiState({ workspaceId: result.workspace.id, activePageId: result.activePageId });
      break;
    }
    case "query": result = service.query(request.payload); break;
    case "async-command": {
      result = await service.executeAsync(request.payload);
      if (request.payload?.type === "backup.restore-new") {
        const workspace = result.workspace;
        writeUiState({ workspaceId: workspace.id, activePageId: workspace.pages.find(page => !page.deletedAt)?.id ?? null });
      }
      break;
    }
    case "async-query": result = await service.queryAsync(request.payload); break;
    case "ui-load": {
      const summaries = service.query({ type: "workspace.list" });
      if (request.payload?.schemaVersion === 2) {
        if (!summaries.length) { result = { schemaVersion: 2, workspace: null, revision: 0, activePageId: null }; break; }
        const uiState = readUiState();
        const selected = summaries.find(summary => summary.id === uiState.workspaceId) ?? summaries[0];
        const loaded = service.query({ type: "workspace.get", workspaceId: selected.id });
        result = { schemaVersion: 2, ...loaded, activePageId: loaded.workspace.pages.some(page => page.id === uiState.activePageId && !page.deletedAt) ? uiState.activePageId : loaded.workspace.pages.find(page => !page.deletedAt)?.id ?? null, expandedPageIds: Array.isArray(uiState.expandedPageIds) ? uiState.expandedPageIds : [], activeViewIds: uiState.activeViewIds ?? {} };
        break;
      }
      if (!summaries.length) { result = { schemaVersion: 1, pages: [], activePageId: null }; break; }
      const uiState = readUiState();
      const selected = summaries.find(summary => summary.id === uiState.workspaceId) ?? summaries[0];
      const loaded = service.query({ type: "workspace.get", workspaceId: selected.id }).workspace;
      const databases = new Map(loaded.databases.map(database => [database.pageId, database]));
      const activePageId = uiState.activePageId ?? null;
      result = { schemaVersion: 1, activePageId: loaded.pages.some(page => page.id === activePageId && !page.deletedAt) ? activePageId : loaded.pages.find(page => !page.deletedAt)?.id ?? null,
        pages: loaded.pages.map((page, order) => {
          const database = databases.get(page.id);
          return { id: page.id, parentId: page.parentId, order, type: database ? "database" : "document", title: page.title,
            archived: Boolean(page.archivedAt), deleted: Boolean(page.deletedAt), blocks: page.blocks.map(block => ({ id: block.id, type: ({ "heading-1":"heading1", "heading-2":"heading2", "heading-3":"heading3", "bulleted-list":"bullet", "numbered-list":"number" })[block.type] ?? block.type, text: block.text, checked: block.checked })),
            ...(database ? { columns: database.properties.map(property => ({ id: property.id, name: property.name, type: property.type === "plain-text" ? "text" : property.type })), rows: database.rows } : {}) };
        }) };
      break;
    }
    case "ui-save": {
      const candidate = request.payload?.document;
      if (request.payload?.schemaVersion === 2) {
        if (!Object.hasOwn(request.payload, "document")
            || Object.keys(request.payload).some(key => !["schemaVersion", "document"].includes(key))
            || !isValidUiState(candidate)) throw new MotionAppError("INVALID_INPUT", "Invalid UI state request");
        const summaries = service.query({ type: "workspace.list" }); const current = summaries.find(summary => summary.id === candidate?.workspaceId) ?? summaries[0];
        if (current) writeUiState({ workspaceId: current.id, activePageId: candidate?.activePageId ?? null, expandedPageIds: candidate?.expandedPageIds, activeViewIds: candidate?.activeViewIds });
        result = { saved: true }; break;
      }
      throw new MotionAppError("INVALID_INPUT", "Whole-workspace UI save is not supported");
    }
    default: throw new MotionAppError("INVALID_INPUT", "Unsupported IPC lane");
  }
  return encode(result);
}

for await (const line of requests) {
  let reply;
  try {
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new MotionAppError("INVALID_INPUT", "Service request exceeds 16 MiB");
    reply = { ok: true, value: await dispatch(JSON.parse(line)) };
  } catch (error) {
    reply = { ok: false, error: {
      code: error instanceof MotionAppError ? error.code : "INTERNAL_ERROR",
      message: error instanceof MotionAppError ? error.message : "Internal service failure"
    }};
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}
} finally {
  try { store?.close(); }
  finally { await ownership.release(); }
}
