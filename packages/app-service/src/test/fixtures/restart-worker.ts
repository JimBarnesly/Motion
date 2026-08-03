import { SqliteWorkspaceStore } from "@motion/storage";
import { MotionAppService } from "../../index.js";

const [phase, databasePath, workspaceId, pageId] = process.argv.slice(2);
if (!phase || !databasePath) throw new Error("Usage: restart-worker <create|reopen> <database> [workspace] [page]");
if (process.env.MOTION_E2E_NETWORK_GUARD !== "required" || process.env.MOTION_NETWORK_DISABLED !== "1") {
  throw new Error("The offline E2E worker must run with the network guard loaded");
}

const store = new SqliteWorkspaceStore(databasePath);
const service = new MotionAppService(store);

try {
  if (phase === "create") {
    const created = service.execute({ type: "workspace.create", name: "Offline workspace" });
    const page = service.execute({
      type: "page.create",
      workspaceId: created.workspace.id,
      expectedRevision: created.revision,
      title: "Offline field notes"
    });
    const createdPage = page.workspace.pages[0]!;
    const saved = service.execute({
      type: "page.replace-blocks",
      workspaceId: created.workspace.id,
      expectedRevision: page.revision,
      pageId: createdPage.id,
      blocks: [{
        id: "offline-paragraph",
        type: "paragraph",
        text: "Pump inspection completed without a network.",
        children: []
      }]
    });
    const savedPage = saved.workspace.pages.find(candidate => candidate.id === createdPage.id)!;
    process.stdout.write(JSON.stringify({
      networkGuard: true,
      workspaceId: created.workspace.id,
      pageId: createdPage.id,
      title: savedPage.title,
      body: savedPage.blocks[0]?.text
    }));
  } else if (phase === "reopen") {
    if (!workspaceId || !pageId) throw new Error("Reopen requires workspace and page IDs");
    const loaded = service.query({ type: "workspace.get", workspaceId });
    const page = loaded.workspace.pages.find(candidate => candidate.id === pageId);
    if (!page) throw new Error(`Persisted page not found: ${pageId}`);
    const search = service.query({ type: "workspace.search", workspaceId, query: "inspection" });
    const exported = service.query({ type: "workspace.export", workspaceId });
    process.stdout.write(JSON.stringify({
      networkGuard: true,
      title: page.title,
      body: page.blocks[0]?.text,
      searchMatched: search.some(hit => hit.entityId === "offline-paragraph"),
      exportMatched: exported.files["workspace.json"]?.includes("Pump inspection completed without a network.") === true
    }));
  } else {
    throw new Error(`Unknown phase: ${phase}`);
  }
} finally {
  store.close();
}
