import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteWorkspaceStore } from "@motion/storage";
import { MotionAppError, MotionAppService } from "../index.js";

const databasePath = (name: string) => join(tmpdir(), `motion-app-service-${name}-${crypto.randomUUID()}.sqlite`);
const removeDatabase = async (path: string) => Promise.all([path, `${path}-wal`, `${path}-shm`].map(file => rm(file, { force: true })));

test("committed vertical slice survives restart and supports search, backlinks, trash, restore and export", async () => {
  const path = databasePath("vertical");
  try {
    let store = new SqliteWorkspaceStore(path);
    let service = new MotionAppService(store);
    const created = service.execute({ type: "workspace.create", name: "Local notes" });
    assert.equal(created.saved, true);
    const workspaceId = created.workspace.id;
    let state = service.execute({ type: "page.create", workspaceId, expectedRevision: created.revision, title: "Home" });
    const homeId = state.workspace.pages[0]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Tasks", parentId: homeId });
    const tasksId = state.workspace.pages.find(page => page.title === "Tasks")!.id;
    state = service.execute({ type: "page.replace-blocks", workspaceId, expectedRevision: state.revision, pageId: homeId, blocks: [
      { id: "home-link", type: "paragraph", text: "Plan alpha in [[Tasks]]", children: [], references: [{ pageId: tasksId }] }
    ] });
    assert.equal(service.query({ type: "page.backlinks", workspaceId, pageId: tasksId }).length, 1);
    assert.equal(service.query({ type: "workspace.search", workspaceId, query: "alpha" })[0]?.entityId, "home-link");

    store.close();
    store = new SqliteWorkspaceStore(path); service = new MotionAppService(store);
    const restarted = service.query({ type: "workspace.get", workspaceId });
    assert.equal(restarted.revision, state.revision);
    assert.equal(restarted.workspace.pages.find(page => page.id === tasksId)?.parentId, homeId);

    const trashed = service.execute({ type: "page.trash", workspaceId, expectedRevision: restarted.revision, pageId: tasksId });
    assert.ok(trashed.workspace.pages.find(page => page.id === tasksId)?.deletedAt);
    const restored = service.execute({ type: "page.restore", workspaceId, expectedRevision: trashed.revision, pageId: tasksId });
    assert.equal(restored.workspace.pages.find(page => page.id === tasksId)?.deletedAt, undefined);
    const exported = service.query({ type: "workspace.export", workspaceId });
    assert.ok(exported.files["workspace.json"]?.includes("Local notes"));
    store.close();
  } finally { await removeDatabase(path); }
});

test("revision conflict writes neither document nor search index", async () => {
  const path = databasePath("conflict");
  try {
    const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
    const created = service.execute({ type: "workspace.create", name: "Conflict test" });
    const page = service.execute({ type: "page.create", workspaceId: created.workspace.id, expectedRevision: created.revision, title: "Original" });
    assert.throws(() => service.execute({ type: "page.rename", workspaceId: created.workspace.id, expectedRevision: created.revision, pageId: page.workspace.pages[0]!.id, title: "Must not save" }),
      (error: unknown) => error instanceof MotionAppError && error.code === "REVISION_CONFLICT");
    const after = service.query({ type: "workspace.get", workspaceId: created.workspace.id });
    assert.equal(after.revision, page.revision);
    assert.equal(after.workspace.pages[0]?.title, "Original");
    assert.equal(service.query({ type: "workspace.search", workspaceId: created.workspace.id, query: "Must" }).length, 0);
    store.close();
  } finally { await removeDatabase(path); }
});

test("web v1 import is deterministic and preserves unsupported blocks", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../../../fixtures/web-workspace-v1.json", import.meta.url), "utf8"));
  const paths = [databasePath("import-a"), databasePath("import-b")];
  try {
    const outputs = paths.map(path => {
      const store = new SqliteWorkspaceStore(path); const service = new MotionAppService(store);
      const imported = service.execute({ type: "workspace.import-web-v1", document: fixture, workspaceId: "imported-web-v1", migratedAt: "1970-01-01T00:00:00.000Z" });
      const output = service.query({ type: "workspace.export", workspaceId: imported.workspace.id }).files["workspace.json"];
      assert.equal(imported.activePageId, "page-home");
      assert.equal(imported.workspace.pages[0]?.blocks[1]?.type, "unsupported");
      store.close(); return output;
    });
    assert.equal(outputs[0], outputs[1]);
  } finally { await Promise.all(paths.map(removeDatabase)); }
});
