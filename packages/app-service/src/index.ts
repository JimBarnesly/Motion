import {
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceDocument,
  DEFAULT_VALIDATION_LIMITS,
  assertBlockTypePayload,
  assertWorkspaceValue,
  createWorkspace,
  exportFullWorkspace,
  migrateWebWorkspaceV1,
  stableId,
  type Block,
  type BlockContent,
  type BlockPosition,
  type BlockTransform,
  type Attachment,
  type FullExport,
  type DatabaseProperty,
  type DatabaseView,
  type PropertyValue,
  type Page,
  type PageLink,
  type Workspace
} from "@motion/core";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore, type FtsScopeType, type SearchHit, type StagedAttachment, type StoredWorkspace, type WorkspaceChangeSet } from "@motion/storage";
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

export type BlockSiblingPosition = Omit<BlockPosition, "pageId">;
export type BlockOperation =
  | { type: "block.create"; pageId: string; position: BlockSiblingPosition; block: Block }
  | { type: "block.update-content"; pageId: string; blockId: string; content: BlockContent }
  | { type: "block.transform"; pageId: string; blockId: string; transform: BlockTransform }
  | { type: "block.move"; pageId: string; blockId: string; target: BlockPosition }
  | { type: "block.indent"; pageId: string; blockId: string }
  | { type: "block.outdent"; pageId: string; blockId: string }
  | { type: "block.duplicate"; pageId: string; blockId: string; newBlockId: string }
  | { type: "block.delete"; pageId: string; blockId: string };
export type BlockCommand = BlockOperation & { workspaceId: string; expectedRevision: number };
export type BlockBatchCommand = { type: "block.batch"; workspaceId: string; expectedRevision: number; commands: readonly BlockOperation[] };

export type AppCommand =
  | BlockCommand
  | BlockBatchCommand
  | { type: "workspace.create"; name: string }
  | { type: "workspace.import-web-v1"; document: unknown; workspaceId?: string; workspaceName?: string; migratedAt?: string }
  | { type: "page.create"; workspaceId: string; expectedRevision: number; title: string; parentId?: string | null }
  | { type: "page.rename"; workspaceId: string; expectedRevision: number; pageId: string; title: string }
  | { type: "page.move"; workspaceId: string; expectedRevision: number; pageId: string; parentId: string | null }
  | { type: "page.reorder"; workspaceId: string; expectedRevision: number; pageId: string; beforePageId: string | null }
  | { type: "page.set-favourite"; workspaceId: string; expectedRevision: number; pageId: string; favourite: boolean }
  | { type: "page.trash"; workspaceId: string; expectedRevision: number; pageId: string }
  | { type: "page.restore"; workspaceId: string; expectedRevision: number; pageId: string }
  | { type: "page.replace-blocks"; workspaceId: string; expectedRevision: number; pageId: string; blocks: readonly Block[] }
  | { type: "database.create"; workspaceId: string; expectedRevision: number; title: string; parentId?: string | null }
  | { type: "database.property-add"; workspaceId: string; expectedRevision: number; databaseId: string; property: Omit<DatabaseProperty, "id"> }
  | { type: "database.property-update"; workspaceId: string; expectedRevision: number; databaseId: string; propertyId: string; patch: Partial<Omit<DatabaseProperty, "id">> }
  | { type: "database.property-delete"; workspaceId: string; expectedRevision: number; databaseId: string; propertyId: string }
  | { type: "database.record-create"; workspaceId: string; expectedRevision: number; databaseId: string; title: string; values?: Record<string, PropertyValue> }
  | { type: "database.record-update"; workspaceId: string; expectedRevision: number; pageId: string; title?: string; values: Record<string, PropertyValue | undefined> }
  | { type: "database.view-update"; workspaceId: string; expectedRevision: number; databaseId: string; viewId: string; patch: Partial<Omit<DatabaseView, "id" | "collectionId" | "type">> };

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
  "page.reorder": MutationDto;
  "page.set-favourite": MutationDto;
  "page.trash": MutationDto;
  "page.restore": MutationDto;
  "page.replace-blocks": MutationDto;
  "block.create": MutationDto;
  "block.update-content": MutationDto;
  "block.transform": MutationDto;
  "block.move": MutationDto;
  "block.indent": MutationDto;
  "block.outdent": MutationDto;
  "block.duplicate": MutationDto;
  "block.delete": MutationDto;
  "block.batch": MutationDto;
  "database.create": MutationDto;
  "database.property-add": MutationDto;
  "database.property-update": MutationDto;
  "database.property-delete": MutationDto;
  "database.record-create": MutationDto;
  "database.record-update": MutationDto;
  "database.view-update": MutationDto;
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
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > DEFAULT_VALIDATION_LIMITS.maxStringLength)
    throw new MotionAppError("INVALID_INPUT", `${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new MotionAppError("INVALID_INPUT", "expectedRevision must be a positive integer");
  return Number(value);
};
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactObject = (value: unknown, field: string, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> => {
  if (!plainObject(value)) throw new MotionAppError("INVALID_INPUT", `${field} must be a plain object`);
  const keys = Object.keys(value); if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
    throw new MotionAppError("INVALID_INPUT", `${field} has an invalid shape`);
  if (keys.some(key => value[key] === undefined)) throw new MotionAppError("INVALID_INPUT", `${field} must not contain undefined values`);
  return value;
};
const blockKeys = ["id", "type", "text", "children", "checked", "language", "attachmentId", "headingLevel", "pageId", "viewId", "date", "url", "references", "unknownData"] as const;
interface BlockInputState { blocks: number; references: number; payloadUnits: number }
const blockInputState = (): BlockInputState => ({ blocks: 0, references: 0, payloadUnits: 0 });
function inputId(value: unknown, field: string): string {
  try { return stableId(value, field); } catch { throw new MotionAppError("INVALID_INPUT", `${field} must be a safe stable ID`); }
}
function validateReference(value: unknown, field: string): void {
  const reference = exactObject(value, field, ["pageId", "start", "end"], ["pageId"]); inputId(reference.pageId, `${field}.pageId`);
  for (const key of ["start", "end"] as const) if (reference[key] !== undefined && (!Number.isSafeInteger(reference[key]) || Number(reference[key]) < 0)) throw new MotionAppError("INVALID_INPUT", `${field}.${key} must be a non-negative integer`);
  if ((reference.start === undefined) !== (reference.end === undefined) || (typeof reference.start === "number" && typeof reference.end === "number" && reference.start > reference.end)) throw new MotionAppError("INVALID_INPUT", `${field} must contain an ordered start/end pair`);
}
function validateTypedBlockFields(block: Record<string, unknown>, field: string, state: BlockInputState): void {
  if (block.checked !== undefined && typeof block.checked !== "boolean") throw new MotionAppError("INVALID_INPUT", `${field}.checked must be a boolean`);
  for (const key of ["language", "date", "url"] as const) if (block[key] !== undefined) requiredText(block[key], `${field}.${key}`, key === "language");
  for (const key of ["attachmentId", "pageId", "viewId"] as const) if (block[key] !== undefined) inputId(block[key], `${field}.${key}`);
  if (block.headingLevel !== undefined && ![1, 2, 3].includes(block.headingLevel as number)) throw new MotionAppError("INVALID_INPUT", `${field}.headingLevel must be 1, 2, or 3`);
  if (block.references !== undefined) {
    if (!Array.isArray(block.references) || block.references.length > DEFAULT_VALIDATION_LIMITS.maxReferences) throw new MotionAppError("INVALID_INPUT", `${field}.references must be an array within limits`);
    if ((state.references += block.references.length) > DEFAULT_VALIDATION_LIMITS.maxReferences) throw new MotionAppError("INVALID_INPUT", "block references exceed command limits");
    block.references.forEach((reference, index) => validateReference(reference, `${field}.references[${index}]`));
  }
  try { assertBlockTypePayload(block, field); } catch { throw new MotionAppError("INVALID_INPUT", `${field} has an invalid typed payload`); }
}
function validateUnknownData(value: unknown, field: string, state: BlockInputState): void {
  if (!plainObject(value)) throw new MotionAppError("INVALID_INPUT", `${field} must be a plain object`);
  const pending: { value: unknown; path: string; depth: number }[] = [{ value, path: field, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!; if (item.depth > DEFAULT_VALIDATION_LIMITS.maxBlockDepth) throw new MotionAppError("INVALID_INPUT", `${field} exceeds depth limit`);
    if (typeof item.value === "string") { requiredText(item.value, item.path, true); continue; }
    if (item.value === null || typeof item.value === "boolean") continue;
    if (typeof item.value === "number") { if (!Number.isFinite(item.value)) throw new MotionAppError("INVALID_INPUT", `${item.path} must be finite`); continue; }
    if (Array.isArray(item.value)) { if ((state.payloadUnits += item.value.length) > DEFAULT_VALIDATION_LIMITS.maxObjectKeys) throw new MotionAppError("INVALID_INPUT", `${field} exceeds size limit`); item.value.forEach((child, index) => pending.push({ value: child, path: `${item.path}[${index}]`, depth: item.depth + 1 })); continue; }
    if (!plainObject(item.value)) throw new MotionAppError("INVALID_INPUT", `${item.path} must contain JSON values`);
    const entries = Object.entries(item.value); if ((state.payloadUnits += entries.length) > DEFAULT_VALIDATION_LIMITS.maxObjectKeys) throw new MotionAppError("INVALID_INPUT", `${field} exceeds size limit`);
    for (const [key, child] of entries) { if (["__proto__", "prototype", "constructor"].includes(key) || child === undefined) throw new MotionAppError("INVALID_INPUT", `${item.path} has an invalid shape`); requiredText(key, `${item.path} key`, true); pending.push({ value: child, path: `${item.path}.${key}`, depth: item.depth + 1 }); }
  }
}
function validateBlockPayload(value: unknown, field = "block", state = blockInputState()): Block {
  const pending: { value: unknown; path: string; depth: number }[] = [{ value, path: field, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > DEFAULT_VALIDATION_LIMITS.maxBlockDepth || ++state.blocks > DEFAULT_VALIDATION_LIMITS.maxBlocks) throw new MotionAppError("INVALID_INPUT", `${field} exceeds block limits`);
    const block = exactObject(item.value, item.path, blockKeys, ["id", "type", "text", "children"]);
    inputId(block.id, `${item.path}.id`); requiredText(block.type, `${item.path}.type`); requiredText(block.text, `${item.path}.text`, true);
    if (!Array.isArray(block.children)) throw new MotionAppError("INVALID_INPUT", `${item.path}.children must be an array`);
    validateTypedBlockFields(block, item.path, state); if (block.unknownData !== undefined) validateUnknownData(block.unknownData, `${item.path}.unknownData`, state);
    if (item.depth >= DEFAULT_VALIDATION_LIMITS.maxBlockDepth && block.children.length) throw new MotionAppError("INVALID_INPUT", `${field} exceeds block limits`);
    if (block.children.length > DEFAULT_VALIDATION_LIMITS.maxBlocks - state.blocks - pending.length) throw new MotionAppError("INVALID_INPUT", `${field} exceeds block limits`);
    for (let index = 0; index < block.children.length; index++) pending.push({ value: block.children[index], path: `${item.path}.children[${index}]`, depth: item.depth + 1 });
  }
  return value as Block;
}
function validatePosition(value: unknown, field: string, includePage: boolean): BlockPosition {
  const allowed = includePage ? ["pageId", "parentBlockId", "beforeBlockId"] : ["parentBlockId", "beforeBlockId"];
  const position = exactObject(value, field, allowed);
  const pageId = includePage ? inputId(position.pageId, `${field}.pageId`) : "";
  for (const key of ["parentBlockId", "beforeBlockId"] as const) if (position[key] !== null) inputId(position[key], `${field}.${key}`);
  return { pageId, parentBlockId: position.parentBlockId as string | null, beforeBlockId: position.beforeBlockId as string | null };
}
function validateBlockOperation(value: unknown, envelope: boolean, blockState = blockInputState()): BlockOperation {
  if (!plainObject(value) || typeof value.type !== "string" || !value.type.startsWith("block.") || value.type === "block.batch") throw new MotionAppError("INVALID_INPUT", "Invalid block command type");
  const common = envelope ? ["workspaceId", "expectedRevision"] : [];
  const shape = (specific: string[]) => exactObject(value, "block command", ["type", ...common, ...specific]);
  switch (value.type) {
    case "block.create": { const command = shape(["pageId", "position", "block"]); inputId(command.pageId, "pageId"); validatePosition(command.position, "position", false); validateBlockPayload(command.block, "block", blockState); break; }
    case "block.update-content": { const command = shape(["pageId", "blockId", "content"]); inputId(command.pageId, "pageId"); inputId(command.blockId, "blockId"); const content = exactObject(command.content, "content", ["text", "references"], ["text"]); requiredText(content.text, "content.text", true); if (content.references !== undefined) { if (!Array.isArray(content.references) || content.references.length > DEFAULT_VALIDATION_LIMITS.maxReferences || (blockState.references += content.references.length) > DEFAULT_VALIDATION_LIMITS.maxReferences) throw new MotionAppError("INVALID_INPUT", "content.references must be an array within limits"); content.references.forEach((reference, index) => validateReference(reference, `content.references[${index}]`)); } break; }
    case "block.transform": { const command = shape(["pageId", "blockId", "transform"]); inputId(command.pageId, "pageId"); inputId(command.blockId, "blockId"); const transform = exactObject(command.transform, "transform", ["type", "checked", "language", "attachmentId", "headingLevel", "pageId", "viewId", "date", "url"], ["type"]); requiredText(transform.type, "transform.type"); validateTypedBlockFields(transform, "transform", blockState); break; }
    case "block.move": { const command = shape(["pageId", "blockId", "target"]); inputId(command.pageId, "pageId"); inputId(command.blockId, "blockId"); validatePosition(command.target, "target", true); break; }
    case "block.indent": case "block.outdent": case "block.delete": { const command = shape(["pageId", "blockId"]); inputId(command.pageId, "pageId"); inputId(command.blockId, "blockId"); break; }
    case "block.duplicate": { const command = shape(["pageId", "blockId", "newBlockId"]); inputId(command.pageId, "pageId"); inputId(command.blockId, "blockId"); inputId(command.newBlockId, "newBlockId"); break; }
    default: throw new MotionAppError("INVALID_INPUT", "Invalid block command type");
  }
  if (envelope) { inputId((value as Record<string, unknown>).workspaceId, "workspaceId"); revision((value as Record<string, unknown>).expectedRevision); }
  return value as BlockOperation;
}
function applyBlockOperation(document: WorkspaceDocument, operation: BlockOperation): void {
  const command = validateBlockOperation(operation, false);
  switch (command.type) {
    case "block.create": document.createBlock({ ...validatePosition(command.position, "position", false), pageId: command.pageId }, clone(command.block)); break;
    case "block.update-content": document.updateBlockContent(command.pageId, command.blockId, clone(command.content)); break;
    case "block.transform": document.transformBlock(command.pageId, command.blockId, clone(command.transform)); break;
    case "block.move": document.moveBlock(command.pageId, command.blockId, validatePosition(command.target, "target", true)); break;
    case "block.indent": document.indentBlock(command.pageId, command.blockId); break;
    case "block.outdent": document.outdentBlock(command.pageId, command.blockId); break;
    case "block.duplicate": document.duplicateBlock(command.pageId, command.blockId, command.newBlockId); break;
    case "block.delete": document.deleteBlock(command.pageId, command.blockId); break;
  }
}
function operationFromCommand(command: BlockCommand): BlockOperation {
  const { workspaceId: _workspaceId, expectedRevision: _expectedRevision, ...operation } = command;
  return operation as BlockOperation;
}

class MutationChangeSet {
  private readonly pageIds = new Set<string>();
  private readonly databaseIds = new Set<string>();
  private readonly attachmentIds = new Set<string>();
  private readonly linkSourceIds = new Set<string>();
  private readonly ftsScopes = new Map<string, { scope: FtsScopeType; id: string }>();
  page(id: string, options: { links?: boolean; fts?: boolean } = {}): void {
    this.pageIds.add(id);
    if (options.links) this.linkSourceIds.add(id);
    if (options.fts) this.ftsScopes.set(`page\u0000${id}`, { scope: "page", id });
  }
  database(id: string, fts = true): void {
    this.databaseIds.add(id);
    if (fts) this.ftsScopes.set(`database\u0000${id}`, { scope: "database", id });
  }
  attachment(id: string): void { this.attachmentIds.add(id); this.ftsScopes.set(`attachment\u0000${id}`, { scope: "attachment", id }); }
  block(operation: BlockOperation): void {
    this.page(operation.pageId, { links: true, fts: true });
    if (operation.type === "block.move") this.page(operation.target.pageId, { links: true, fts: true });
  }
  build(): Extract<WorkspaceChangeSet, { kind: "incremental" }> {
    const ordered = (values: Set<string>) => [...values].sort();
    return { kind: "incremental", pages: ordered(this.pageIds), databases: ordered(this.databaseIds), attachments: ordered(this.attachmentIds),
      linkSourcePageIds: ordered(this.linkSourceIds), fts: [...this.ftsScopes.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, scope]) => scope) };
  }
}

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
    try { await this.recoverAttachments(); return await this.executeAsyncUnsafe(command) as AsyncCommandResults[C["type"]]; }
    catch (error) { throw mapError(error); }
  }

  async queryAsync<Q extends AsyncAppQuery>(query: Q): Promise<AsyncQueryResults[Q["type"]]> {
    try { await this.recoverAttachments(); return await this.queryAsyncUnsafe(query) as AsyncQueryResults[Q["type"]]; }
    catch (error) { throw mapError(error); }
  }

  private attachmentStore(): ContentAddressedAttachmentStore {
    if (!this.attachments) throw new MotionAppError("STORAGE_FAILURE", "Attachment storage is not configured");
    return this.attachments;
  }

  private async recoverAttachments(): Promise<void> {
    if (!this.attachments) return;
    const hashes: string[] = [];
    for (const stored of this.store.list()) {
      assertWorkspaceValue(stored.document);
      hashes.push(...stored.document.attachments.map(attachment => validSha256(attachment.sha256)));
    }
    await this.attachments.recover(hashes);
  }

  private async executeAsyncUnsafe(command: AsyncAppCommand): Promise<MutationDto> {
    if (command.type === "attachment.put") {
      const expectedRevision = revision(command.expectedRevision);
      const loaded = this.required(command.workspaceId);
      const fileName = requiredText(command.fileName, "fileName");
      const mediaType = requiredText(command.mediaType, "mediaType");
      const sha256 = validSha256(command.sha256);
      if (!(command.bytes instanceof Uint8Array)) throw new MotionAppError("INVALID_INPUT", "bytes must be a Uint8Array");
      const document = clone(loaded.document);
      const id = command.id ? requiredText(command.id, "id") : crypto.randomUUID();
      if (document.attachments.some(item => item.id === id)) throw new MotionAppError("ALREADY_EXISTS", "Attachment already exists");
      const staged = await this.attachmentStore().stage(command.bytes);
      if (staged.sha256 !== sha256) {
        await this.attachmentStore().discard(staged);
        throw new MotionAppError("VALIDATION_FAILED", "Attachment bytes do not match declared sha256");
      }
      const now = new Date().toISOString();
      document.attachments.push({ id, fileName, mediaType, byteLength: staged.byteLength, sha256, path: staged.path, createdAt: now });
      document.updatedAt = now;
      assertWorkspaceValue(document);
      try {
        const changes = new MutationChangeSet(); changes.attachment(id);
        const savedRevision = this.store.saveUnitOfWork({ workspaceId: document.id, schemaVersion: document.schemaVersion, document, expectedRevision, changeSet: changes.build() });
        await this.attachmentStore().promote(staged);
        return immutable({ workspace: document, revision: savedRevision, saved: true as const }) as MutationDto;
      } catch (error) {
        const committed = Boolean((this.store.load(document.id)?.document as Workspace | undefined)?.attachments
          .some(attachment => attachment.id === id && attachment.sha256 === sha256));
        if (!committed) await this.attachmentStore().discard(staged);
        throw new MotionAppError(error instanceof Error && error.message.startsWith("Revision conflict") ? "REVISION_CONFLICT" : "STORAGE_FAILURE", committed
          ? "Attachment storage failed after metadata commit; recovery will retry content promotion."
          : "Attachment storage failed before metadata commit; staged content was discarded.", { metadataCommitted: committed });
      }
    }

    let restored: ReturnType<typeof restoreIntoNewWorkspace>;
    try {
      restored = restoreIntoNewWorkspace(command.bundle, command.newWorkspaceId);
      assertWorkspaceValue(restored.workspace);
    } catch {
      throw new MotionAppError("VALIDATION_FAILED", "Backup import rejected: invalid, oversized, or unsafe workspace content");
    }
    if (this.store.load(restored.workspace.id)) throw new MotionAppError("ALREADY_EXISTS", "Workspace already exists");
    const document = clone(restored.workspace);
    const stagedAttachments: StagedAttachment[] = [];
    try {
      for (const attachment of document.attachments) {
        const bytes = restored.attachments.get(attachment.id);
        if (!bytes) throw new MotionAppError("VALIDATION_FAILED", "Backup import rejected: restored attachment payload is missing");
        const staged = await this.attachmentStore().stage(bytes); stagedAttachments.push(staged);
        if (staged.sha256 !== attachment.sha256 || staged.byteLength !== attachment.byteLength) throw new MotionAppError("VALIDATION_FAILED", "Backup import rejected: restored attachment metadata does not match its payload");
        attachment.path = staged.path; // Never trust the archived source path.
      }
    } catch (error) {
      await Promise.all(stagedAttachments.map(staged => this.attachmentStore().discard(staged)));
      throw error;
    }
    assertWorkspaceValue(document);
    try {
      const savedRevision = this.store.saveUnitOfWork({ workspaceId: document.id, schemaVersion: document.schemaVersion, document, expectedRevision: 0 });
      await Promise.all(stagedAttachments.map(staged => this.attachmentStore().promote(staged)));
      return immutable({ workspace: document, revision: savedRevision, saved: true as const }) as MutationDto;
    } catch (error) {
      const committed = Boolean(this.store.load(document.id));
      if (!committed) await Promise.all(stagedAttachments.map(staged => this.attachmentStore().discard(staged)));
      throw new MotionAppError("STORAGE_FAILURE", committed
        ? "Backup restore storage failed after metadata commit; recovery will retry content promotion."
        : "Backup restore storage failed before metadata commit; staged content was discarded.", { metadataCommitted: committed });
    }
  }

  private async queryAsyncUnsafe(query: AsyncAppQuery): Promise<unknown> {
    if (query.type === "backup.verify") return immutable(verifyBackup(query.bundle));
    if (query.type === "backup.preview") return immutable(previewRestore(query.bundle));
    const loaded = this.required(query.workspaceId);
    if (query.type === "attachment.read") {
      const id = requiredText(query.attachmentId, "attachmentId");
      const attachment = loaded.document.attachments.find(item => item.id === id);
      if (!attachment) throw new MotionAppError("NOT_FOUND", "Attachment not found");
      const bytes = await this.attachmentStore().get(validSha256(attachment.sha256));
      if (bytes.byteLength !== attachment.byteLength) throw new MotionAppError("VALIDATION_FAILED", "Attachment content does not match its stored metadata");
      return immutable({ attachment, bytes });
    }
    const inputs = await Promise.all(loaded.document.attachments.map(async attachment => ({ id: attachment.id, fileName: attachment.fileName, mediaType: attachment.mediaType, bytes: await this.attachmentStore().get(validSha256(attachment.sha256)) })));
    return immutable(createBackup(loaded.document as unknown as import("@motion/backup").WorkspaceSnapshot, inputs, query.createdAt));
  }

  private executeUnsafe(command: AppCommand): MutationDto | ImportDto {
    if (!plainObject(command) || typeof command.type !== "string") throw new MotionAppError("INVALID_INPUT", "command must be a plain object with a type");
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
      if (this.store.load(migrated.workspace.id)) throw new MotionAppError("ALREADY_EXISTS", "Workspace already exists");
      const savedRevision = this.store.saveUnitOfWork({ workspaceId: migrated.workspace.id, schemaVersion: migrated.workspace.schemaVersion, document: migrated.workspace, expectedRevision: 0 });
      return immutable({ workspace: migrated.workspace, revision: savedRevision, saved: true as const, activePageId: migrated.uiState.activePageId }) as ImportDto;
    }
    if (command.type === "block.batch") {
      const batch = exactObject(command, "block.batch", ["type", "workspaceId", "expectedRevision", "commands"]);
      if (!Array.isArray(batch.commands) || batch.commands.length < 1 || batch.commands.length > DEFAULT_VALIDATION_LIMITS.maxBatchCommands) throw new MotionAppError("INVALID_INPUT", "commands must be a non-empty array within limits");
      inputId(batch.workspaceId, "workspaceId"); revision(batch.expectedRevision); const blockState = blockInputState();
      batch.commands.forEach(operation => validateBlockOperation(operation, false, blockState));
    } else if (command.type.startsWith("block.")) validateBlockOperation(command, true);
    const expectedRevision = revision(command.expectedRevision);
    const loaded = this.required(command.workspaceId);
    const document = new WorkspaceDocument(clone(loaded.document));
    const changes = new MutationChangeSet();
    switch (command.type) {
      case "block.batch": for (const operation of command.commands) { applyBlockOperation(document, operation); changes.block(operation); } break;
      case "block.create": case "block.update-content": case "block.transform": case "block.move":
      case "block.indent": case "block.outdent": case "block.duplicate": case "block.delete": {
        const operation = operationFromCommand(command); applyBlockOperation(document, operation); changes.block(operation); break;
      }
      case "page.create": { const page = document.addPage(requiredText(command.title, "title", true), command.parentId ?? null); changes.page(page.id, { links: true, fts: true }); break; }
      case "page.rename": {
        const page = requiredPage(document, command.pageId); page.title = requiredText(command.title, "title", true); const database = document.data.databases.find(candidate => candidate.pageId === page.id); if (database) { database.name = page.title; changes.database(database.id); } page.updatedAt = new Date().toISOString(); document.data.updatedAt = page.updatedAt; changes.page(page.id, { fts: true }); break;
      }
      case "page.move": { const pageId = requiredText(command.pageId, "pageId"); document.movePage(pageId, command.parentId); changes.page(pageId); break; }
      case "page.reorder": { const pageId = requiredText(command.pageId, "pageId"); document.reorderPage(pageId, command.beforePageId); changes.page(pageId); break; }
      case "page.set-favourite": { const page = requiredPage(document, command.pageId); page.favourite = Boolean(command.favourite); page.updatedAt = new Date().toISOString(); document.data.updatedAt = page.updatedAt; changes.page(page.id); break; }
      case "page.trash": {
        const page = requiredPage(document, command.pageId); const timestamp = new Date().toISOString(); for (const target of [page, ...document.descendants(page.id)]) { target.deletedAt = timestamp; target.updatedAt = timestamp; changes.page(target.id, { fts: true }); if (target.collectionId) changes.database(target.collectionId); for (const database of document.data.databases) if (database.pageId === target.id) changes.database(database.id); } document.data.updatedAt = timestamp; break;
      }
      case "page.restore": {
        const page = requiredPage(document, command.pageId); const timestamp = new Date().toISOString(); const targets = new Set([page]); let changed = true;
        while (changed) { changed = false; for (const candidate of document.data.pages) if (candidate.parentId && [...targets].some(target => target.id === candidate.parentId) && !targets.has(candidate)) { targets.add(candidate); changed = true; } }
        for (const target of [...targets]) { for (let parent = target.parentId ? document.page(target.parentId) : undefined; parent; parent = parent.parentId ? document.page(parent.parentId) : undefined) targets.add(parent); }
        for (const target of targets) { delete target.deletedAt; target.updatedAt = timestamp; changes.page(target.id, { fts: true }); if (target.collectionId) changes.database(target.collectionId); for (const database of document.data.databases) if (database.pageId === target.id) changes.database(database.id); } document.data.updatedAt = timestamp; break;
      }
      case "page.replace-blocks": {
        const page = requiredPage(document, command.pageId); page.blocks = clone(command.blocks) as Block[]; page.updatedAt = new Date().toISOString(); document.data.updatedAt = page.updatedAt;
        // Validate the candidate tree before any traversal-derived indexes are rebuilt.
        assertWorkspaceValue(document.data); document.rebuildLinkIndex(); changes.page(page.id, { links: true, fts: true }); break;
      }
      case "database.create": {
        const page = document.addPage(requiredText(command.title, "title", true), command.parentId ?? null);
        const titleId = crypto.randomUUID(); const databaseId = crypto.randomUUID();
        document.addDatabase({ id: databaseId, pageId: page.id, name: page.title, properties: [{ id: titleId, name: "Name", type: "title" }], rows: [], recordPageIds: [], views: [{ id: crypto.randomUUID(), collectionId: databaseId, name: "Table", type: "table", visiblePropertyIds: [titleId], propertyOrder: [titleId], columnWidths: { [titleId]: 280 }, sorts: [] }] });
        changes.page(page.id, { links: true, fts: true }); changes.database(databaseId); break;
      }
      case "database.property-add": { const databaseId = requiredText(command.databaseId, "databaseId"); document.addProperty(databaseId, clone(command.property)); changes.database(databaseId); break; }
      case "database.property-update": {
        const databaseId = requiredText(command.databaseId, "databaseId"); const database = document.data.databases.find(candidate => candidate.id === databaseId)!;
        document.updateProperty(databaseId, requiredText(command.propertyId, "propertyId"), clone(command.patch)); changes.database(databaseId);
        if (command.patch.type !== undefined) for (const pageId of database.recordPageIds ?? []) changes.page(pageId, { fts: true }); break;
      }
      case "database.property-delete": {
        const databaseId = requiredText(command.databaseId, "databaseId"); const database = document.data.databases.find(candidate => candidate.id === databaseId)!;
        document.deleteProperty(databaseId, requiredText(command.propertyId, "propertyId")); changes.database(databaseId);
        for (const pageId of database.recordPageIds ?? []) changes.page(pageId, { fts: true }); break;
      }
      case "database.record-create": {
        const databaseId = requiredText(command.databaseId, "databaseId"); const page = document.addRecord(databaseId, requiredText(command.title, "title", true), clone(command.values ?? {}));
        changes.database(databaseId); changes.page(page.id, { links: true, fts: true }); break;
      }
      case "database.record-update": {
        const pageId = requiredText(command.pageId, "pageId"); const page = requiredPage(document, pageId);
        document.updateRecord(pageId, command.title === undefined ? undefined : requiredText(command.title, "title", true), clone(command.values));
        if (page.collectionId) changes.database(page.collectionId); changes.page(pageId, { fts: true }); break;
      }
      case "database.view-update": { const databaseId = requiredText(command.databaseId, "databaseId"); document.updateView(databaseId, requiredText(command.viewId, "viewId"), clone(command.patch)); changes.database(databaseId); break; }
    }
    assertWorkspaceValue(document.data);
    const savedRevision = this.store.saveUnitOfWork({ workspaceId: document.data.id, schemaVersion: WORKSPACE_SCHEMA_VERSION, document: document.data, expectedRevision, changeSet: changes.build() });
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
    if (!loaded) throw new MotionAppError("NOT_FOUND", "Workspace not found");
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
  if (!page) throw new MotionAppError("NOT_FOUND", "Page not found");
  return page;
}
export function toAppError(error: unknown): MotionAppError {
  if (error instanceof MotionAppError) return error;
  const message = error instanceof Error ? error.message : "Unknown application error";
  if (message.startsWith("Revision conflict")) return new MotionAppError("REVISION_CONFLICT", "Workspace changed since it was loaded; reload and retry");
  if (/Invalid record property for collection/i.test(message)) return new MotionAppError("INVALID_INPUT", "Record values must use properties from their collection");
  if (/Invalid record target/i.test(message)) return new MotionAppError("INVALID_INPUT", "Record updates require a page indexed by exactly one matching collection");
  if (/not found/i.test(message)) return new MotionAppError("NOT_FOUND", "Requested local resource was not found");
  if (/Invalid workspace|Invalid web v1|Unsupported workspace|cycle|cannot contain children|cannot be (?:positioned|outdented)|no previous sibling|Backup verification|JSON|duplicate ID|exceeds .*limit|schemaVersion/i.test(message)) return new MotionAppError("VALIDATION_FAILED", "Workspace data failed validation");
  if (/SQLITE|database|Private (?:file|directory) path/i.test(message)) return new MotionAppError("STORAGE_FAILURE", "Local database operation failed");
  return new MotionAppError("INTERNAL_ERROR", "Unexpected local application failure");
}

const mapError = toAppError;
