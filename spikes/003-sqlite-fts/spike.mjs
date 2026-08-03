import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function openStore(root) {
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'attachments'), { recursive: true });
  const db = new DatabaseSync(join(root, 'motion.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS pages(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS document_updates(
      id INTEGER PRIMARY KEY AUTOINCREMENT, page_id TEXT NOT NULL REFERENCES pages(id),
      sequence INTEGER NOT NULL, update_blob BLOB NOT NULL,
      UNIQUE(page_id, sequence)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(page_id UNINDEXED, title, body);
    CREATE TABLE IF NOT EXISTS attachments(
      hash TEXT PRIMARY KEY, name TEXT NOT NULL, byte_length INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
  `);
}

export function savePage(db, { id, title, body, update }) {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO pages(id,title,created_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at`)
      .run(id, title, now, now);
    const next = db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM document_updates WHERE page_id=?').get(id).n;
    db.prepare('INSERT INTO document_updates(page_id,sequence,update_blob) VALUES(?,?,?)')
      .run(id, next, Buffer.from(update));
    db.prepare('DELETE FROM page_search WHERE page_id=?').run(id);
    db.prepare('INSERT INTO page_search(page_id,title,body) VALUES(?,?,?)').run(id, title, body);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function search(db, query) {
  return db.prepare(`SELECT page_id, title, snippet(page_search, 2, '[', ']', '…', 12) AS snippet
    FROM page_search WHERE page_search MATCH ? ORDER BY rank`).all(query);
}

export function putAttachment(root, db, name, bytes) {
  const data = Buffer.from(bytes);
  const hash = createHash('sha256').update(data).digest('hex');
  writeFileSync(join(root, 'attachments', hash), data, { flag: 'wx' });
  db.prepare('INSERT INTO attachments(hash,name,byte_length) VALUES(?,?,?)').run(hash, name, data.length);
  return hash;
}

export function readAttachment(root, hash) {
  return readFileSync(join(root, 'attachments', hash));
}

export function rollbackProbe(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO pages(id,title,created_at,updated_at) VALUES(?,?,?,?)')
      .run('must-rollback', 'Must Roll Back', 'now', 'now');
    throw new Error('simulated interruption');
  } catch (error) {
    db.exec('ROLLBACK');
    return error.message;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , command, root = '.tmp/demo'] = process.argv;
  const db = openStore(root);
  if (command === 'demo') {
    savePage(db, { id: 'page-1', title: 'Local knowledge', body: 'durable offline workspace', update: 'update-1' });
    console.log(JSON.stringify({ migration: db.prepare('SELECT MAX(version) version FROM schema_migrations').get(), search: search(db, 'offline'), rollback: rollbackProbe(db) }));
  } else if (command === 'seed') {
    savePage(db, { id: 'restart-page', title: 'Restart integrity', body: 'survives process restart', update: 'durable-update' });
  } else if (command === 'verify') {
    const result = db.prepare('SELECT p.title, d.sequence, CAST(d.update_blob AS TEXT) update_text FROM pages p JOIN document_updates d ON d.page_id=p.id WHERE p.id=?').get('restart-page');
    if (!result || result.update_text !== 'durable-update') process.exitCode = 1;
    else console.log(JSON.stringify(result));
  } else if (command === 'crash-mid-transaction') {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO pages(id,title,created_at,updated_at) VALUES(?,?,?,?)')
      .run('crash-page', 'Uncommitted crash', 'now', 'now');
    process.kill(process.pid, 'SIGKILL');
  }
  db.close();
}
