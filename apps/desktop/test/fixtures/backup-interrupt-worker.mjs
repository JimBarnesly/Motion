import { createBackup } from "@motion/backup";
import { createAtomicBackupFile } from "../../backup-file.mjs";

const destination = process.argv[2];
const workspace = { schemaVersion: 1, id: "workspace", name: "Interrupted", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pages: [], databases: [], attachments: [] };
const bundle = createBackup(workspace, [], "2026-01-01T00:00:00Z");
await createAtomicBackupFile(destination, bundle, { beforePublish: async () => {
  process.stdout.write("ready\n");
  await new Promise(resolve => setInterval(resolve, 60_000));
} });
