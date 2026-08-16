import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_ASSETS } from "./build-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
const REQUIRED_RUNTIME_ASSETS = ["attachment-access.js", "attachment-ingestion.js", "block-presentation.js", "browser-mutation.js", "filter-controls.js", "filtering.js", "internal-links.js", "link-presentation.js", "mention-entry.js", "property-editors.js", "property-lifecycle.js", "relative-date.js", "search-recovery.js", "id-security.js", "edit-recovery.js", "editor-history.js", "editor-structure.js", "markdown-paste.js", "slash-entry.js"];

for (const required of REQUIRED_RUNTIME_ASSETS) {
  if (!WEB_ASSETS.includes(required)) throw new Error(`Production Web asset manifest is missing ${required}`);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(WEB_ASSETS.map((file) => cp(resolve(root, file), resolve(output, file))));
await cp(resolve(root, "../../packages/core/dist/attachment-policy.js"), resolve(output, "attachment-policy.js"));
console.log("Built @motion/web to apps/web/dist");
