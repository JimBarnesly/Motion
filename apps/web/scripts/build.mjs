import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(["index.html", "app.js", "app-adapter.js", "app-adapter.d.ts", "attachment-access.js", "attachment-ingestion.js", "block-presentation.js", "browser-edit-confirmation.js", "canonical-security.js", "command-router.js", "edit-recovery.js", "editor-history.js", "editor-structure.js", "id-security.js", "internal-links.js", "markdown-paste.js", "mention-entry.js", "operation-coordinator.js", "reference-reconciliation.js", "search-recovery.js", "workspace-v1.js", "link-presentation.js", "styles.css"].map((file) => cp(resolve(root, file), resolve(output, file))));
await cp(resolve(root, "../../packages/core/dist/attachment-policy.js"), resolve(output, "attachment-policy.js"));
console.log("Built @motion/web to apps/web/dist");
