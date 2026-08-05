import { SqliteWorkspaceStore } from "../../index.js";

const [mode, databasePath] = process.argv.slice(2);
if (!databasePath || (mode !== "during-transaction" && mode !== "after-commit")) {
  throw new Error("usage: crash-worker <during-transaction|after-commit> <database-path>");
}

const store = new SqliteWorkspaceStore(databasePath);
const document = { pages: [{ id: "p1", title: "Committed", text: "new searchable value" }] };

if (mode === "during-transaction") {
  store.saveUnitOfWork({
    workspaceId: "ws",
    schemaVersion: 1,
    document,
    expectedRevision: 1,
    afterWorkspaceWrite: () => process.kill(process.pid, "SIGKILL")
  });
} else {
  store.save("ws", 1, document, 1);
  process.kill(process.pid, "SIGKILL");
}
