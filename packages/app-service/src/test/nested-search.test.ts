import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteWorkspaceStore } from "@motion/storage";
import { MotionAppService } from "../index.js";

test("persisted nested search targets follow their actual page through edits, subtree moves and service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-service-nested-search-"));
  const path = join(root, "motion.sqlite3");
  let store = new SqliteWorkspaceStore(path), service = new MotionAppService(store);
  try {
    let state = service.execute({ type: "workspace.create", name: "Unrelated workspace" });
    const workspaceId = state.workspace.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Source title" });
    const sourceId = state.workspace.pages[0]!.id;
    state = service.execute({ type: "page.create", workspaceId, expectedRevision: state.revision, title: "Destination title" });
    const destinationId = state.workspace.pages[1]!.id;
    state = service.execute({ type: "block.create", workspaceId, expectedRevision: state.revision, pageId: sourceId,
      position: { parentBlockId: null, beforeBlockId: null }, block: {
        id: "root-toggle", type: "toggle", text: "rootservicecanary", children: [
          { id: "child-callout", type: "callout", text: "childservicecanary", children: [
            { id: "grandchild-paragraph", type: "paragraph", text: "grandchildservicecanary", children: [] }
          ] }
        ]
      } });
    const expectTarget = (query: string, entityId: string, ownerEntityId: string) => {
      const hits = service.query({ type: "workspace.search", workspaceId, query });
      assert.deepEqual(hits.map(hit => ({ entityId: hit.entityId, entityType: hit.entityType, ownerEntityId: hit.ownerEntityId })),
        [{ entityId, entityType: "block", ownerEntityId }]);
      assert.ok(hits[0]!.snippet.includes(query));
    };
    expectTarget("rootservicecanary", "root-toggle", sourceId);
    expectTarget("childservicecanary", "child-callout", sourceId);
    expectTarget("grandchildservicecanary", "grandchild-paragraph", sourceId);
    state = service.execute({ type: "block.update-content", workspaceId, expectedRevision: state.revision,
      pageId: sourceId, blockId: "grandchild-paragraph", content: { text: "editedservicecanary" } });
    expectTarget("editedservicecanary", "grandchild-paragraph", sourceId);
    assert.equal(service.query({ type: "workspace.search", workspaceId, query: "grandchildservicecanary" }).length, 0);
    state = service.execute({ type: "block.create", workspaceId, expectedRevision: state.revision, pageId: destinationId,
      position: { parentBlockId: null, beforeBlockId: null }, block: { id: "destination-toggle", type: "toggle", text: "Destination header", children: [] } });
    state = service.execute({ type: "block.move", workspaceId, expectedRevision: state.revision, pageId: sourceId,
      blockId: "child-callout", target: { pageId: destinationId, parentBlockId: "destination-toggle", beforeBlockId: null } });
    expectTarget("childservicecanary", "child-callout", destinationId);
    expectTarget("editedservicecanary", "grandchild-paragraph", destinationId);
    expectTarget("rootservicecanary", "root-toggle", sourceId);
    const beforeRestart = service.query({ type: "workspace.get", workspaceId });
    store.close();
    store = new SqliteWorkspaceStore(path); service = new MotionAppService(store);
    assert.deepEqual(service.query({ type: "workspace.get", workspaceId }), beforeRestart);
    expectTarget("childservicecanary", "child-callout", destinationId);
    expectTarget("editedservicecanary", "grandchild-paragraph", destinationId);
    assert.equal(service.query({ type: "workspace.get", workspaceId }).revision, state.revision);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
