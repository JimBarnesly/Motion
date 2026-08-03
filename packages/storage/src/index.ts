import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  title: string;
  snippet: string;
}

export interface WorkspaceWrite {
  workspaceId: string;
  schemaVersion: number;
  document: unknown;
  expectedRevision?: number;
  /** Test/diagnostic hook. Throwing here proves the workspace and index share one transaction. */
  afterWorkspaceWrite?: () => void;
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
];

const digest = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");
const requireSha256 = (value: string): void => {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Attachment hash must be 64 lowercase hexadecimal characters");
};

/** Durable local repository. UI/domain entities cross this boundary as versioned JSON, never SQLite rows. */
export class SqliteWorkspaceStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.migrate();
    this.runPendingReindexJobs();
  }

  close(): void { this.database.close(); }

  save(workspaceId: string, schemaVersion: number, document: unknown, expectedRevision?: number): number {
    return this.saveUnitOfWork({ workspaceId, schemaVersion, document, expectedRevision });
  }

  saveUnitOfWork(write: WorkspaceWrite): number {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT revision FROM workspaces WHERE workspace_id = ?").get(write.workspaceId) as { revision: number } | undefined;
      const currentRevision = Number(row?.revision ?? 0);
      if (write.expectedRevision !== undefined && currentRevision !== write.expectedRevision) {
        throw new Error(`Revision conflict for workspace ${write.workspaceId}`);
      }
      const revision = currentRevision + 1;
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO workspaces(workspace_id, schema_version, revision, document_json, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET schema_version=excluded.schema_version,
        revision=excluded.revision, document_json=excluded.document_json, updated_at=excluded.updated_at`)
        .run(write.workspaceId, write.schemaVersion, revision, JSON.stringify(write.document), now);
      this.database.prepare(`INSERT INTO reindex_jobs(workspace_id, workspace_revision, status, created_at)
        VALUES (?, ?, 'pending', ?)` ).run(write.workspaceId, revision, now);
      write.afterWorkspaceWrite?.();
      this.reindexWorkspace(write.workspaceId, write.document);
      this.database.prepare("UPDATE reindex_jobs SET status='complete', completed_at=? WHERE workspace_id=? AND workspace_revision=?")
        .run(now, write.workspaceId, revision);
      this.database.exec("COMMIT");
      return revision;
    } catch (error) {
      this.database.exec("ROLLBACK");
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
      ? "SELECT workspace_id, entity_id, title, snippet(workspace_search, 3, '[', ']', '…', 12) snippet FROM workspace_search WHERE workspace_search MATCH ? AND workspace_id = ? ORDER BY rank LIMIT ?"
      : "SELECT workspace_id, entity_id, title, snippet(workspace_search, 3, '[', ']', '…', 12) snippet FROM workspace_search WHERE workspace_search MATCH ? ORDER BY rank LIMIT ?";
    const rows = (workspaceId
      ? this.database.prepare(sql).all(match, workspaceId, boundedLimit)
      : this.database.prepare(sql).all(match, boundedLimit)) as Record<string, unknown>[];
    return rows.map((row) => ({ workspaceId: String(row.workspace_id), entityId: String(row.entity_id), title: String(row.title), snippet: String(row.snippet) }));
  }

  runPendingReindexJobs(): number {
    const jobs = this.database.prepare("SELECT job_id, workspace_id FROM reindex_jobs WHERE status='pending' ORDER BY job_id").all() as { job_id: number; workspace_id: string }[];
    for (const job of jobs) {
      const workspace = this.load(job.workspace_id);
      if (!workspace) continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.reindexWorkspace(job.workspace_id, workspace.document);
        this.database.prepare("UPDATE reindex_jobs SET status='complete', completed_at=? WHERE job_id=?").run(new Date().toISOString(), job.job_id);
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
    return jobs.length;
  }

  private reindexWorkspace(workspaceId: string, document: unknown): void {
    this.database.prepare("DELETE FROM workspace_search WHERE workspace_id = ?").run(workspaceId);
    const insert = this.database.prepare("INSERT INTO workspace_search(workspace_id, entity_id, title, body) VALUES (?, ?, ?, ?)");
    for (const entry of extractSearchEntries(document, workspaceId)) insert.run(workspaceId, entry.entityId, entry.title, entry.body);
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

function extractSearchEntries(document: unknown, fallbackId: string): { entityId: string; title: string; body: string }[] {
  const result: { entityId: string; title: string; body: string }[] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((child, index) => visit(child, `${path}.${index}`)); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : path;
    const title = typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : "";
    const text = [record.text, record.content, record.label].filter((part): part is string => typeof part === "string").join(" ");
    if (title || text) result.push({ entityId: id, title, body: text });
    for (const [key, child] of Object.entries(record)) if (typeof child === "object" && child !== null) visit(child, `${path}.${key}`);
  };
  visit(document, fallbackId);
  if (result.length === 0) result.push({ entityId: fallbackId, title: "", body: JSON.stringify(document) });
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
  constructor(private readonly root: string) {}

  async stage(bytes: Uint8Array): Promise<StagedAttachment> {
    const sha256 = digest(bytes);
    const finalPath = join(this.root, sha256.slice(0, 2), sha256);
    const stagingRoot = join(this.root, ".staging");
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
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
    await mkdir(dirname(staged.path), { recursive: true });
    try {
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
    const bytes = await readFile(join(this.root, sha256.slice(0, 2), sha256));
    if (digest(bytes) !== sha256) throw new Error(`Attachment integrity check failed: ${sha256}`);
    return bytes;
  }
}
