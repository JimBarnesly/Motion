import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, chown, link, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore, type WorkspaceChangeSet } from "../index.js";

const runCrashWorker = async (mode: "during-transaction" | "after-commit", databasePath: string) => {
  const worker = new URL("./fixtures/crash-worker.js", import.meta.url);
  const child = spawn(process.execPath, [worker.pathname, mode, databasePath], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: null, signal: "SIGKILL" }, `crash worker did not reach kill point:\n${stderr}`);
};

test("SQLite workspace storage survives restart and rejects stale revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-storage-"));
  const path = join(root, "motion.sqlite3");
  try {
    const first = new SqliteWorkspaceStore(path);
    assert.equal(first.save("ws-1", 2, { title: "Offline" }, 0), 1);
    assert.throws(() => first.save("ws-1", 2, { title: "Stale" }, 0), /Revision conflict/);
    first.close();
    const reopened = new SqliteWorkspaceStore(path);
    assert.deepEqual(reopened.load("ws-1")?.document, { title: "Offline" });
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attachment storage is content-addressed, deduplicated, and verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-attachments-"));
  try {
    const store = new ContentAddressedAttachmentStore(root);
    const bytes = new TextEncoder().encode("owned locally");
    const first = await store.put(bytes);
    const second = await store.put(bytes);
    assert.equal(first.path, second.path);
    assert.deepEqual(Buffer.from(await store.get(first.sha256)), Buffer.from(bytes));
    assert.deepEqual(await readFile(first.path), Buffer.from(bytes));
    await assert.rejects(store.get("../../workspace.json"), /64 lowercase hexadecimal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attachment reads reject external hardlinks without mutating their bytes or mode", async (context) => {
  if (process.platform === "win32") { context.skip("POSIX hard-link ownership and modes are not enforceable on Windows"); return; }
  const root = await mkdtemp(join(tmpdir(), "motion-attachment-hardlink-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "motion-attachment-external-"));
  try {
    const store = new ContentAddressedAttachmentStore(root);
    const payload = Buffer.from("external boundary content");
    const sha256 = (await import("node:crypto")).createHash("sha256").update(payload).digest("hex");
    const externalPath = join(externalRoot, "owned-elsewhere.bin");
    await writeFile(externalPath, payload, { mode: 0o644 });
    await chmod(externalPath, 0o644);
    await mkdir(join(root, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
    await link(externalPath, store.pathFor(sha256));

    await assert.rejects(store.get(sha256), /invalid content|private attachment/i);
    assert.deepEqual(await readFile(externalPath), payload);
    assert.equal((await stat(externalPath)).mode & 0o777, 0o644, "rejected external inode was chmodded");

    if (process.geteuid?.() === 0) {
      await unlink(store.pathFor(sha256));
      const foreignPayload = Buffer.from("foreign-owned attachment");
      const foreignHash = (await import("node:crypto")).createHash("sha256").update(foreignPayload).digest("hex");
      const foreignPath = store.pathFor(foreignHash);
      await mkdir(join(root, foreignHash.slice(0, 2)), { recursive: true, mode: 0o700 });
      await writeFile(foreignPath, foreignPayload, { mode: 0o600 });
      await chown(foreignPath, 65534, 65534);
      await assert.rejects(store.get(foreignHash), /invalid content|private attachment/i);
      assert.equal((await stat(foreignPath)).uid, 65534, "rejected foreign inode ownership was mutated");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("promotion rejects a staged pathname replacement without a production race hook", async (context) => {
  if (process.platform !== "linux") { context.skip("the descriptor-publication race fixture is Linux-specific"); return; }
  const root = await mkdtemp(join(tmpdir(), "motion-attachment-promotion-race-"));
  try {
    const worker = new URL("./fixtures/promotion-race-worker.js", import.meta.url);
    const result = spawnSync(process.execPath, [worker.pathname, root], { encoding: "utf8" });
    assert.equal(result.status, 0, `promotion race worker failed:\n${result.stdout}\n${result.stderr}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same-hash promotions across store instances serialize publication and deduplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-attachment-concurrent-promotion-"));
  try {
    const firstStore = new ContentAddressedAttachmentStore(root);
    const secondStore = new ContentAddressedAttachmentStore(root);
    for (let round = 0; round < 20; round += 1) {
      const payload = Buffer.from(`same-hash concurrent publication ${round}`);
      const [firstStaged, secondStaged] = await Promise.all([firstStore.stage(payload), secondStore.stage(payload)]);
      const results = await Promise.all([firstStore.promote(firstStaged), secondStore.promote(secondStaged)]);
      assert.equal(results.filter(result => result.newlyCreated).length, 1);
      assert.deepEqual(await firstStore.get(results[0]!.sha256), payload);
      assert.deepEqual(await secondStore.get(results[0]!.sha256), payload);
    }
    const stores = Array.from({ length: 100 }, () => new ContentAddressedAttachmentStore(root));
    const payload = Buffer.from("same-process 100-way publication");
    const staged = await Promise.all(stores.map(store => store.stage(payload)));
    const results = await Promise.all(stores.map((store, index) => store.promote(staged[index]!)));
    assert.equal(results.filter(result => result.newlyCreated).length, 1);
    assert.deepEqual(await firstStore.get(results[0]!.sha256), payload);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a staged attachment capability is consumed atomically by promote and discard", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-attachment-capability-consumption-"));
  const capabilityError = "Staged attachment was not issued by this attachment store";
  try {
    const store = new ContentAddressedAttachmentStore(root);
    const operations = [
      (staged: import("../index.js").StagedAttachment) => [store.promote(staged), store.promote(staged)],
      (staged: import("../index.js").StagedAttachment) => [store.promote(staged), store.discard(staged)],
      (staged: import("../index.js").StagedAttachment) => [store.discard(staged), store.discard(staged)]
    ] as const;

    for (const [operationIndex, race] of operations.entries()) {
      for (let round = 0; round < 20; round += 1) {
        const staged = await store.stage(Buffer.from(`single-use capability ${operationIndex}:${round}`));
        const results = await Promise.allSettled(race(staged));
        assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        assert.ok(rejected);
        assert.equal(rejected.reason instanceof Error && rejected.reason.message, capabilityError);
        assert.equal(String(rejected.reason).includes(root), false, "capability rejection disclosed a private path");
      }
    }
    assert.deepEqual(await readdir(join(root, ".staging")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("forged staged objects cannot publish or delete external files", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-attachment-capability-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "motion-attachment-capability-external-"));
  try {
    const store = new ContentAddressedAttachmentStore(root);
    const otherStore = new ContentAddressedAttachmentStore(root);
    const issued = await store.stage(Buffer.from("store-bound capability"));
    assert.equal("stagingPath" in issued, false, "capability disclosed its private staging pathname");
    await assert.rejects(otherStore.promote(issued), /not issued by this attachment store/i);
    await store.discard(issued);

    const payload = Buffer.from("external matching attachment");
    const sha256 = (await import("node:crypto")).createHash("sha256").update(payload).digest("hex");
    const externalPath = join(externalRoot, "matching.bin");
    await writeFile(externalPath, payload, { mode: 0o600 });
    await chmod(externalPath, 0o600);
    const forged = { sha256, byteLength: payload.byteLength, path: store.pathFor(sha256), stagingPath: externalPath } as unknown as import("../index.js").StagedAttachment;

    await assert.rejects(store.promote(forged), /not issued by this attachment store/i);
    assert.deepEqual(await readFile(externalPath), payload);
    assert.equal((await stat(externalPath)).mode & 0o777, 0o600);
    await assert.rejects(readFile(store.pathFor(sha256)), error => (error as NodeJS.ErrnoException).code === "ENOENT");

    await assert.rejects(store.discard(forged), /not issued by this attachment store/i);
    assert.deepEqual(await readFile(externalPath), payload);
    assert.equal((await stat(externalPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("attachment storage accepts exactly 3 MiB and rejects 3 MiB plus one before staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-attachment-size-"));
  try {
    const store = new ContentAddressedAttachmentStore(root);
    const boundary = await store.stage(new Uint8Array(3 * 1024 * 1024));
    assert.equal(boundary.byteLength, 3 * 1024 * 1024); await store.promote(boundary);
    assert.equal((await store.get(boundary.sha256)).byteLength, 3 * 1024 * 1024);
    await assert.rejects(store.stage(new Uint8Array(3 * 1024 * 1024 + 1)), /3 MiB/);
    assert.deepEqual(await readdir(join(root, ".staging")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preexisting oversized final blobs are rejected and explicitly reported without deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-attachment-oversized-final-"));
  try {
    const store = new ContentAddressedAttachmentStore(root);
    const payload = new Uint8Array(3 * 1024 * 1024 + 1); payload[payload.length - 1] = 1;
    const sha256 = (await import("node:crypto")).createHash("sha256").update(payload).digest("hex");
    const path = store.pathFor(sha256);
    await mkdir(join(root, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
    await writeFile(path, payload, { mode: 0o600 });

    await assert.rejects(store.get(sha256), error => error instanceof Error
      && /attachment storage content exceeds 3 MiB limit/i.test(error.message) && !error.message.includes(sha256) && !error.message.includes(path));
    const referenced = await store.recover([sha256]);
    assert.deepEqual(referenced.oversizedBlobs, [sha256]);
    assert.deepEqual(referenced.missingReferenced, [sha256]);
    assert.deepEqual(referenced.unreferencedBlobs, []);
    assert.equal((await readFile(path)).byteLength, payload.byteLength, "recovery deleted oversized evidence");

    const unreferenced = await store.recover([]);
    assert.deepEqual(unreferenced.oversizedBlobs, [sha256]);
    assert.deepEqual(unreferenced.unreferencedBlobs, []);
    assert.equal((await readFile(path)).byteLength, payload.byteLength, "unreferenced recovery deleted oversized evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attachment staging recovery promotes referenced content and removes abandoned staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-attachment-recovery-"));
  try {
    const store = new ContentAddressedAttachmentStore(root);
    const referenced = await store.stage(new TextEncoder().encode("metadata committed"));
    const abandoned = await store.stage(new TextEncoder().encode("metadata rolled back"));
    const report = await store.recover([referenced.sha256]);
    assert.deepEqual(report.promoted, [referenced.sha256]);
    assert.equal(report.removedStaging.some(name => name.startsWith(abandoned.sha256)), true);
    assert.deepEqual(report.missingReferenced, []);
    assert.deepEqual(Buffer.from(await store.get(referenced.sha256)), Buffer.from("metadata committed"));
    assert.deepEqual(await readdir(join(root, ".staging")), []);

    const orphan = await store.put(new TextEncoder().encode("unreferenced final blob"));
    const audit = await store.recover([referenced.sha256, "f".repeat(64)]);
    assert.deepEqual(audit.missingReferenced, ["f".repeat(64)]);
    assert.equal(audit.unreferencedBlobs.includes(orphan.sha256), true);
    assert.deepEqual(Buffer.from(await store.get(orphan.sha256)), Buffer.from("unreferenced final blob"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace write and FTS update roll back together", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-uow-"));
  const store = new SqliteWorkspaceStore(join(root, "motion.sqlite3"));
  try {
    store.save("ws", 1, { id: "page", title: "Original", text: "durable" }, 0);
    assert.throws(() => store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 1,
      document: { id: "page", title: "Broken", text: "vanish" }, expectedRevision: 1,
      afterWorkspaceWrite: () => { throw new Error("injected failure"); } }), /injected failure/);
    assert.equal(store.load("ws")?.revision, 1);
    assert.equal(store.search("durable").length, 1);
    assert.equal(store.search("vanish").length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("SQLite and FTS recover atomically from real process termination at commit boundaries", async () => {
  for (const mode of ["during-transaction", "after-commit"] as const) {
    const root = await mkdtemp(join(tmpdir(), `motion-crash-${mode}-`));
    const path = join(root, "motion.sqlite3");
    try {
      const seed = new SqliteWorkspaceStore(path);
      seed.save("ws", 1, { pages: [{ id: "p1", title: "Original", text: "old searchable value" }] }, 0);
      seed.close();

      await runCrashWorker(mode, path);

      const reopened = new SqliteWorkspaceStore(path);
      const expectedCommitted = mode === "after-commit";
      assert.equal(reopened.load("ws")?.revision, expectedCommitted ? 2 : 1);
      assert.equal(reopened.search("new searchable value", "ws").length, expectedCommitted ? 1 : 0);
      assert.equal(reopened.search("old searchable value", "ws").length, expectedCommitted ? 0 : 1);
      const integrity = reopened.database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      assert.equal(integrity.integrity_check, "ok");
      const pending = reopened.database.prepare("SELECT COUNT(*) count FROM reindex_jobs WHERE status='pending'").get() as { count: number };
      assert.equal(pending.count, 0);
      reopened.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("FTS survives restart and follows rename and deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-fts-"));
  const path = join(root, "motion.sqlite3");
  try {
    const first = new SqliteWorkspaceStore(path);
    first.save("ws", 1, { pages: [{ id: "p1", title: "Alpha", text: "needle" }] }, 0);
    first.close();
    const reopened = new SqliteWorkspaceStore(path);
    assert.equal(reopened.search("needle", "ws")[0]?.entityId, "p1");
    reopened.save("ws", 1, { pages: [{ id: "p1", title: "Beta", text: "replacement" }] }, 1);
    assert.equal(reopened.search("Alpha").length, 0);
    assert.equal(reopened.search("Beta").length, 1);
    reopened.remove("ws");
    assert.equal(reopened.search("Beta").length, 0);
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FTS indexes persisted table row values by stable row ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-table-search-"));
  const path = join(root, "motion.sqlite3");
  let store = new SqliteWorkspaceStore(path);
  const table = (reading: string) => ({ databases: [{ id: "table-1", name: "Commissioning register",
    pageId: "table-page-1", properties: [{ id: "reading", name: "Reading" }],
    rows: [{ id: "row-1", values: { reading, passed: true } }] }] });
  try {
    store.save("ws", 2, table("persisted-cell-417 <safe> & line\ntwo"), 0);
    store.close();
    store = new SqliteWorkspaceStore(path);
    assert.deepEqual(store.search("persisted-cell-417", "ws").map(hit => ({ id: hit.entityId, type: hit.entityType, owner: hit.ownerEntityId, title: hit.title })),
      [{ id: "row-1", type: "row", owner: "table-page-1", title: "Commissioning register" }]);
    assert.match(store.search("safe line", "ws")[0]?.snippet ?? "", /\[safe\].*\[line\]/s);
    assert.equal(store.search("true", "ws")[0]?.entityId, "row-1");
    store.save("ws", 2, table("replacement-cell-918"), 1);
    assert.equal(store.search("persisted-cell-417", "ws").length, 0);
    assert.equal(store.search("replacement-cell-918", "ws")[0]?.entityId, "row-1");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("incremental validation groups one hundred thousand same-scope FTS entries and links linearly without comparison sorting", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-linear-link-validation-"));
  const store = new SqliteWorkspaceStore(join(root, "motion.sqlite3"));
  const entryCount = 100_000;
  const original = { id: "ws", pages: [{ id: "source", title: "Source", blocks: [] as { id: string; text: string; children: unknown[] }[] }], databases: [], attachments: [], linkIndex: [] as { sourcePageId: string; targetPageId: string; blockId: string }[] };
  try {
    store.save("ws", 2, original, 0);
    const changed = structuredClone(original);
    changed.pages[0]!.blocks = Array.from({ length: entryCount }, (_, index) => ({ id: `block-${index}`, text: `token-${index}`, children: [] }));
    changed.linkIndex = Array.from({ length: entryCount }, (_, index) => ({ sourcePageId: "source", targetPageId: `target-${index}`, blockId: "links" }));
    let arrayElementsIterated = 0; let comparisons = 0; const originalIterator = Array.prototype[Symbol.iterator]; const originalSort = Array.prototype.sort;
    Array.prototype[Symbol.iterator] = function(this: unknown[]) {
      const iterator = originalIterator.call(this); return { next() { const result = iterator.next(); if (!result.done) arrayElementsIterated++; return result; }, [Symbol.iterator]() { return this; } };
    };
    Array.prototype.sort = function(this: unknown[], compareFn?: (left: unknown, right: unknown) => number) {
      if (compareFn) return originalSort.call(this, (left, right) => { comparisons++; return compareFn(left, right); });
      return originalSort.call(this);
    } as typeof Array.prototype.sort;
    const started = performance.now(); const heapBefore = process.memoryUsage().heapUsed;
    try {
      store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 2, document: changed, expectedRevision: 1,
        changeSet: { kind: "incremental", pages: ["source"], databases: [], attachments: [], linkSourcePageIds: ["source"], fts: [{ scope: "page", id: "source" }] } });
    } finally { Array.prototype[Symbol.iterator] = originalIterator; Array.prototype.sort = originalSort; }
    const elapsedMs = performance.now() - started; const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

    assert.ok(arrayElementsIterated < entryCount * 1_000, `bounded grouping/radix passes iterated ${arrayElementsIterated} array elements for ${entryCount} FTS entries and links`);
    assert.equal(comparisons, 0);
    assert.ok(heapGrowth < 512 * 1024 * 1024, `100k combined validation/write grew heap by ${(heapGrowth / 1024 / 1024).toFixed(1)}MiB`);
    assert.ok(elapsedMs < 8_000, `100k combined validation/write took ${elapsedMs.toFixed(1)}ms`);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("incremental change sets rewrite only dirty normalized, link, and FTS scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-incremental-"));
  const path = join(root, "motion.sqlite3");
  const store = new SqliteWorkspaceStore(path);
  const original = {
    id: "ws", name: "Incremental", pages: [
      { id: "p1", title: "One", blocks: [{ id: "b1", text: "old token", children: [], references: [{ pageId: "p2" }] }] },
      { id: "p2", title: "Untouched", blocks: [{ id: "b2", text: "stable token", children: [] }] }
    ], databases: [{ id: "db1", pageId: "p2", name: "Table", rows: [{ id: "r1", values: { value: "stable row" } }] }],
    attachments: [{ id: "a1", sha256: "a".repeat(64) }], linkIndex: [{ sourcePageId: "p1", targetPageId: "p2", blockId: "b1" }],
    futureMetadata: { plugin: { opaque: true } }
  };
  try {
    store.save("ws", 2, original, 0);
    const untouchedFtsRowids = store.database.prepare(`SELECT entity_id, rowid FROM workspace_search
      WHERE workspace_id='ws' AND ((scope_type='page' AND scope_id='p2') OR (scope_type='database' AND scope_id='db1'))
      ORDER BY scope_type, entity_id`).all();
    store.database.exec(`CREATE TEMP TABLE write_audit(table_name TEXT, entity_id TEXT);
      CREATE TEMP TRIGGER audit_page AFTER UPDATE ON workspace_pages BEGIN INSERT INTO write_audit VALUES ('page', NEW.page_id); END;
      CREATE TEMP TRIGGER audit_database AFTER UPDATE ON workspace_databases BEGIN INSERT INTO write_audit VALUES ('database', NEW.database_id); END;
      CREATE TEMP TRIGGER audit_attachment AFTER UPDATE ON workspace_attachments BEGIN INSERT INTO write_audit VALUES ('attachment', NEW.attachment_id); END;`);
    const changed = structuredClone(original) as typeof original; changed.pages[0]!.title = "Changed"; changed.pages[0]!.blocks[0]!.text = "new token";
    (changed.pages[0]!.blocks[0]! as { references?: { pageId: string }[] }).references = []; changed.linkIndex = [];
    const changeSet: WorkspaceChangeSet = { kind: "incremental", pages: ["p1"], databases: [], attachments: [],
      linkSourcePageIds: ["p1"], fts: [{ scope: "page", id: "p1" }] };
    assert.equal(store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 2, document: changed, expectedRevision: 1, changeSet }), 2);

    const auditedWrites = store.database.prepare("SELECT table_name, entity_id FROM write_audit ORDER BY table_name, entity_id").all()
      .map(row => ({ ...row }));
    assert.deepEqual(auditedWrites, [{ table_name: "page", entity_id: "p1" }]);
    assert.deepEqual(store.lastWriteStats, { mode: "incremental", pages: 1, databases: 0, attachments: 0,
      linkSources: 1, linksInserted: 0, ftsScopes: 1, ftsInserted: 2 });
    assert.equal(store.search("old token", "ws").length, 0);
    assert.equal(store.search("new token", "ws")[0]?.entityId, "b1");
    assert.equal(store.search("stable token", "ws")[0]?.entityId, "b2");
    assert.equal(store.search("stable row", "ws")[0]?.entityId, "r1");
    assert.deepEqual(store.database.prepare(`SELECT entity_id, rowid FROM workspace_search
      WHERE workspace_id='ws' AND ((scope_type='page' AND scope_id='p2') OR (scope_type='database' AND scope_id='db1'))
      ORDER BY scope_type, entity_id`).all(), untouchedFtsRowids);
    assert.equal((store.database.prepare("SELECT COUNT(*) count FROM workspace_links WHERE workspace_id='ws'").get() as { count: number }).count, 0);
    assert.deepEqual(store.load("ws")?.document, changed);
    const derivedRows = () => ({
      search: store.database.prepare(`SELECT entity_id, entity_type, owner_entity_id, scope_type, scope_id, title, body
        FROM workspace_search WHERE workspace_id='ws' ORDER BY scope_type, scope_id, entity_type, entity_id`).all(),
      links: store.database.prepare("SELECT source_page_id, target_page_id, block_id FROM workspace_links WHERE workspace_id='ws' ORDER BY source_page_id, block_id, target_page_id").all(),
      pages: store.database.prepare("SELECT page_id, page_json FROM workspace_pages WHERE workspace_id='ws' ORDER BY page_id").all(),
      databases: store.database.prepare("SELECT database_id, database_json FROM workspace_databases WHERE workspace_id='ws' ORDER BY database_id").all(),
      attachments: store.database.prepare("SELECT attachment_id, attachment_json FROM workspace_attachments WHERE workspace_id='ws' ORDER BY attachment_id").all()
    });
    const incrementalDerived = derivedRows();
    assert.equal(store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 2, document: changed, expectedRevision: 2, changeSet: { kind: "rebuild" } }), 3);
    assert.deepEqual(derivedRows(), incrementalDerived);
    assert.deepEqual(store.load("ws")?.document, changed);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("incremental scope validation rejects omissions and deletes removed entities from every derived table", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-incremental-removals-"));
  const store = new SqliteWorkspaceStore(join(root, "motion.sqlite3"));
  const original = { id: "ws", name: "Removal", pages: [
    { id: "p1", title: "Source", blocks: [{ id: "b1", text: "linked", children: [] }] },
    { id: "p2", title: "Removed page token", blocks: [] }
  ], databases: [{ id: "db1", name: "Removed database token", rows: [] }],
  attachments: [{ id: "a1", label: "Removed attachment token" }],
  linkIndex: [{ sourcePageId: "p1", targetPageId: "p2", blockId: "b1" }] };
  try {
    store.save("ws", 1, original, 0);
    const removed = structuredClone(original);
    removed.pages = removed.pages.filter(page => page.id !== "p2"); removed.databases = []; removed.attachments = []; removed.linkIndex = [];
    assert.throws(() => store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 1, document: removed, expectedRevision: 1,
      changeSet: { kind: "incremental", pages: [], databases: [], attachments: [], linkSourcePageIds: [], fts: [] } }),
    /omits dirty pages: p2/);
    assert.equal(store.load("ws")?.revision, 1);
    assert.equal(store.search("Removed", "ws").length, 3);
    assert.equal(store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 1, document: removed, expectedRevision: 1,
      changeSet: { kind: "incremental", pages: ["p2"], databases: ["db1"], attachments: ["a1"], linkSourcePageIds: ["p1"],
        fts: [{ scope: "attachment", id: "a1" }, { scope: "database", id: "db1" }, { scope: "page", id: "p2" }] } }), 2);
    assert.equal(store.search("Removed", "ws").length, 0);
    for (const table of ["workspace_pages", "workspace_databases", "workspace_attachments", "workspace_links"])
      assert.equal((store.database.prepare(`SELECT COUNT(*) count FROM ${table} WHERE workspace_id='ws'`).get() as { count: number }).count,
        table === "workspace_pages" ? 1 : 0);
    assert.deepEqual(store.load("ws")?.document, removed);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("incremental change sets reject oversized work sets and non-canonical IDs before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-incremental-bounds-"));
  const store = new SqliteWorkspaceStore(join(root, "motion.sqlite3"));
  const original = { id: "ws", pages: [], databases: [], attachments: [], linkIndex: [] };
  try {
    store.save("ws", 1, original, 0);
    const base = { kind: "incremental" as const, pages: [] as string[], databases: [] as string[], attachments: [] as string[],
      linkSourcePageIds: [] as string[], fts: [] as { scope: "page"; id: string }[] };
    assert.throws(() => store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 1, document: original, expectedRevision: 1,
      changeSet: { ...base, pages: new Array(100_001).fill("p") } }), /changeSet.pages must be an array within limits/);
    assert.throws(() => store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 1, document: original, expectedRevision: 1,
      changeSet: { ...base, pages: ["p".repeat(161)] } }), /changeSet.pages must contain safe canonical IDs/);
    assert.throws(() => store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 1, document: original, expectedRevision: 1,
      changeSet: { ...base, fts: new Array(100_001).fill({ scope: "page", id: "p" }) } }), /changeSet.fts must be an array within limits/);
    assert.throws(() => store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 1, document: original, expectedRevision: 1,
      changeSet: { ...base, fts: [{ scope: "page", id: "unsafe id" }] } }), /changeSet.fts contains an invalid scope or ID/);
    assert.equal(store.load("ws")?.revision, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("incremental rollback preserves canonical and normalized rows, FTS, links, and revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-incremental-rollback-"));
  const store = new SqliteWorkspaceStore(join(root, "motion.sqlite3"));
  const original = { id: "ws", pages: [{ id: "p1", title: "Original", blocks: [{ id: "b1", text: "durable", children: [] }] }],
    databases: [], attachments: [], linkIndex: [] };
  try {
    store.save("ws", 1, original, 0);
    const before = {
      workspace: store.database.prepare("SELECT * FROM workspaces WHERE workspace_id='ws'").get(),
      pages: store.database.prepare("SELECT * FROM workspace_pages WHERE workspace_id='ws' ORDER BY page_id").all(),
      fts: store.database.prepare("SELECT rowid, * FROM workspace_search WHERE workspace_id='ws' ORDER BY rowid").all(),
      links: store.database.prepare("SELECT * FROM workspace_links WHERE workspace_id='ws'").all()
    };
    const changed = structuredClone(original); changed.pages[0]!.title = "Broken"; changed.pages[0]!.blocks[0]!.text = "vanish";
    assert.throws(() => store.saveUnitOfWork({ workspaceId: "ws", schemaVersion: 1, document: changed, expectedRevision: 1,
      changeSet: { kind: "incremental", pages: ["p1"], databases: [], attachments: [], linkSourcePageIds: ["p1"], fts: [{ scope: "page", id: "p1" }] },
      beforeCommit: () => { throw new Error("injected normalized failure"); } }), /injected normalized failure/);
    assert.deepEqual({
      workspace: store.database.prepare("SELECT * FROM workspaces WHERE workspace_id='ws'").get(),
      pages: store.database.prepare("SELECT * FROM workspace_pages WHERE workspace_id='ws' ORDER BY page_id").all(),
      fts: store.database.prepare("SELECT rowid, * FROM workspace_search WHERE workspace_id='ws' ORDER BY rowid").all(),
      links: store.database.prepare("SELECT * FROM workspace_links WHERE workspace_id='ws'").all()
    }, before);
    assert.equal(store.load("ws")?.revision, 1);
    assert.equal(store.search("durable", "ws").length, 1);
    assert.equal(store.search("vanish", "ws").length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("hostile FTS syntax is tokenized and migrations are idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-migrations-"));
  const path = join(root, "motion.sqlite3");
  try {
    const first = new SqliteWorkspaceStore(path);
    first.save("ws", 1, { id: "p", title: "Quoted", text: "safe query" }, 0);
    assert.doesNotThrow(() => first.search('" OR * NEAR() - { }'));
    first.close();
    const second = new SqliteWorkspaceStore(path);
    const migrations = second.database.prepare("SELECT version FROM motion_migrations ORDER BY version").all() as { version: number }[];
    assert.deepEqual(migrations.map(({ version }) => version), [1, 2, 3, 4]);
    assert.throws(() => second.save("ws", 1, { id: "p", title: "stale" }, 0), /Revision conflict/);
    second.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private runtime paths ignore permissive and restrictive umasks without following symlinks", async (context) => {
  if (process.platform === "win32") { context.skip("POSIX modes are not enforceable on Windows"); return; }
  for (const mask of ["000", "077"]) {
    const root = await mkdtemp(join(tmpdir(), `motion-permissions-${mask}-`));
    try {
      const worker = new URL("./fixtures/permission-worker.js", import.meta.url);
      const result = spawnSync(process.execPath, [worker.pathname, root, mask], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as { root: number; attachmentsRoot: number; staging: number; bucket: number; attachment: number; databaseFiles: Record<string, number>; fileSymlinkRejected: boolean; directorySymlinkRejected: boolean; targetFile: number; targetDirectory: number };
      assert.deepEqual({ root: report.root, attachmentsRoot: report.attachmentsRoot, staging: report.staging, bucket: report.bucket }, { root: 0o700, attachmentsRoot: 0o700, staging: 0o700, bucket: 0o700 });
      assert.equal(report.attachment, 0o600);
      assert.ok(Object.keys(report.databaseFiles).includes("motion.sqlite3"));
      assert.ok(Object.values(report.databaseFiles).every(value => value === 0o600));
      assert.deepEqual({ file: report.fileSymlinkRejected, directory: report.directorySymlinkRejected }, { file: true, directory: true });
      assert.deepEqual({ file: report.targetFile, directory: report.targetDirectory }, { file: 0o666, directory: 0o777 });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
