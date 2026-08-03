import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";

export const BACKUP_SCHEMA_VERSION = 1 as const;
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface WorkspaceSnapshot {
  schemaVersion: number;
  id: string;
  name: string;
  pages: Array<{ id: string; parentId: string | null; title: string; blocks: JsonValue[]; [key: string]: JsonValue }>;
  databases: Array<{ id: string; pageId: string; name: string; properties: JsonValue[]; rows: Array<{ id: string; [key: string]: JsonValue }>; [key: string]: JsonValue }>;
  attachments: Array<{ id: string; fileName: string; sha256: string; byteLength: number; path: string; [key: string]: JsonValue }>;
  [key: string]: JsonValue;
}

export interface BackupFile { path: string; byteLength: number; sha256: string; mediaType: string }
export interface BackupManifest {
  format: "motion-workspace-backup";
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  createdAt: string;
  workspaceId: string;
  workspaceSchemaVersion: number;
  files: BackupFile[];
}
export interface BackupBundle { manifest: BackupManifest; files: Readonly<Record<string, Uint8Array>> }
export interface AttachmentInput { id: string; fileName: string; bytes: Uint8Array; mediaType?: string }
export interface VerificationResult { valid: boolean; errors: string[] }
export interface RestorePreview { valid: boolean; errors: string[]; workspaceName?: string; pages: number; databases: number; records: number; attachments: number; totalBytes: number }
export interface RestoreResult { workspace: WorkspaceSnapshot; attachments: Map<string, Uint8Array>; idMap: ReadonlyMap<string, string> }

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Stable JSON bytes make checksums reproducible on every platform. */
export function canonicalJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, visit(child)]));
    return item;
  };
  return JSON.stringify(visit(value), null, 2) + "\n";
}

export function safeArchivePath(...parts: string[]): string {
  const clean = parts.map(part => part.normalize("NFC").replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""));
  if (clean.some(part => !part || part === "." || part === ".." || part.includes("\0") || part.split("/").some(bit => bit === ".." || bit === "."))) throw new Error("Unsafe archive path");
  const joined = posix.normalize(clean.join("/"));
  if (posix.isAbsolute(joined) || joined.startsWith("../")) throw new Error("Unsafe archive path");
  return joined;
}

function safeFileName(name: string): string {
  const value = name.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim();
  return value && value !== "." && value !== ".." ? value : "attachment";
}

export function createBackup(workspace: WorkspaceSnapshot, attachments: readonly AttachmentInput[], createdAt = new Date().toISOString()): BackupBundle {
  const files: Record<string, Uint8Array> = { "workspace.json": encoder.encode(canonicalJson(workspace)) };
  const metadata = new Map(workspace.attachments.map(item => [item.id, item]));
  for (const input of attachments) {
    const expected = metadata.get(input.id);
    if (!expected) throw new Error(`Attachment ${input.id} is not referenced by the workspace`);
    if (input.bytes.byteLength !== expected.byteLength || digest(input.bytes) !== expected.sha256) throw new Error(`Attachment ${input.id} does not match workspace metadata`);
    const path = safeArchivePath("attachments", input.id, safeFileName(input.fileName));
    if (files[path]) throw new Error(`Duplicate archive path: ${path}`);
    files[path] = input.bytes.slice();
  }
  if (attachments.length !== workspace.attachments.length) throw new Error("Every attachment must be included in a full backup");
  const listed = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, byteLength: bytes.byteLength, sha256: digest(bytes), mediaType: path === "workspace.json" ? "application/json" : attachments.find(a => path.includes(`/${a.id}/`))?.mediaType ?? "application/octet-stream" }));
  return { manifest: { format: "motion-workspace-backup", schemaVersion: 1, createdAt, workspaceId: workspace.id, workspaceSchemaVersion: workspace.schemaVersion, files: listed }, files };
}

export function verifyBackup(bundle: BackupBundle): VerificationResult {
  const errors: string[] = [];
  if (bundle.manifest.format !== "motion-workspace-backup" || bundle.manifest.schemaVersion !== 1) errors.push("Unsupported backup format or schema version");
  const declared = new Set<string>();
  for (const file of bundle.manifest.files) {
    try { safeArchivePath(file.path); } catch { errors.push(`Unsafe path: ${file.path}`); }
    if (declared.has(file.path)) errors.push(`Duplicate manifest path: ${file.path}`);
    declared.add(file.path);
    const bytes = bundle.files[file.path];
    if (!bytes) errors.push(`Missing file: ${file.path}`);
    else {
      if (bytes.byteLength !== file.byteLength) errors.push(`Size mismatch: ${file.path}`);
      if (digest(bytes) !== file.sha256) errors.push(`Checksum mismatch: ${file.path}`);
    }
  }
  for (const path of Object.keys(bundle.files)) if (!declared.has(path)) errors.push(`Undeclared file: ${path}`);
  if (!declared.has("workspace.json")) errors.push("Missing workspace.json declaration");
  return { valid: errors.length === 0, errors };
}

function readWorkspace(bundle: BackupBundle): WorkspaceSnapshot {
  const bytes = bundle.files["workspace.json"];
  if (!bytes) throw new Error("Missing workspace.json");
  const parsed: unknown = JSON.parse(decoder.decode(bytes));
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid workspace snapshot");
  const candidate = parsed as Partial<WorkspaceSnapshot>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.schemaVersion !== "number" || !Array.isArray(candidate.pages) || !Array.isArray(candidate.databases) || !Array.isArray(candidate.attachments)) throw new Error("Invalid workspace snapshot structure");
  return parsed as WorkspaceSnapshot;
}

export function previewRestore(bundle: BackupBundle): RestorePreview {
  const verification = verifyBackup(bundle);
  if (!verification.valid) return { valid: false, errors: verification.errors, pages: 0, databases: 0, records: 0, attachments: 0, totalBytes: bundle.manifest.files.reduce((sum, file) => sum + file.byteLength, 0) };
  try {
    const workspace = readWorkspace(bundle);
    return { valid: true, errors: [], workspaceName: workspace.name, pages: workspace.pages.length, databases: workspace.databases.length, records: workspace.databases.reduce((sum, database) => sum + database.rows.length, 0), attachments: workspace.attachments.length, totalBytes: bundle.manifest.files.reduce((sum, file) => sum + file.byteLength, 0) };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)], pages: 0, databases: 0, records: 0, attachments: 0, totalBytes: 0 };
  }
}

/** Restore never overwrites an existing workspace: every imported ID is namespaced to a fresh workspace ID. */
export function restoreIntoNewWorkspace(bundle: BackupBundle, newWorkspaceId: string = randomUUID()): RestoreResult {
  const verification = verifyBackup(bundle);
  if (!verification.valid) throw new Error(`Backup verification failed: ${verification.errors.join("; ")}`);
  const source = readWorkspace(bundle);
  const ids = collectIds(source);
  const idMap = new Map([...ids].map(id => [id, id === source.id ? newWorkspaceId : `${newWorkspaceId}:${id}`]));
  const remap = (value: JsonValue, key?: string): JsonValue => {
    if (typeof value === "string" && key && (key === "id" || key.endsWith("Id") || key.endsWith("Ids")) && idMap.has(value)) return idMap.get(value)!;
    if (Array.isArray(value)) return value.map(item => remap(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, remap(child, childKey)]));
    return value;
  };
  const workspace = remap(source as unknown as JsonValue) as WorkspaceSnapshot;
  workspace.id = newWorkspaceId;
  const restored = new Map<string, Uint8Array>();
  for (const attachment of source.attachments) {
    const entry = bundle.manifest.files.find(file => file.path.startsWith(`attachments/${attachment.id}/`));
    if (!entry) throw new Error(`Missing attachment payload: ${attachment.id}`);
    restored.set(idMap.get(attachment.id)!, bundle.files[entry.path]!.slice());
  }
  return { workspace, attachments: restored, idMap };
}

function collectIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (item: unknown, key?: string): void => {
    if (typeof item === "string" && key && (key === "id" || key.endsWith("Id") || key.endsWith("Ids"))) ids.add(item);
    else if (Array.isArray(item)) item.forEach(child => visit(child, key));
    else if (item && typeof item === "object") Object.entries(item).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(value); return ids;
}

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function exportPageSubtreeMarkdown(workspace: WorkspaceSnapshot, rootPageId: string): Record<string, string> {
  const pages = workspace.pages.filter(page => page.id === rootPageId || isDescendant(workspace, page, rootPageId));
  return Object.fromEntries(pages.map(page => [`${safeFileName(page.title)}-${page.id}.md`, `# ${page.title}\n\n${page.blocks.map(block => blockText(block)).join("\n\n")}\n`]));
}
function isDescendant(workspace: WorkspaceSnapshot, page: WorkspaceSnapshot["pages"][number], rootId: string): boolean { let parent = page.parentId; const seen = new Set<string>(); while (parent && !seen.has(parent)) { if (parent === rootId) return true; seen.add(parent); parent = workspace.pages.find(item => item.id === parent)?.parentId ?? null; } return false; }
function blockText(block: JsonValue): string { if (!block || typeof block !== "object" || Array.isArray(block)) return ""; const text = typeof block.text === "string" ? block.text : ""; const children = Array.isArray(block.children) ? block.children.map(blockText).filter(Boolean) : []; return [text, ...children].filter(Boolean).join("\n"); }
export function exportDatabaseCsv(database: WorkspaceSnapshot["databases"][number]): string { const propertyNames = database.properties.map((property, index) => property && typeof property === "object" && !Array.isArray(property) && typeof property.name === "string" ? property.name : `property-${index + 1}`); const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`; return [["id", ...propertyNames].map(cell).join(","), ...database.rows.map(row => [row.id, ...propertyNames.map(name => row[name])].map(cell).join(","))].join("\n") + "\n"; }
export function exportStaticHtml(title: string, markdown: string): string { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(markdown)}</pre></main></body></html>`; }
