import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, putAttachment, readAttachment, rollbackProbe, savePage, search } from './spike.mjs';

function tempStore() { return mkdtempSync(join(tmpdir(), 'motion-sqlite-spike-')); }

test('migration, metadata, updates, FTS5, attachments and rollback', () => {
  const root = tempStore();
  try {
    const db = openStore(root);
    assert.equal(db.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 1);
    savePage(db, { id: 'p1', title: 'Pump maintenance', body: 'Replace mechanical seal offline', update: Uint8Array.from([1, 2, 3]) });
    assert.equal(db.prepare('SELECT title FROM pages WHERE id=?').get('p1').title, 'Pump maintenance');
    assert.deepEqual([...db.prepare('SELECT update_blob FROM document_updates WHERE page_id=?').get('p1').update_blob], [1, 2, 3]);
    assert.equal(search(db, 'mechanical')[0].page_id, 'p1');
    const payload = Buffer.from('attachment bytes\0binary');
    const hash = putAttachment(root, db, 'manual.bin', payload);
    assert.deepEqual(readAttachment(root, hash), payload);
    assert.equal(rollbackProbe(db), 'simulated interruption');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pages WHERE id=?').get('must-rollback').n, 0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('committed state survives a complete process restart', () => {
  const root = tempStore();
  try {
    execFileSync(process.execPath, ['spike.mjs', 'seed', root], { cwd: import.meta.dirname });
    const output = execFileSync(process.execPath, ['spike.mjs', 'verify', root], { cwd: import.meta.dirname, encoding: 'utf8' });
    assert.match(output, /durable-update/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('WAL recovery discards an uncommitted transaction after SIGKILL', () => {
  const root = tempStore();
  try {
    assert.throws(() => execFileSync(process.execPath, ['spike.mjs', 'crash-mid-transaction', root], {
      cwd: import.meta.dirname,
      stdio: 'ignore'
    }));
    const db = openStore(root);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pages WHERE id=?').get('crash-page').n, 0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
