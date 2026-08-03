import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore } from "../index.js";

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
