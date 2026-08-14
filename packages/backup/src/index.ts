import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { BACKUP_ATTACHMENT_SIZE_LIMIT_ERROR, MAX_ATTACHMENT_BYTES } from "@motion/core";

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
const MAX_BACKUP_FILES = 10_000;
const MAX_BACKUP_METADATA_STRING = 4_096;
const MAX_BACKUP_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_WORKSPACE_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const CANONICAL_MAX_ID_LENGTH = 160;
const CANONICAL_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${CANONICAL_MAX_ID_LENGTH - 1}}$`);

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
  if (parts.some(part => part.startsWith("/") || part.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(part))) throw new Error("Unsafe archive path");
  const clean = parts.map(part => part.normalize("NFC").replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""));
  if (clean.some(part => {
    let decoded: string;
    try { decoded = decodeURIComponent(part).replaceAll("\\", "/"); } catch { return true; }
    return !part || part.includes("\0") || decoded.includes("\0") || decoded.split("/").some(bit => bit === ".." || bit === ".");
  })) throw new Error("Unsafe archive path");
  const joined = posix.normalize(clean.join("/"));
  if (posix.isAbsolute(joined) || joined.startsWith("../")) throw new Error("Unsafe archive path");
  return joined;
}

function safeFileName(name: string): string {
  const value = name.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim();
  return value && value !== "." && value !== ".." ? value : "attachment";
}

export function createBackup(workspace: WorkspaceSnapshot, attachments: readonly AttachmentInput[], createdAt = new Date().toISOString()): BackupBundle {
  if (workspace.attachments.some(item => Number.isSafeInteger(item.byteLength) && item.byteLength > MAX_ATTACHMENT_BYTES))
    throw new Error(BACKUP_ATTACHMENT_SIZE_LIMIT_ERROR);
  const files: Record<string, Uint8Array> = { "workspace.json": encoder.encode(canonicalJson(workspace)) };
  const metadata = new Map(workspace.attachments.map(item => [item.id, item]));
  for (const input of attachments) {
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(BACKUP_ATTACHMENT_SIZE_LIMIT_ERROR);
    const expected = metadata.get(input.id);
    if (!expected) throw new Error(`Attachment ${input.id} is not referenced by the workspace`);
    if (input.fileName !== expected.fileName) throw new Error(`Attachment ${input.id} file name does not match workspace metadata`);
    if (input.bytes.byteLength !== expected.byteLength || digest(input.bytes) !== expected.sha256) throw new Error(`Attachment ${input.id} does not match workspace metadata`);
    const path = safeArchivePath("attachments", input.id, safeFileName(expected.fileName));
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
  if (!Array.isArray(bundle.manifest.files) || bundle.manifest.files.length > MAX_BACKUP_FILES) return { valid: false, errors: ["Backup manifest exceeds file-count limit"] };
  if ([bundle.manifest.createdAt, bundle.manifest.workspaceId].some(value => typeof value !== "string" || value.length > MAX_BACKUP_METADATA_STRING)) errors.push("Backup manifest metadata exceeds limit");
  const declared = new Set<string>();
  let totalBytes = 0;
  for (const [index, file] of bundle.manifest.files.entries()) {
    const allowedKeys = new Set(["path", "byteLength", "sha256", "mediaType"]);
    if (!file || typeof file !== "object" || Object.keys(file).some(key => !allowedKeys.has(key))) { errors.push(`Unsupported link-like or metadata field at manifest file ${index}`); continue; }
    if (typeof file.path !== "string" || file.path.length > MAX_BACKUP_METADATA_STRING || typeof file.mediaType !== "string" || file.mediaType.length > MAX_BACKUP_METADATA_STRING) errors.push(`Manifest file ${index} metadata exceeds limit`);
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) errors.push(`Manifest file ${index} has invalid size or checksum metadata`);
    const attachmentOversized = file.path !== "workspace.json" && ((Number.isSafeInteger(file.byteLength) && file.byteLength > MAX_ATTACHMENT_BYTES)
      || bundle.files[file.path]?.byteLength !== undefined && bundle.files[file.path]!.byteLength > MAX_ATTACHMENT_BYTES);
    if (attachmentOversized && !errors.includes(BACKUP_ATTACHMENT_SIZE_LIMIT_ERROR)) errors.push(BACKUP_ATTACHMENT_SIZE_LIMIT_ERROR);
    totalBytes += Number.isSafeInteger(file.byteLength) ? file.byteLength : 0;
    try { safeArchivePath(file.path); } catch { errors.push(`Unsafe archive path at manifest file ${index}`); }
    if (declared.has(file.path)) errors.push(`Duplicate manifest path at file ${index}`);
    declared.add(file.path);
    const bytes = bundle.files[file.path];
    if (!bytes) errors.push(`Missing payload for manifest file ${index}`);
    else {
      if (bytes.byteLength !== file.byteLength) errors.push(`Size mismatch at manifest file ${index}`);
      if (digest(bytes) !== file.sha256) errors.push(`Checksum mismatch at manifest file ${index}`);
    }
  }
  if (totalBytes > MAX_BACKUP_TOTAL_BYTES) errors.push("Backup payload exceeds total-size limit");
  for (const path of Object.keys(bundle.files)) if (!declared.has(path)) errors.push("Undeclared backup payload");
  if (!declared.has("workspace.json")) errors.push("Missing workspace.json declaration");
  if (errors.length === 0) {
    try { assertBackupWorkspaceSemantics(bundle, readWorkspace(bundle)); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  return { valid: errors.length === 0, errors };
}

function readWorkspace(bundle: BackupBundle): WorkspaceSnapshot {
  const bytes = bundle.files["workspace.json"];
  if (!bytes) throw new Error("Missing workspace.json");
  if (bytes.byteLength > MAX_WORKSPACE_SNAPSHOT_BYTES) throw new Error("Workspace snapshot exceeds size limit");
  const parsed: unknown = JSON.parse(decoder.decode(bytes));
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid workspace snapshot");
  const candidate = parsed as Partial<WorkspaceSnapshot>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.schemaVersion !== "number" || !Array.isArray(candidate.pages) || !Array.isArray(candidate.databases) || !Array.isArray(candidate.attachments)) throw new Error("Invalid workspace snapshot structure");
  return parsed as WorkspaceSnapshot;
}

function assertBackupWorkspaceSemantics(bundle: BackupBundle, workspace: WorkspaceSnapshot): void {
  if (bundle.manifest.workspaceId !== workspace.id || bundle.manifest.workspaceSchemaVersion !== workspace.schemaVersion) {
    throw new Error("Workspace snapshot identity does not match manifest");
  }
  const workspaceFiles = bundle.manifest.files.filter(file => file.path === "workspace.json");
  if (workspaceFiles.length !== 1 || workspaceFiles[0]!.mediaType !== "application/json") throw new Error("Workspace snapshot must have exactly one JSON manifest payload");

  // The backup package deliberately validates only the structural and membership invariants
  // required to verify and restore safely. Full domain validation remains owned by core.
  const pageIds = new Set<string>();
  const pages = new Map<string, WorkspaceSnapshot["pages"][number]>();
  for (const [index, page] of workspace.pages.entries()) {
    if (!plainObject(page) || typeof page.title !== "string" || (page.parentId !== null && typeof page.parentId !== "string") || !Array.isArray(page.blocks)) {
      throw new Error(`Invalid workspace snapshot page ${index}`);
    }
    assertCanonicalId(page.id, `Source page ID at index ${index}`);
    if (pageIds.has(page.id)) throw new Error("Backup contains a duplicate source ID");
    pageIds.add(page.id); pages.set(page.id, page);
  }
  const databaseIds = new Set<string>();
  const databases = new Map<string, WorkspaceSnapshot["databases"][number]>();
  for (const [index, database] of workspace.databases.entries()) {
    if (!plainObject(database) || typeof database.pageId !== "string" || typeof database.name !== "string"
      || !Array.isArray(database.properties) || !Array.isArray(database.rows)
      || (database.views !== undefined && !Array.isArray(database.views))
      || (database.recordPageIds !== undefined && !Array.isArray(database.recordPageIds))) {
      throw new Error(`Invalid workspace snapshot database ${index}`);
    }
    assertCanonicalId(database.id, `Database ${index} ID`);
    if (databaseIds.has(database.id)) throw new Error("Backup contains a duplicate source ID");
    if (!pages.has(database.pageId)) throw new Error(`Database ${database.id} references a missing page`);
    databaseIds.add(database.id); databases.set(database.id, database);
  }
  const recordOwners = new Map<string, string>();
  for (const database of workspace.databases) {
    const recordPageIds = database.recordPageIds;
    if (recordPageIds !== undefined && !Array.isArray(recordPageIds)) throw new Error(`Invalid record membership for database ${database.id}`);
    for (const recordPageId of recordPageIds ?? []) {
      assertCanonicalId(recordPageId, `Record page ID in ${database.id}`);
      const recordPage = pages.get(recordPageId);
      if (!recordPage) throw new Error(`Database ${database.id} references a missing record page`);
      if (recordPage.collectionId !== database.id) throw new Error(`Database ${database.id} lists a record page from another collection`);
      if (recordOwners.has(recordPageId)) throw new Error("Record page membership must be unique");
      recordOwners.set(recordPageId, database.id);
    }
  }
  for (const page of workspace.pages) {
    if (page.parentId !== null && !pages.has(page.parentId)) throw new Error(`Page ${page.id} references a missing parent`);
    if (page.collectionId === undefined) continue;
    if (typeof page.collectionId !== "string" || !databases.has(page.collectionId)) throw new Error(`Page ${page.id} references a missing collection`);
    if (recordOwners.get(page.id) !== page.collectionId) throw new Error(`Record page ${page.id} is not indexed by its collection`);
  }

  collectIdentities(workspace);
  const attachmentEntries = bundle.manifest.files.filter(file => file.path !== "workspace.json");
  if (workspace.attachments.length !== attachmentEntries.length) throw new Error("Workspace attachment entities and payloads must have one-to-one membership");
  const attachmentEntriesByPath = new Map(attachmentEntries.map(file => [file.path, file] as const));
  const expectedAttachmentPaths = new Set<string>();
  for (const [index, attachment] of workspace.attachments.entries()) {
    if (!plainObject(attachment) || typeof attachment.fileName !== "string" || typeof attachment.path !== "string"
      || typeof attachment.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(attachment.sha256)
      || !Number.isSafeInteger(attachment.byteLength) || attachment.byteLength < 0 || attachment.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Invalid workspace attachment metadata at index ${index}`);
    }
    assertCanonicalId(attachment.id, `Attachment ${index} ID`);
    const expectedPath = safeArchivePath("attachments", attachment.id, safeFileName(attachment.fileName));
    if (expectedAttachmentPaths.has(expectedPath)) throw new Error("Duplicate workspace attachment payload identity");
    expectedAttachmentPaths.add(expectedPath);
    const entry = attachmentEntriesByPath.get(expectedPath);
    if (!entry) throw new Error(`Attachment ${attachment.id} must have exactly one payload`);
    if (entry.sha256 !== attachment.sha256 || entry.byteLength !== attachment.byteLength) throw new Error(`Attachment ${attachment.id} metadata does not match its payload`);
  }
  if (attachmentEntries.length !== expectedAttachmentPaths.size || attachmentEntries.some(file => !expectedAttachmentPaths.has(file.path))) {
    throw new Error("Backup contains an attachment payload not owned by the workspace");
  }
}

function plainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  assertCanonicalId(newWorkspaceId, "New workspace ID");
  const source = readWorkspace(bundle);
  const identities = collectIdentities(source);
  const used = new Set<string>([newWorkspaceId]);
  const idMap = new Map<string, string>([[source.id, newWorkspaceId]]);
  for (const identity of identities.filter(item => item.source !== source.id).sort((a, b) => a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind))) {
    const readable = `${newWorkspaceId}:${identity.source}`;
    let mapped = readable.length <= CANONICAL_MAX_ID_LENGTH && CANONICAL_ID.test(readable) && !used.has(readable) ? readable : "";
    for (let collision = 0; !mapped || used.has(mapped); collision++) {
      const hash = createHash("sha256").update("motion.restore-id.v1\0").update(newWorkspaceId).update("\0")
        .update(identity.kind).update("\0").update(identity.source).update("\0").update(String(collision)).digest("hex");
      const candidate = `restore:${hash}`;
      if (!used.has(candidate)) mapped = candidate;
    }
    used.add(mapped); idMap.set(identity.source, mapped);
  }
  type JsonObject = { [key: string]: JsonValue };
  const object = (value: JsonValue | undefined): JsonObject | undefined => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  const mapped = (value: JsonValue | undefined): JsonValue | undefined => typeof value === "string" ? idMap.get(value) ?? value : value;
  const mappedList = (value: JsonValue | undefined): JsonValue | undefined => Array.isArray(value) ? value.map(item => mapped(item)!) : value;
  const workspace = structuredClone(source);

  function remapPropertyValue(value: JsonValue, type: string): JsonValue {
    if (new Set(["select", "status", "page"]).has(type)) return mapped(value)!;
    if (new Set(["multi-select", "relation"]).has(type)) return mappedList(value)!;
    if (type === "files") {
      const result = structuredClone(value); const record = object(result);
      if (record?.attachmentIds !== undefined) record.attachmentIds = mappedList(record.attachmentIds)!;
      return result;
    }
    // Text, principals, timestamps and every other scalar are not workspace identities.
    return structuredClone(value);
  }
  function remapPropertyRecord(value: JsonValue | undefined, properties: Map<string, string>): JsonValue | undefined {
    const record = object(value);
    if (!record) return structuredClone(value);
    return Object.fromEntries(Object.entries(record).map(([propertyId, propertyValue]) => [
      idMap.get(propertyId) ?? propertyId,
      remapPropertyValue(propertyValue, properties.get(propertyId) ?? "")
    ]));
  }
  function remapBlocks(blocks: JsonValue[]): void {
    for (const blockValue of blocks) {
      const block = object(blockValue); if (!block) continue;
      block.id = mapped(block.id)!;
      for (const field of ["attachmentId", "pageId", "viewId"] as const) if (block[field] !== undefined) block[field] = mapped(block[field])!;
      if (Array.isArray(block.references)) for (const referenceValue of block.references) {
        const reference = object(referenceValue); if (reference?.pageId !== undefined) reference.pageId = mapped(reference.pageId)!;
      }
      if (Array.isArray(block.children)) remapBlocks(block.children);
      // unknownData is intentionally opaque and is never traversed.
    }
  }
  function remapFilter(value: JsonValue | undefined, properties: Map<string, string>): void {
    const filter = object(value); if (!filter) return;
    if (filter.kind === "condition") {
      const sourcePropertyId = filter.propertyId;
      if (typeof sourcePropertyId === "string") {
        if (filter.value !== undefined) filter.value = remapPropertyValue(filter.value, properties.get(sourcePropertyId) ?? "");
        filter.propertyId = mapped(sourcePropertyId)!;
      }
    } else if ((filter.kind === "and" || filter.kind === "or") && Array.isArray(filter.children)) {
      filter.children.forEach(child => remapFilter(child, properties));
    } else if (filter.kind === "not") remapFilter(filter.child, properties);
  }

  workspace.id = newWorkspaceId;
  for (const attachment of workspace.attachments) attachment.id = mapped(attachment.id) as string;
  for (const page of workspace.pages) {
    page.id = mapped(page.id) as string;
    if (page.parentId !== null) page.parentId = mapped(page.parentId) as string;
    if (page.collectionId !== undefined) page.collectionId = mapped(page.collectionId)!;
    if (Array.isArray(page.blocks)) remapBlocks(page.blocks);
    const sourceCollection = typeof source.pages[workspace.pages.indexOf(page)]?.collectionId === "string"
      ? source.databases.find(database => database.id === source.pages[workspace.pages.indexOf(page)]!.collectionId) : undefined;
    const propertyTypes = new Map<string, string>();
    for (const propertyValue of sourceCollection?.properties ?? []) {
      const property = object(propertyValue);
      if (typeof property?.id === "string" && typeof property.type === "string") propertyTypes.set(property.id, property.type);
    }
    if (page.properties !== undefined) page.properties = remapPropertyRecord(page.properties, propertyTypes)!;
    // createdBy, updatedBy, templateOriginId and permissions are external/opaque.
  }
  for (const [databaseIndex, database] of workspace.databases.entries()) {
    const sourceDatabase = source.databases[databaseIndex]!;
    database.id = mapped(database.id) as string; database.pageId = mapped(database.pageId) as string;
    if (database.propertyOrder !== undefined) database.propertyOrder = mappedList(database.propertyOrder)!;
    if (database.titlePropertyId !== undefined) database.titlePropertyId = mapped(database.titlePropertyId)!;
    const propertyTypes = new Map<string, string>();
    for (const propertyValue of sourceDatabase.properties) {
      const property = object(propertyValue);
      if (typeof property?.id === "string" && typeof property.type === "string") propertyTypes.set(property.id, property.type);
    }
    for (const propertyValue of database.properties) {
      const property = object(propertyValue); if (!property) continue;
      property.id = mapped(property.id)!;
      if (Array.isArray(property.options)) for (const optionValue of property.options) {
        const option = object(optionValue); if (option) option.id = mapped(option.id)!;
      }
      const relation = object(property.relation);
      if (relation?.targetCollectionId !== undefined) relation.targetCollectionId = mapped(relation.targetCollectionId)!;
      if (relation?.reciprocalPropertyId !== undefined) relation.reciprocalPropertyId = mapped(relation.reciprocalPropertyId)!;
      if (property.relationDatabaseId !== undefined) property.relationDatabaseId = mapped(property.relationDatabaseId)!;
    }
    for (const [rowIndex, row] of database.rows.entries()) {
      row.id = mapped(row.id) as string;
      if (row.pageId !== undefined) row.pageId = mapped(row.pageId)!;
      const sourceValues = sourceDatabase.rows[rowIndex]?.values;
      if (sourceValues !== undefined) row.values = remapPropertyRecord(sourceValues, propertyTypes) as JsonObject;
    }
    if (Array.isArray(database.recordPageIds)) database.recordPageIds = mappedList(database.recordPageIds) as JsonValue[];
    if (Array.isArray(database.views)) for (const viewValue of database.views) {
      const view = object(viewValue); if (!view) continue;
      view.id = mapped(view.id)!; if (view.collectionId !== undefined) view.collectionId = mapped(view.collectionId)!;
      for (const field of ["visiblePropertyIds", "propertyOrder"] as const) if (view[field] !== undefined) view[field] = mappedList(view[field])!;
      const widths = object(view.columnWidths);
      if (widths) view.columnWidths = Object.fromEntries(Object.entries(widths).map(([propertyId, width]) => [idMap.get(propertyId) ?? propertyId, width]));
      remapFilter(view.filters, propertyTypes);
      if (Array.isArray(view.sorts)) for (const sortValue of view.sorts) {
        const sort = object(sortValue); if (sort?.propertyId !== undefined) sort.propertyId = mapped(sort.propertyId)!;
      }
      for (const field of ["groupByPropertyId", "subgroupByPropertyId", "calendarDatePropertyId", "timelineStartPropertyId", "timelineEndPropertyId"] as const) {
        if (view[field] !== undefined) view[field] = mapped(view[field])!;
      }
      // layout, permissions and cardPreview remain opaque.
    }
  }
  if (Array.isArray(workspace.linkIndex)) for (const linkValue of workspace.linkIndex) {
    const link = object(linkValue); if (!link) continue;
    for (const field of ["sourcePageId", "targetPageId", "blockId"] as const) if (link[field] !== undefined) link[field] = mapped(link[field])!;
  }
  const restored = new Map<string, Uint8Array>();
  for (const attachment of source.attachments) {
    const entry = bundle.manifest.files.find(file => file.path.startsWith(`attachments/${attachment.id}/`));
    if (!entry) throw new Error(`Missing attachment payload: ${attachment.id}`);
    restored.set(idMap.get(attachment.id)!, bundle.files[entry.path]!.slice());
  }
  return { workspace, attachments: restored, idMap };
}

interface SourceIdentity { source: string; kind: string }
function assertCanonicalId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !CANONICAL_ID.test(value)) throw new Error(`${label} must be a safe canonical workspace ID`);
}
function collectIdentities(workspace: WorkspaceSnapshot): SourceIdentity[] {
  const identities: SourceIdentity[] = [];
  const seen = new Set<string>();
  const add = (source: unknown, kind: string): void => {
    assertCanonicalId(source, `Source ${kind} ID`);
    if (seen.has(source)) throw new Error("Backup contains a duplicate source ID");
    seen.add(source); identities.push({ source, kind });
  };
  const blocks = (items: JsonValue[]): void => {
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      add(item.id, "block");
      if (Array.isArray(item.children)) blocks(item.children);
    }
  };
  add(workspace.id, "workspace");
  for (const attachment of workspace.attachments) add(attachment.id, "attachment");
  for (const page of workspace.pages) { add(page.id, "page"); blocks(page.blocks); }
  for (const database of workspace.databases) {
    add(database.id, "database");
    for (const property of database.properties) if (property && typeof property === "object" && !Array.isArray(property)) {
      add(property.id, "property");
      if (Array.isArray(property.options)) for (const option of property.options) if (option && typeof option === "object" && !Array.isArray(option)) add(option.id, "property-option");
    }
    for (const row of database.rows) add(row.id, "row");
    if (Array.isArray(database.views)) for (const view of database.views) if (view && typeof view === "object" && !Array.isArray(view)) add(view.id, "view");
  }
  return identities;
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
