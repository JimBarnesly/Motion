import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { DatabaseSync } from "node:sqlite";

export interface StoredWorkspace {
  workspaceId: string;
  schemaVersion: number;
  revision: number;
  document: unknown;
  updatedAt: string;
}

export interface StoredAttachment {
  sha256: string;
  byteLength: number;
  path: string;
}

export interface StagedAttachment extends StoredAttachment {
  /** Opaque private path; callers must use promote/discard rather than persisting it. */
  stagingPath: string;
}

export interface AttachmentRecoveryReport {
  promoted: string[];
  removedStaging: string[];
  missingReferenced: string[];
  unreferencedBlobs: string[];
}

export interface SearchHit {
  workspaceId: string;
  entityId: string;
  entityType: "page" | "block" | "row" | "entity";
  ownerEntityId?: string;
  title: string;
  snippet: string;
}

export type FtsScopeType = "workspace" | "page" | "database" | "attachment";
export type FtsChangeScope = Readonly<{ scope: FtsScopeType; id: string }>;

/**
 * Bounded derived-state work for one canonical workspace mutation. Arrays must be
 * sorted and duplicate-free so a command has one deterministic SQLite write set.
 * Omit the contract (or use rebuild) for imports, migrations, and exports that
 * intentionally rebuild every normalized/index row from the canonical snapshot.
 */
export type WorkspaceChangeSet =
  | Readonly<{ kind: "rebuild" }>
  | Readonly<{ kind: "incremental"; pages: readonly string[]; databases: readonly string[];
      attachments: readonly string[]; linkSourcePageIds: readonly string[]; fts: readonly FtsChangeScope[] }>;

export interface WorkspaceWriteStats {
  mode: "rebuild" | "incremental";
  pages: number;
  databases: number;
  attachments: number;
  linkSources: number;
  linksInserted: number;
  ftsScopes: number;
  ftsInserted: number;
}

export interface WorkspaceWrite {
  workspaceId: string;
  schemaVersion: number;
  document: unknown;
  expectedRevision?: number;
  changeSet?: WorkspaceChangeSet;
  /** Test/diagnostic hook. Throwing here proves the workspace and index share one transaction. */
  afterWorkspaceWrite?: () => void;
  /** Test/diagnostic hook after all derived writes but before the single commit. */
  beforeCommit?: () => void;
}

const migrations = [
  `CREATE TABLE IF NOT EXISTS motion_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    document_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS workspace_search USING fts5(
    workspace_id UNINDEXED,
    entity_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61'
  );
  CREATE TABLE IF NOT EXISTS reindex_jobs (
    job_id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    workspace_revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'complete')),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(workspace_id, workspace_revision),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS reindex_jobs_status_idx ON reindex_jobs(status, job_id);`
  ,
  `DROP TABLE workspace_search;
  CREATE VIRTUAL TABLE workspace_search USING fts5(
    workspace_id UNINDEXED,
    entity_id UNINDEXED,
    entity_type UNINDEXED,
    owner_entity_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61'
  );
  INSERT INTO reindex_jobs(workspace_id, workspace_revision, status, created_at)
    SELECT workspace_id, revision, 'pending', updated_at FROM workspaces WHERE true
    ON CONFLICT(workspace_id, workspace_revision) DO UPDATE SET status='pending', completed_at=NULL;`,
  `DROP TABLE workspace_search;
  CREATE VIRTUAL TABLE workspace_search USING fts5(
    workspace_id UNINDEXED,
    entity_id UNINDEXED,
    entity_type UNINDEXED,
    owner_entity_id UNINDEXED,
    scope_type UNINDEXED,
    scope_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61'
  );
  CREATE TABLE workspace_pages (
    workspace_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    page_json TEXT NOT NULL,
    PRIMARY KEY(workspace_id, page_id),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
  );
  CREATE TABLE workspace_databases (
    workspace_id TEXT NOT NULL,
    database_id TEXT NOT NULL,
    database_json TEXT NOT NULL,
    PRIMARY KEY(workspace_id, database_id),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
  );
  CREATE TABLE workspace_attachments (
    workspace_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    attachment_json TEXT NOT NULL,
    PRIMARY KEY(workspace_id, attachment_id),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
  );
  CREATE TABLE workspace_links (
    workspace_id TEXT NOT NULL,
    source_page_id TEXT NOT NULL,
    target_page_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    PRIMARY KEY(workspace_id, source_page_id, block_id, target_page_id),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
  );
  CREATE INDEX workspace_links_target_idx ON workspace_links(workspace_id, target_page_id, source_page_id);
  INSERT INTO reindex_jobs(workspace_id, workspace_revision, status, created_at)
    SELECT workspace_id, revision, 'pending', updated_at FROM workspaces WHERE true
    ON CONFLICT(workspace_id, workspace_revision) DO UPDATE SET status='pending', completed_at=NULL;`
];

const digest = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");
const requireSha256 = (value: string): void => {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Attachment hash must be 64 lowercase hexadecimal characters");
};

const MAX_CHANGE_SET_ENTRIES = 100_000;
const SAFE_CHANGE_SET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function normalizeChangeSet(changeSet: WorkspaceChangeSet): WorkspaceChangeSet {
  if (changeSet.kind === "rebuild") return changeSet;
  const assertOrdered = (values: readonly string[], label: string): void => {
    if (!Array.isArray(values) || values.length > MAX_CHANGE_SET_ENTRIES) throw new Error(`${label} must be an array within limits`);
    if (values.some(value => typeof value !== "string" || !SAFE_CHANGE_SET_ID.test(value)))
      throw new Error(`${label} must contain safe canonical IDs`);
    for (let index = 1; index < values.length; index++) if (values[index - 1]! >= values[index]!)
      throw new Error(`${label} must be sorted and duplicate-free`);
  };
  assertOrdered(changeSet.pages, "changeSet.pages");
  assertOrdered(changeSet.databases, "changeSet.databases");
  assertOrdered(changeSet.attachments, "changeSet.attachments");
  assertOrdered(changeSet.linkSourcePageIds, "changeSet.linkSourcePageIds");
  if (!Array.isArray(changeSet.fts) || changeSet.fts.length > MAX_CHANGE_SET_ENTRIES)
    throw new Error("changeSet.fts must be an array within limits");
  if (changeSet.fts.some(scope => !scope || typeof scope !== "object" || !SAFE_CHANGE_SET_ID.test(scope.id)
      || !(["workspace", "page", "database", "attachment"] as const).includes(scope.scope)))
    throw new Error("changeSet.fts contains an invalid scope or ID");
  const ftsKeys = changeSet.fts.map(scope => `${scope.scope}\u0000${scope.id}`);
  for (let index = 1; index < ftsKeys.length; index++) if (ftsKeys[index - 1]! >= ftsKeys[index]!)
    throw new Error("changeSet.fts must be sorted and duplicate-free");
  return changeSet;
}

type WorkspaceParts = { pages: Record<string, unknown>[]; databases: Record<string, unknown>[]; attachments: Record<string, unknown>[];
  links: { sourcePageId: string; targetPageId: string; blockId: string }[] };
const entityId = (entity: Record<string, unknown>): string => {
  if (typeof entity.id !== "string" || !entity.id) throw new Error("Normalized workspace entities require an ID");
  return entity.id;
};
function workspaceParts(document: unknown): WorkspaceParts {
  const record = document && typeof document === "object" && !Array.isArray(document) ? document as Record<string, unknown> : {};
  const entities = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
  const links = entities(record.linkIndex).map(link => {
    if (typeof link.sourcePageId !== "string" || typeof link.targetPageId !== "string" || typeof link.blockId !== "string")
      throw new Error("Normalized workspace links require source, target, and block IDs");
    return { sourcePageId: link.sourcePageId, targetPageId: link.targetPageId, blockId: link.blockId };
  });
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  links.sort((left, right) => compare(left.sourcePageId, right.sourcePageId) || compare(left.blockId, right.blockId) || compare(left.targetPageId, right.targetPageId));
  return { pages: entities(record.pages), databases: entities(record.databases), attachments: entities(record.attachments), links };
}

function keyedEntities(entities: readonly Record<string, unknown>[], label: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const entity of entities) {
    const id = entityId(entity);
    if (result.has(id)) throw new Error(`Duplicate normalized ${label} ID: ${id}`);
    result.set(id, JSON.stringify(entity));
  }
  return result;
}

function changedKeys(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter(key => before.get(key) !== after.get(key)).sort();
}

function linkScopes(parts: WorkspaceParts): Map<string, string> {
  const grouped = new Map<string, { sourcePageId: string; targetPageId: string; blockId: string }[]>();
  for (const link of parts.links) grouped.set(link.sourcePageId, [...(grouped.get(link.sourcePageId) ?? []), link]);
  return new Map([...grouped].map(([id, links]) => [id, JSON.stringify(links)]));
}

function searchScopes(document: unknown, workspaceId: string): Map<string, string> {
  const entries = extractWorkspaceSearchEntries(document, workspaceId);
  const grouped = new Map<string, SearchEntry[]>();
  for (const entry of entries) {
    const key = `${entry.scopeType}\u0000${entry.scopeId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return new Map([...grouped].map(([key, values]) => [key, JSON.stringify(values)]));
}

function assertChangeSetCovers(workspaceId: string, beforeDocument: unknown, afterDocument: unknown,
  changeSet: Extract<WorkspaceChangeSet, { kind: "incremental" }>): void {
  const before = workspaceParts(beforeDocument); const after = workspaceParts(afterDocument);
  const required = {
    pages: changedKeys(keyedEntities(before.pages, "page"), keyedEntities(after.pages, "page")),
    databases: changedKeys(keyedEntities(before.databases, "database"), keyedEntities(after.databases, "database")),
    attachments: changedKeys(keyedEntities(before.attachments, "attachment"), keyedEntities(after.attachments, "attachment")),
    linkSourcePageIds: changedKeys(linkScopes(before), linkScopes(after)),
    fts: changedKeys(searchScopes(beforeDocument, workspaceId), searchScopes(afterDocument, workspaceId))
  };
  const supplied = {
    pages: new Set(changeSet.pages), databases: new Set(changeSet.databases), attachments: new Set(changeSet.attachments),
    linkSourcePageIds: new Set(changeSet.linkSourcePageIds), fts: new Set(changeSet.fts.map(scope => `${scope.scope}\u0000${scope.id}`))
  };
  for (const [label, ids] of Object.entries(required) as [keyof typeof required, string[]][]) {
    const missing = ids.filter(id => !supplied[label].has(id));
    if (missing.length) throw new Error(`Incremental change set omits dirty ${label}: ${missing.join(", ")}`);
  }
}

type PrivatePathKind = "file" | "directory";
function hardenPrivatePath(path: string, kind: PrivatePathKind): void {
  if (platform() === "win32") return;
  let metadata: ReturnType<typeof lstatSync>;
  try { metadata = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (metadata.isSymbolicLink()) throw new Error(`Private ${kind} path must not be a symbolic link`);
  if (kind === "file" ? !metadata.isFile() : !metadata.isDirectory()) throw new Error(`Private ${kind} path has an unexpected type`);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (kind === "directory" ? constants.O_DIRECTORY : 0);
  const descriptor = openSync(path, flags);
  try { fchmodSync(descriptor, kind === "directory" ? 0o700 : 0o600); }
  finally { closeSync(descriptor); }
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  hardenPrivatePath(path, "directory");
}

export function hardenPrivateFile(path: string): void { hardenPrivatePath(path, "file"); }

/** Durable local repository. UI/domain entities cross this boundary as versioned JSON, never SQLite rows. */
export class SqliteWorkspaceStore {
  readonly database: DatabaseSync;
  private writeStats: Readonly<WorkspaceWriteStats> | undefined;
  private readonly databasePath: string;

  /** Deterministic counters for the last successfully committed write; never updated by rolled-back work. */
  get lastWriteStats(): Readonly<WorkspaceWriteStats> | undefined { return this.writeStats; }

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    const databaseDirectory = dirname(databasePath);
    let databaseDirectoryState: ReturnType<typeof lstatSync> | undefined;
    try { databaseDirectoryState = lstatSync(databaseDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!databaseDirectoryState) ensurePrivateDirectory(databaseDirectory);
    else if (!databaseDirectoryState.isDirectory() || databaseDirectoryState.isSymbolicLink()) throw new Error("Database directory has an unexpected type");
    if (platform() !== "win32") {
      const descriptor = openSync(databasePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(descriptor, 0o600); } finally { closeSync(descriptor); }
    }
    this.hardenDatabaseFiles();
    this.database = new DatabaseSync(databasePath);
    try {
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.migrate();
      this.runPendingReindexJobs();
      this.hardenDatabaseFiles();
    } catch (error) { this.database.close(); throw error; }
  }

  close(): void { this.hardenDatabaseFiles(); this.database.close(); this.hardenDatabaseFiles(); }

  private hardenDatabaseFiles(): void {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) hardenPrivateFile(path);
  }

  save(workspaceId: string, schemaVersion: number, document: unknown, expectedRevision?: number): number {
    return this.saveUnitOfWork({ workspaceId, schemaVersion, document, expectedRevision });
  }

  saveUnitOfWork(write: WorkspaceWrite): number {
    const changeSet = normalizeChangeSet(write.changeSet ?? { kind: "rebuild" });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT revision, document_json FROM workspaces WHERE workspace_id = ?").get(write.workspaceId) as
        { revision: number; document_json: string } | undefined;
      const currentRevision = Number(row?.revision ?? 0);
      if (write.expectedRevision !== undefined && currentRevision !== write.expectedRevision) {
        throw new Error(`Revision conflict for workspace ${write.workspaceId}`);
      }
      if (!row && changeSet.kind === "incremental") throw new Error("Incremental writes require an existing canonical workspace");
      if (row && changeSet.kind === "incremental") assertChangeSetCovers(write.workspaceId, JSON.parse(row.document_json), write.document, changeSet);
      const revision = currentRevision + 1;
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO workspaces(workspace_id, schema_version, revision, document_json, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET schema_version=excluded.schema_version,
        revision=excluded.revision, document_json=excluded.document_json, updated_at=excluded.updated_at`)
        .run(write.workspaceId, write.schemaVersion, revision, JSON.stringify(write.document), now);
      this.database.prepare(`INSERT INTO reindex_jobs(workspace_id, workspace_revision, status, created_at)
        VALUES (?, ?, 'pending', ?)` ).run(write.workspaceId, revision, now);
      write.afterWorkspaceWrite?.();
      const stats = changeSet.kind === "rebuild"
        ? this.rebuildDerivedWorkspace(write.workspaceId, write.document)
        : this.applyIncrementalChangeSet(write.workspaceId, write.document, changeSet);
      this.database.prepare("UPDATE reindex_jobs SET status='complete', completed_at=? WHERE workspace_id=? AND workspace_revision=?")
        .run(now, write.workspaceId, revision);
      write.beforeCommit?.();
      this.database.exec("COMMIT");
      this.writeStats = Object.freeze(stats);
      this.hardenDatabaseFiles();
      return revision;
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.hardenDatabaseFiles();
      throw error;
    }
  }

  load(workspaceId: string): StoredWorkspace | undefined {
    const row = this.database.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      workspaceId: String(row.workspace_id),
      schemaVersion: Number(row.schema_version),
      revision: Number(row.revision),
      document: JSON.parse(String(row.document_json)),
      updatedAt: String(row.updated_at)
    };
  }

  list(): StoredWorkspace[] {
    const rows = this.database.prepare("SELECT * FROM workspaces ORDER BY updated_at DESC, workspace_id").all() as Record<string, unknown>[];
    return rows.map((row) => ({ workspaceId: String(row.workspace_id), schemaVersion: Number(row.schema_version),
      revision: Number(row.revision), document: JSON.parse(String(row.document_json)), updatedAt: String(row.updated_at) }));
  }

  remove(workspaceId: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM workspace_search WHERE workspace_id = ?").run(workspaceId);
      this.database.prepare("DELETE FROM workspaces WHERE workspace_id = ?").run(workspaceId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  search(query: string, workspaceId?: string, limit = 50): SearchHit[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const sql = workspaceId
      ? "SELECT workspace_id, entity_id, entity_type, owner_entity_id, title, snippet(workspace_search, 7, '[', ']', '…', 12) snippet FROM workspace_search WHERE workspace_search MATCH ? AND workspace_id = ? ORDER BY rank, entity_id LIMIT ?"
      : "SELECT workspace_id, entity_id, entity_type, owner_entity_id, title, snippet(workspace_search, 7, '[', ']', '…', 12) snippet FROM workspace_search WHERE workspace_search MATCH ? ORDER BY rank, workspace_id, entity_id LIMIT ?";
    const rows = (workspaceId
      ? this.database.prepare(sql).all(match, workspaceId, boundedLimit)
      : this.database.prepare(sql).all(match, boundedLimit)) as Record<string, unknown>[];
    return rows.map((row) => ({ workspaceId: String(row.workspace_id), entityId: String(row.entity_id),
      entityType: String(row.entity_type) as SearchHit["entityType"],
      ...(row.owner_entity_id === null ? {} : { ownerEntityId: String(row.owner_entity_id) }),
      title: String(row.title), snippet: String(row.snippet) }));
  }

  runPendingReindexJobs(): number {
    const jobs = this.database.prepare("SELECT job_id, workspace_id FROM reindex_jobs WHERE status='pending' ORDER BY job_id").all() as { job_id: number; workspace_id: string }[];
    for (const job of jobs) {
      const workspace = this.load(job.workspace_id);
      if (!workspace) continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.rebuildDerivedWorkspace(job.workspace_id, workspace.document);
        this.database.prepare("UPDATE reindex_jobs SET status='complete', completed_at=? WHERE job_id=?").run(new Date().toISOString(), job.job_id);
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
    return jobs.length;
  }

  private rebuildDerivedWorkspace(workspaceId: string, document: unknown): WorkspaceWriteStats {
    const parts = workspaceParts(document);
    this.database.prepare("DELETE FROM workspace_pages WHERE workspace_id = ?").run(workspaceId);
    this.database.prepare("DELETE FROM workspace_databases WHERE workspace_id = ?").run(workspaceId);
    this.database.prepare("DELETE FROM workspace_attachments WHERE workspace_id = ?").run(workspaceId);
    this.database.prepare("DELETE FROM workspace_links WHERE workspace_id = ?").run(workspaceId);
    const insertPage = this.database.prepare("INSERT INTO workspace_pages(workspace_id, page_id, page_json) VALUES (?, ?, ?)");
    const insertDatabase = this.database.prepare("INSERT INTO workspace_databases(workspace_id, database_id, database_json) VALUES (?, ?, ?)");
    const insertAttachment = this.database.prepare("INSERT INTO workspace_attachments(workspace_id, attachment_id, attachment_json) VALUES (?, ?, ?)");
    const insertLink = this.database.prepare("INSERT INTO workspace_links(workspace_id, source_page_id, target_page_id, block_id) VALUES (?, ?, ?, ?)");
    for (const page of parts.pages) insertPage.run(workspaceId, entityId(page), JSON.stringify(page));
    for (const database of parts.databases) insertDatabase.run(workspaceId, entityId(database), JSON.stringify(database));
    for (const attachment of parts.attachments) insertAttachment.run(workspaceId, entityId(attachment), JSON.stringify(attachment));
    for (const link of parts.links) insertLink.run(workspaceId, link.sourcePageId, link.targetPageId, link.blockId);
    this.database.prepare("DELETE FROM workspace_search WHERE workspace_id = ?").run(workspaceId);
    const entries = extractWorkspaceSearchEntries(document, workspaceId);
    this.insertSearchEntries(workspaceId, entries);
    return { mode: "rebuild", pages: parts.pages.length, databases: parts.databases.length, attachments: parts.attachments.length,
      linkSources: new Set(parts.links.map(link => link.sourcePageId)).size, linksInserted: parts.links.length,
      ftsScopes: entries.length ? new Set(entries.map(entry => `${entry.scopeType}:${entry.scopeId}`)).size : 0, ftsInserted: entries.length };
  }

  private applyIncrementalChangeSet(workspaceId: string, document: unknown, changeSet: Extract<WorkspaceChangeSet, { kind: "incremental" }>): WorkspaceWriteStats {
    const parts = workspaceParts(document);
    this.syncJsonRows(workspaceId, "workspace_pages", "page_id", "page_json", changeSet.pages, parts.pages);
    this.syncJsonRows(workspaceId, "workspace_databases", "database_id", "database_json", changeSet.databases, parts.databases);
    this.syncJsonRows(workspaceId, "workspace_attachments", "attachment_id", "attachment_json", changeSet.attachments, parts.attachments);
    const deleteLinks = this.database.prepare("DELETE FROM workspace_links WHERE workspace_id=? AND source_page_id=?");
    const insertLink = this.database.prepare("INSERT INTO workspace_links(workspace_id, source_page_id, target_page_id, block_id) VALUES (?, ?, ?, ?)");
    for (const sourcePageId of changeSet.linkSourcePageIds) deleteLinks.run(workspaceId, sourcePageId);
    const linkSources = new Set(changeSet.linkSourcePageIds);
    const links = parts.links.filter(link => linkSources.has(link.sourcePageId));
    for (const link of links) insertLink.run(workspaceId, link.sourcePageId, link.targetPageId, link.blockId);
    const deleteFts = this.database.prepare("DELETE FROM workspace_search WHERE workspace_id=? AND scope_type=? AND scope_id=?");
    let ftsInserted = 0;
    for (const scope of changeSet.fts) {
      deleteFts.run(workspaceId, scope.scope, scope.id);
      const candidates = scope.scope === "page" ? parts.pages : scope.scope === "database" ? parts.databases : scope.scope === "attachment" ? parts.attachments : [];
      const entity = scope.scope === "workspace" ? document : candidates.find(value => entityId(value) === scope.id);
      if (entity === undefined) continue;
      const entries = scope.scope === "workspace"
        ? extractWorkspaceRootSearchEntries(document, workspaceId)
        : extractSearchEntries(entity, scope.id, scope.scope, scope.id);
      this.insertSearchEntries(workspaceId, entries); ftsInserted += entries.length;
    }
    return { mode: "incremental", pages: changeSet.pages.length, databases: changeSet.databases.length,
      attachments: changeSet.attachments.length, linkSources: changeSet.linkSourcePageIds.length,
      linksInserted: links.length, ftsScopes: changeSet.fts.length, ftsInserted };
  }

  private syncJsonRows(workspaceId: string, table: string, idColumn: string, jsonColumn: string, ids: readonly string[], entities: readonly Record<string, unknown>[]): void {
    const remove = this.database.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND ${idColumn}=?`);
    const upsert = this.database.prepare(`INSERT INTO ${table}(workspace_id, ${idColumn}, ${jsonColumn}) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, ${idColumn}) DO UPDATE SET ${jsonColumn}=excluded.${jsonColumn}`);
    for (const id of ids) {
      const entity = entities.find(value => entityId(value) === id);
      if (entity) upsert.run(workspaceId, id, JSON.stringify(entity)); else remove.run(workspaceId, id);
    }
  }

  private insertSearchEntries(workspaceId: string, entries: readonly SearchEntry[]): void {
    const insert = this.database.prepare(`INSERT INTO workspace_search(
      workspace_id, entity_id, entity_type, owner_entity_id, scope_type, scope_id, title, body
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const entry of entries) insert.run(workspaceId, entry.entityId, entry.entityType, entry.ownerEntityId ?? null,
      entry.scopeType, entry.scopeId, entry.title, entry.body);
  }

  private migrate(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`CREATE TABLE IF NOT EXISTS motion_migrations (
        version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL
      )`);
      const insert = this.database.prepare("INSERT OR IGNORE INTO motion_migrations(version, applied_at, checksum) VALUES (?, ?, ?)");
      for (const [index, migration] of migrations.entries()) {
        const version = index + 1;
        const existing = this.database.prepare("SELECT checksum FROM motion_migrations WHERE version=?").get(version) as { checksum: string } | undefined;
        if (existing && existing.checksum !== digest(migration)) throw new Error(`Migration checksum mismatch at version ${version}`);
        if (!existing) { this.database.exec(migration); insert.run(version, new Date().toISOString(), digest(migration)); }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

/** Converts arbitrary user input to an FTS expression containing literals only. */
export function toFtsQuery(input: string): string {
  const tokens = input.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.slice(0, 32).map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

type SearchEntry = { entityId: string; entityType: SearchHit["entityType"]; ownerEntityId?: string; title: string; body: string;
  scopeType: FtsScopeType; scopeId: string };

function extractWorkspaceRootSearchEntries(document: unknown, fallbackId: string): SearchEntry[] {
  if (!document || typeof document !== "object" || Array.isArray(document)) return extractSearchEntries(document, fallbackId, "workspace", fallbackId);
  const root = { ...(document as Record<string, unknown>) };
  delete root.pages; delete root.databases; delete root.attachments; delete root.linkIndex;
  return extractSearchEntries(root, fallbackId, "workspace", fallbackId);
}

function extractWorkspaceSearchEntries(document: unknown, fallbackId: string): SearchEntry[] {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return extractSearchEntries(document, fallbackId, "workspace", fallbackId);
  }
  const result = extractWorkspaceRootSearchEntries(document, fallbackId);
  const parts = workspaceParts(document);
  for (const page of parts.pages) result.push(...extractSearchEntries(page, entityId(page), "page", entityId(page)));
  for (const database of parts.databases) result.push(...extractSearchEntries(database, entityId(database), "database", entityId(database)));
  for (const attachment of parts.attachments) result.push(...extractSearchEntries(attachment, entityId(attachment), "attachment", entityId(attachment)));
  if (result.length === 0) result.push({ entityId: fallbackId, entityType: "entity", title: "", body: JSON.stringify(document), scopeType: "workspace", scopeId: fallbackId });
  return result;
}

function extractSearchEntries(document: unknown, fallbackId: string, scopeType: SearchEntry["scopeType"], scopeId: string): SearchEntry[] {
  const result: SearchEntry[] = [];
  const scalarText = (value: unknown): string[] => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
    if (Array.isArray(value)) return value.flatMap(scalarText);
    if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(scalarText);
    return [];
  };
  const visit = (value: unknown, path: string, contextTitle = "", ownerEntityId?: string, hint?: "page" | "block" | "row"): void => {
    if (Array.isArray(value)) { value.forEach((child, index) => visit(child, `${path}.${index}`, contextTitle, ownerEntityId, hint)); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : path;
    const title = typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : contextTitle;
    const isRow = hint === "row" || (record.values && typeof record.values === "object" && !Array.isArray(record.values));
    const entityType: SearchEntry["entityType"] = isRow ? "row" : hint ?? (Array.isArray(record.blocks) ? "page" : "entity");
    const text = [record.text, record.content, record.label, ...scalarText(record.values)].filter((part): part is string => typeof part === "string").join(" ");
    if (title || text) result.push({ entityId: id, entityType, ...(ownerEntityId ? { ownerEntityId } : {}), title, body: text, scopeType, scopeId });
    for (const [key, child] of Object.entries(record)) {
      if (typeof child !== "object" || child === null || key === "values") continue;
      if (key === "pages" && Array.isArray(child)) child.forEach((page, index) => visit(page, `${path}.${key}.${index}`, "", undefined, "page"));
      else if (key === "blocks") visit(child, `${path}.${key}`, title, id, "block");
      else if (key === "rows") visit(child, `${path}.${key}`, title, typeof record.pageId === "string" ? record.pageId : id, "row");
      else visit(child, `${path}.${key}`, title, ownerEntityId);
    }
  };
  visit(document, fallbackId);
  if (result.length === 0) result.push({ entityId: fallbackId, entityType: "entity", title: "", body: JSON.stringify(document), scopeType, scopeId });
  return result;
}

/** Promise-shaped facade structurally compatible with core WorkspaceStore. */
export class AsyncSqliteWorkspaceStore<T extends { id: string; name: string; updatedAt: string; schemaVersion?: number }> {
  constructor(private readonly store: SqliteWorkspaceStore) {}
  async load(workspaceId: string): Promise<T | undefined> { return this.store.load(workspaceId)?.document as T | undefined; }
  async save(workspace: T): Promise<void> { this.store.save(workspace.id, workspace.schemaVersion ?? 1, workspace); }
  async list(): Promise<Pick<T, "id" | "name" | "updatedAt">[]> {
    return this.store.list().map(({ document }) => { const value = document as T; return { id: value.id, name: value.name, updatedAt: value.updatedAt }; });
  }
  async remove(workspaceId: string): Promise<void> { this.store.remove(workspaceId); }
}

/** Files are immutable and addressed by content hash; metadata remains in the workspace database. */
export class ContentAddressedAttachmentStore {
  constructor(private readonly root: string) { ensurePrivateDirectory(root); }

  async stage(bytes: Uint8Array): Promise<StagedAttachment> {
    const sha256 = digest(bytes);
    const finalPath = join(this.root, sha256.slice(0, 2), sha256);
    const stagingRoot = join(this.root, ".staging");
    ensurePrivateDirectory(this.root);
    ensurePrivateDirectory(stagingRoot);
    const stagingPath = join(stagingRoot, `${sha256}.${crypto.randomUUID()}.staging`);
    await writeFile(stagingPath, bytes, { flag: "wx", mode: 0o600 });
    return { sha256, byteLength: bytes.byteLength, path: finalPath, stagingPath };
  }

  async promote(staged: StagedAttachment): Promise<StoredAttachment> {
    requireSha256(staged.sha256);
    const bytes = await readFile(staged.stagingPath);
    if (bytes.byteLength !== staged.byteLength || digest(bytes) !== staged.sha256) {
      throw new Error(`Staged attachment integrity check failed: ${staged.sha256}`);
    }
    hardenPrivateFile(staged.stagingPath);
    ensurePrivateDirectory(dirname(staged.path));
    try {
      hardenPrivateFile(staged.path);
      const current = await readFile(staged.path);
      if (current.byteLength !== staged.byteLength || digest(current) !== staged.sha256) throw new Error(`Attachment hash collision at ${staged.path}`);
      await this.discard(staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rename(staged.stagingPath, staged.path);
    }
    return { sha256: staged.sha256, byteLength: staged.byteLength, path: staged.path };
  }

  async discard(staged: StagedAttachment): Promise<void> {
    await rm(staged.stagingPath, { force: true });
  }

  /**
   * Repairs interrupted metadata-then-promote writes and removes abandoned staging.
   * Final unreferenced blobs are reported, not deleted: retention/GC policy is separate.
   */
  async recover(referencedHashes: Iterable<string>): Promise<AttachmentRecoveryReport> {
    ensurePrivateDirectory(this.root);
    ensurePrivateDirectory(join(this.root, ".staging"));
    const referenced = new Set(referencedHashes);
    for (const sha256 of referenced) requireSha256(sha256);
    const report: AttachmentRecoveryReport = { promoted: [], removedStaging: [], missingReferenced: [], unreferencedBlobs: [] };
    const stagingRoot = join(this.root, ".staging");
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await readdir(stagingRoot, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const stagingPath = join(stagingRoot, entry.name);
      const match = /^([0-9a-f]{64})\.[0-9a-f-]+\.staging$/.exec(entry.name);
      if (!entry.isFile() || !match) { await rm(stagingPath, { recursive: true, force: true }); report.removedStaging.push(entry.name); continue; }
      const sha256 = match[1]!;
      const bytes = await readFile(stagingPath);
      if (digest(bytes) !== sha256 || !referenced.has(sha256)) {
        await rm(stagingPath, { force: true }); report.removedStaging.push(entry.name); continue;
      }
      const staged = { sha256, byteLength: bytes.byteLength, path: join(this.root, sha256.slice(0, 2), sha256), stagingPath };
      await this.promote(staged);
      if (!report.promoted.includes(sha256)) report.promoted.push(sha256);
    }
    let buckets: import("node:fs").Dirent[] = [];
    try { buckets = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const present = new Set<string>();
    for (const bucket of buckets) {
      if (!bucket.isDirectory() || !/^[0-9a-f]{2}$/.test(bucket.name)) continue;
      for (const blob of await readdir(join(this.root, bucket.name), { withFileTypes: true })) {
        if (blob.isFile() && /^[0-9a-f]{64}$/.test(blob.name)) present.add(blob.name);
      }
    }
    report.missingReferenced = [...referenced].filter(sha256 => !present.has(sha256)).sort();
    report.unreferencedBlobs = [...present].filter(sha256 => !referenced.has(sha256)).sort();
    return report;
  }

  async put(bytes: Uint8Array): Promise<StoredAttachment> {
    const staged = await this.stage(bytes);
    try { return await this.promote(staged); }
    catch (error) { await this.discard(staged); throw error; }
  }

  async get(sha256: string): Promise<Uint8Array> {
    requireSha256(sha256);
    ensurePrivateDirectory(this.root);
    const bucket = join(this.root, sha256.slice(0, 2));
    ensurePrivateDirectory(bucket);
    const path = join(bucket, sha256);
    hardenPrivateFile(path);
    const bytes = await readFile(path);
    if (digest(bytes) !== sha256) throw new Error(`Attachment integrity check failed: ${sha256}`);
    return bytes;
  }
}
