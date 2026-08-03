import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  );`
];

const digest = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");

/** Durable local repository. UI/domain entities cross this boundary as versioned JSON, never SQLite rows. */
export class SqliteWorkspaceStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.migrate();
  }

  close(): void { this.database.close(); }

  save(workspaceId: string, schemaVersion: number, document: unknown, expectedRevision?: number): number {
    const existing = this.load(workspaceId);
    if (expectedRevision !== undefined && (existing?.revision ?? 0) !== expectedRevision) {
      throw new Error(`Revision conflict for workspace ${workspaceId}`);
    }
    const revision = (existing?.revision ?? 0) + 1;
    const updatedAt = new Date().toISOString();
    const statement = this.database.prepare(`
      INSERT INTO workspaces(workspace_id, schema_version, revision, document_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        revision = excluded.revision,
        document_json = excluded.document_json,
        updated_at = excluded.updated_at
    `);
    statement.run(workspaceId, schemaVersion, revision, JSON.stringify(document), updatedAt);
    return revision;
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

  private migrate(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(migrations[0]);
      const insert = this.database.prepare("INSERT OR IGNORE INTO motion_migrations(version, applied_at, checksum) VALUES (?, ?, ?)");
      insert.run(1, new Date().toISOString(), digest(migrations[0]));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

/** Files are immutable and addressed by content hash; metadata remains in the workspace database. */
export class ContentAddressedAttachmentStore {
  constructor(private readonly root: string) {}

  async put(bytes: Uint8Array): Promise<StoredAttachment> {
    const sha256 = digest(bytes);
    const finalPath = join(this.root, sha256.slice(0, 2), sha256);
    await mkdir(dirname(finalPath), { recursive: true });
    try {
      const current = await readFile(finalPath);
      if (current.byteLength !== bytes.byteLength || digest(current) !== sha256) throw new Error(`Attachment hash collision at ${finalPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const staged = `${finalPath}.${crypto.randomUUID()}.staging`;
      await writeFile(staged, bytes, { flag: "wx", mode: 0o600 });
      try { await rename(staged, finalPath); } finally { await rm(staged, { force: true }); }
    }
    return { sha256, byteLength: bytes.byteLength, path: finalPath };
  }

  async get(sha256: string): Promise<Uint8Array> {
    const bytes = await readFile(join(this.root, sha256.slice(0, 2), sha256));
    if (digest(bytes) !== sha256) throw new Error(`Attachment integrity check failed: ${sha256}`);
    return bytes;
  }
}
