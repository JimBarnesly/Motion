import { MotionAppService } from "@motion/app-service";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore } from "@motion/storage";
import { acquireNativeServiceLock } from "../../native-service-lock.mjs";
import { join } from "node:path";

const [dataRoot] = process.argv.slice(2);
let ownership;
let store;
try {
  ownership = await acquireNativeServiceLock(dataRoot);
  process.stdout.write(`${JSON.stringify({ type: "owned" })}\n`);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async chunk => {
    for (const command of chunk.trim().split(/\s+/)) {
      if (command !== "mutate") continue;
      const mutableRoot = ownership.mutableRoot;
      store = new SqliteWorkspaceStore(join(mutableRoot, "motion.sqlite3"));
      const service = new MotionAppService(store, new ContentAddressedAttachmentStore(join(mutableRoot, "attachments")));
      const result = service.execute({ type: "workspace.create", workspaceId: `workspace-${process.pid}`, name: `writer-${process.pid}` });
      process.stdout.write(`${JSON.stringify({ type: "mutated", workspaceId: result.workspace.id })}\n`);
    }
  });
  process.on("SIGTERM", async () => {
    try { store?.close(); } finally { await ownership.release(); }
    process.exit(0);
  });
} catch (error) {
  process.stdout.write(`${JSON.stringify({ type: "rejected", code: error?.code, message: error?.message })}\n`);
  process.exitCode = 73;
}
