import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore } from "../index.js";

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
    assert.deepEqual(migrations.map(({ version }) => version), [1, 2, 3]);
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
