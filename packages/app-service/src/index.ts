import {
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceDocument,
  assertWorkspaceValue,
  createWorkspace,
  exportFullWorkspace,
  migrateWebWorkspaceV1,
  type Block,
  type Attachment,
  type FullExport,
  type Page,
  type PageLink,
  type Workspace
} from "@motion/core";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore, type SearchHit, type StoredWorkspace } from "@motion/storage";
import { createBackup, previewRestore, restoreIntoNewWorkspace, verifyBackup, type BackupBundle, type RestorePreview, type VerificationResult } from "@motion/backup";

export type AppErrorCode =
  | "INVALID_INPUT" | "NOT_FOUND" | "REVISION_CONFLICT" | "VALIDATION_FAILED"
  | "ALREADY_EXISTS" | "STORAGE_FAILURE" | "INTERNAL_ERROR";

export class MotionAppError extends Error {
  constructor(public readonly code: AppErrorCode, message: string, public readonly details?: Readonly<Record<string, unknown>>) {
    super(message); this.name = "MotionAppError";
  }
}

export interface WorkspaceDto { readonly workspace: Readonly<Workspace>; readonly revision: number }
export interface WorkspaceSummaryDto { readonly id: string; readonly name: string; readonly updatedAt: string; readonly revision: number }
export interface MutationDto extends WorkspaceDto { readonly saved: true }
export interface ImportDto extends MutationDto { readonly activePageId: string | null }
export interface AttachmentDto { readonly attachment: Readonly<Attachment>; readonly bytes?: Uint8Array }

export type AppCommand =
  | { type: "workspace.create"; name: string }
  | { type: "workspace.import-web-v1"; document: unknown; workspaceId?: string; workspaceName?: string; migratedAt?: string }
  | { type: "page.create"; workspaceId: string; expectedRevision: number; title: string; parentId?: string | null }
  | { type: "page.rename"; workspaceId: string; expectedRevision: number; pageId: string; title: string }
  | { type: "page.move"; workspaceId: string; expectedRevision: number; pageId: string; parentId: string | null }
  | { type: "page.trash"; workspaceId: string; expectedRevision: number; pageId: string }
  | { type: "page.restore"; workspaceId: string; expectedRevision: number; pageId: string }
  | { type: "page.replace-blocks"; workspaceId: string; expectedRevision: number; pageId: string; blocks: readonly Block[] };

export type AsyncAppCommand =
  | { type: "attachment.put"; workspaceId: string; expectedRevision: number; id?: string; fileName: string; mediaType: string; sha256: string; bytes: Uint8Array }
  | { type: "backup.restore-new"; bundle: BackupBundle; newWorkspaceId?: string };

export type AppQuery =
  | { type: "workspace.list" }
  | { type: "workspace.get"; workspaceId: string }
  | { type: "page.backlinks"; workspaceId: string; pageId: string }
  | { type: "workspace.search"; workspaceId: string; query: string; limit?: number }
  | { type: "workspace.export"; workspaceId: string };

export type AsyncAppQuery =
  | { type: "attachment.read"; workspaceId: string; attachmentId: string }
  | { type: "backup.create"; workspaceId: string; createdAt?: string }
  | { type: "backup.verify"; bundle: BackupBundle }
  | { type: "backup.preview"; bundle: BackupBundle };

export interface CommandResults {
  "workspace.create": MutationDto;
  "workspace.import-web-v1": ImportDto;
  "page.create": MutationDto;
  "page.rename": MutationDto;
  "page.move": MutationDto;
  "page.trash": MutationDto;
  "page.restore": MutationDto;
  "page.replace-blocks": MutationDto;
}
export interface QueryResults {
  "workspace.list": readonly WorkspaceSummaryDto[];
  "workspace.get": WorkspaceDto;
  "page.backlinks": readonly Readonly<PageLink>[];
  "workspace.search": readonly Readonly<SearchHit>[];
  "workspace.export": Readonly<FullExport>;
}
export interface AsyncCommandResults { "attachment.put": MutationDto; "backup.restore-new": MutationDto }
export interface AsyncQueryResults { "attachment.read": AttachmentDto; "backup.create": BackupBundle; "backup.verify": VerificationResult; "backup.preview": RestorePreview }

const clone = <T>(value: T): T => structuredClone(value);
const immutable = <T>(value: T): Readonly<T> => deepFreeze(clone(value));
function deepFreeze<T>(value: T): Readonly<T> {
  if (ArrayBuffer.isView(value)) return value as Readonly<T>;
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
const requiredText = (value: unknown, field: string, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > 10_000_000)
    throw new MotionAppError("INVALID_INPUT", `${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new MotionAppError("INVALID_INPUT", "expectedRevision must be a positive integer");
  return Number(value);
};

export class MotionAppService {
  constructor(private readonly store: SqliteWorkspaceStore, private readonly attachments?: ContentAddressedAttachmentStore) {}

  execute<C extends AppCommand>(command: C): CommandResults[C["type"]] {
    try { return this.executeUnsafe(command) as CommandResults[C["type"]]; }
    catch (error) { throw mapError(error); }
  }

  query<Q extends AppQuery>(query: Q): QueryResults[Q["type"]] {
    try { return this.queryUnsafe(query) as QueryResults[Q["type"]]; }
    catch (error) { throw mapError(error); }
  }

  async executeAsync<C extends AsyncAppCommand>(command: C): Promise<AsyncCommandResults[C["type"]]> {
    try { return await this.executeAsyncUnsafe(command) as AsyncCommandResults[C["type"]]; }
    catch (error) { throw mapError(error); }
  }

  async queryAsync<Q extends AsyncAppQuery>(query: Q): Promise<AsyncQueryResults[Q["type"]]> {
    try { return await this.queryAsyncUnsafe(query) as AsyncQueryResults[Q["type"]]; }
    catch (error) { throw mapError(error); }
  }

  private attachmentStore(): ContentAddressedAttachmentStore {
    if (!this.attachments) throw new MotionAppError("STORAGE_FAILURE", "Attachment storage is not configured");
    return this.attachments;
  }

  private async executeAsyncUnsafe(command: AsyncAppCommand): Promise<MutationDto> {
    if (command.type === "attachment.put") {
      const expectedRevision = revision(command.expectedRevision);
      const loaded = this.required(command.workspaceId);
      const fileName = requiredText(command.fileName, "fileName");
      const mediaType = requiredText(command.mediaType, "mediaType");
      const sha256 = validSha256(command.sha256);
      if (!(command.bytes instanceof Uint8Array)) throw new MotionAppError("INVALID_INPUT", "bytes must be a Uint8Array");
      const stored = await this.attachmentStore().put(command.bytes);
      if (stored.sha256 !== sha256) throw new MotionAppError("VALIDATION_FAILED", "Attachment bytes do not match declared sha256");
      const document = clone(loaded.document);
      const id = command.id ? requiredText(command.id, "id") : crypto.randomUUID();
      if (document.attachments.some(item => item.id === id)) throw new MotionAppError("ALREADY_EXISTS", `Attachment already exists: ${id}`);
      const now = new Date().toISOString();
      document.attachments.push({ id, fileName, mediaType, byteLength: stored.byteLength, sha256, path: stored.path, createdAt: now });
      document.updatedAt = now;
      assertWorkspaceValue(document);
      try {
        const savedRevision = this.store.saveUnitOfWork({ workspaceId: document.id, schemaVersion: document.schemaVersion, document, expectedRevision });
        return immutable({ workspace: document, revision: savedRevision, saved: true as const }) as MutationDto;
      } catch (error) {
        throw new MotionAppError(error instanceof Error && error.message.startsWith("Revision conflict") ? "REVISION_CONFLICT" : "STORAGE_FAILURE", `${error instanceof Error ? error.message : error}. Attachment content may remain as an unreferenced immutable blob; database and filesystem promotion are not atomic with the current storage API.`, { stagedAttachmentSha256: sha256 });
      }
    }

    const restored = restoreIntoNewWorkspace(command.bundle, command.newWorkspaceId);
    assertWorkspaceValue(restored.workspace);
    if (this.store.load(restored.workspace.id)) throw new MotionAppError("ALREADY_EXISTS", `Workspace already exists: ${restored.workspace.id}`);
    const document = clone(restored.workspace);
    for (const attachment of document.attachments) {
      const bytes = restored.attachments.get(attachment.id);
      if (!bytes) throw new MotionAppError("VALIDATION_FAILED", `Missing restored attachment: ${attachment.id}`);
      const stored = await this.attachmentStore().put(bytes);
      if (stored.sha256 !== attachment.sha256 || stored.byteLength !== attachment.byteLength) throw new MotionAppError("VALIDATION_FAILED", `Restored attachment metadata mismatch: ${attachment.id}`);
      attachment.path = stored.path; // Never trust the archived source path.
    }
    assertWorkspaceValue(document);
    try {
      const savedRevision = this.store.saveUnitOfWork({ workspaceId: document.id, schemaVersion: document.schemaVersion, document, expectedRevision: 0 });
      return immutable({ workspace: document, revision: savedRevision, saved: true as const }) as MutationDto;
    } catch (error) {
      throw new MotionAppError("STORAGE_FAILURE", `${error instanceof Error ? error.message : error}. Restored content may remain as unreferenced immutable blobs; database and filesystem promotion are not atomic with the current storage API.`);
    }
  }

  private async queryAsyncUnsafe(query: AsyncAppQuery): Promise<unknown> {
    if (query.type === "backup.verify") return immutable(verifyBackup(query.bundle));
    if (query.type === "backup.preview") return immutable(previewRestore(query.bundle));
    const loaded = this.required(query.workspaceId);
    if (query.type === "attachment.read") {
      const id = requiredText(query.attachmentId, "attachmentId");
      const attachment = loaded.document.attachments.find(item => item.id === id);
      if (!attachment) throw new MotionAppError("NOT_FOUND", `Attachment not found: ${id}`);
      const bytes = await this.attachmentStore().get(validSha256(attachment.sha256));
      if (bytes.byteLength !== attachment.byteLength) throw new MotionAppError("VALIDATION_FAILED", `Attachment size mismatch: ${id}`);
      return immutable({ attachment, bytes });
    }
    const inputs = await Promise.all(loaded.document.attachments.map(async attachment => ({ id: attachment.id, fileName: attachment.fileName, mediaType: attachment.mediaType, bytes: await this.attachmentStore().get(validSha256(attachment.sha256)) })));
    return immutable(createBackup(loaded.document as unknown as import("@motion/backup").WorkspaceSnapshot, inputs, query.createdAt));
  }

  private executeUnsafe(command: AppCommand): MutationDto | ImportDto {
    if (command.type === "workspace.create") {
      const document = createWorkspace(requiredText(command.name, "name"));
      assertWorkspaceValue(document);
      const savedRevision = this.store.saveUnitOfWork({ workspaceId: document.id, schemaVersion: document.schemaVersion, document, expectedRevision: 0 });
      return immutable({ workspace: document, revision: savedRevision, saved: true as const }) as MutationDto;
    }
    if (command.type === "workspace.import-web-v1") {
      const migrated = migrateWebWorkspaceV1(command.document, {
        workspaceId: command.workspaceId ?? crypto.randomUUID(),
        workspaceName: command.workspaceName,
        migratedAt: command.migratedAt ?? new Date().toISOString()
      });
      if (this.store.load(migrated.workspace.id)) throw new MotionAppError("ALREADY_EXISTS", `Workspace already exists: ${migrated.workspace.id}`);
      const savedRevision = this.store.saveUnitOfWork({ workspaceId: migrated.workspace.id, schemaVersion: migrated.workspace.schemaVersion, document: migrated.workspace, expectedRevision: 0 });
      return immutable({ workspace: migrated.workspace, revision: savedRevision, saved: true as const, activePageId: migrated.uiState.activePageId }) as ImportDto;
    }
    const expectedRevision = revision(command.expectedRevision);
    const loaded = this.required(command.workspaceId);
    const document = new WorkspaceDocument(clone(loaded.document));
    switch (command.type) {
      case "page.create": document.addPage(requiredText(command.title, "title", true), command.parentId ?? null); break;
      case "page.rename": {
        const page = requiredPage(document, command.pageId); page.title = requiredText(command.title, "title", true); page.updatedAt = new Date().toISOString(); document.data.updatedAt = page.updatedAt; break;
      }
      case "page.move": document.movePage(requiredText(command.pageId, "pageId"), command.parentId); break;
      case "page.trash": {
        const page = requiredPage(document, command.pageId); page.deletedAt = new Date().toISOString(); page.updatedAt = page.deletedAt; document.data.updatedAt = page.deletedAt; break;
      }
      case "page.restore": {
        const page = requiredPage(document, command.pageId); delete page.deletedAt; page.updatedAt = new Date().toISOString(); document.data.updatedAt = page.updatedAt; break;
      }
      case "page.replace-blocks": {
        const page = requiredPage(document, command.pageId); page.blocks = clone(command.blocks) as Block[]; page.updatedAt = new Date().toISOString(); document.data.updatedAt = page.updatedAt;
        // Validate the candidate tree before any traversal-derived indexes are rebuilt.
        assertWorkspaceValue(document.data); document.rebuildLinkIndex(); break;
      }
    }
    assertWorkspaceValue(document.data);
    const savedRevision = this.store.saveUnitOfWork({ workspaceId: document.data.id, schemaVersion: WORKSPACE_SCHEMA_VERSION, document: document.data, expectedRevision });
    return immutable({ workspace: document.data, revision: savedRevision, saved: true as const }) as MutationDto;
  }

  private queryUnsafe(query: AppQuery): unknown {
    if (query.type === "workspace.list") return immutable(this.store.list().map(row => {
      assertWorkspaceValue(row.document); const workspace = row.document;
      return { id: workspace.id, name: workspace.name, updatedAt: workspace.updatedAt, revision: row.revision };
    }));
    const loaded = this.required(query.workspaceId);
    const document = new WorkspaceDocument(clone(loaded.document));
    switch (query.type) {
      case "workspace.get": return immutable({ workspace: document.data, revision: loaded.revision });
      case "page.backlinks": return immutable(document.backlinks(requiredText(query.pageId, "pageId")));
      case "workspace.search": {
        requiredText(query.query, "query", true);
        if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200)) throw new MotionAppError("INVALID_INPUT", "limit must be an integer from 1 to 200");
        return immutable(this.store.search(query.query, query.workspaceId, query.limit ?? 50));
      }
      case "workspace.export": return immutable(exportFullWorkspace(document.data));
    }
  }

  private required(workspaceId: string): StoredWorkspace & { document: Workspace } {
    requiredText(workspaceId, "workspaceId");
    const loaded = this.store.load(workspaceId);
    if (!loaded) throw new MotionAppError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
    assertWorkspaceValue(loaded.document);
    return loaded as StoredWorkspace & { document: Workspace };
  }
}

function validSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new MotionAppError("INVALID_INPUT", "sha256 must be 64 lowercase hexadecimal characters");
  return value;
}

function requiredPage(document: WorkspaceDocument, pageId: string): Page {
  requiredText(pageId, "pageId"); const page = document.page(pageId);
  if (!page) throw new MotionAppError("NOT_FOUND", `Page not found: ${pageId}`);
  return page;
}
function mapError(error: unknown): MotionAppError {
  if (error instanceof MotionAppError) return error;
  const message = error instanceof Error ? error.message : "Unknown application error";
  if (message.startsWith("Revision conflict")) return new MotionAppError("REVISION_CONFLICT", message);
  if (/not found/i.test(message)) return new MotionAppError("NOT_FOUND", message);
  if (/Invalid workspace|Invalid web v1|Unsupported workspace|cycle/i.test(message)) return new MotionAppError("VALIDATION_FAILED", message);
  if (/SQLITE|database/i.test(message)) return new MotionAppError("STORAGE_FAILURE", message);
  return new MotionAppError("INTERNAL_ERROR", message);
}
