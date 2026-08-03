import {
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceDocument,
  assertWorkspaceValue,
  createWorkspace,
  exportFullWorkspace,
  migrateWebWorkspaceV1,
  type Block,
  type FullExport,
  type Page,
  type PageLink,
  type Workspace
} from "@motion/core";
import { SqliteWorkspaceStore, type SearchHit } from "@motion/storage";

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

export type AppCommand =
  | { type: "workspace.create"; name: string }
  | { type: "workspace.import-web-v1"; document: unknown; workspaceId?: string; workspaceName?: string; migratedAt?: string }
  | { type: "page.create"; workspaceId: string; expectedRevision: number; title: string; parentId?: string | null }
  | { type: "page.rename"; workspaceId: string; expectedRevision: number; pageId: string; title: string }
  | { type: "page.move"; workspaceId: string; expectedRevision: number; pageId: string; parentId: string | null }
  | { type: "page.trash"; workspaceId: string; expectedRevision: number; pageId: string }
  | { type: "page.restore"; workspaceId: string; expectedRevision: number; pageId: string }
  | { type: "page.replace-blocks"; workspaceId: string; expectedRevision: number; pageId: string; blocks: readonly Block[] };

export type AppQuery =
  | { type: "workspace.list" }
  | { type: "workspace.get"; workspaceId: string }
  | { type: "page.backlinks"; workspaceId: string; pageId: string }
  | { type: "workspace.search"; workspaceId: string; query: string; limit?: number }
  | { type: "workspace.export"; workspaceId: string };

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

const clone = <T>(value: T): T => structuredClone(value);
const immutable = <T>(value: T): Readonly<T> => deepFreeze(clone(value));
function deepFreeze<T>(value: T): Readonly<T> {
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
  constructor(private readonly store: SqliteWorkspaceStore) {}

  execute<C extends AppCommand>(command: C): CommandResults[C["type"]] {
    try { return this.executeUnsafe(command) as CommandResults[C["type"]]; }
    catch (error) { throw mapError(error); }
  }

  query<Q extends AppQuery>(query: Q): QueryResults[Q["type"]] {
    try { return this.queryUnsafe(query) as QueryResults[Q["type"]]; }
    catch (error) { throw mapError(error); }
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
        const page = requiredPage(document, command.pageId); page.blocks = clone(command.blocks) as Block[]; page.updatedAt = new Date().toISOString(); document.data.updatedAt = page.updatedAt; document.rebuildLinkIndex(); break;
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

  private required(workspaceId: string) {
    requiredText(workspaceId, "workspaceId");
    const loaded = this.store.load(workspaceId);
    if (!loaded) throw new MotionAppError("NOT_FOUND", `Workspace not found: ${workspaceId}`);
    assertWorkspaceValue(loaded.document);
    return loaded;
  }
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
