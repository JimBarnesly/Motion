import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(["index.html", "app.js", "app-adapter.js", "app-adapter.d.ts", "styles.css"].map((file) => cp(resolve(root, file), resolve(output, file))));
console.log("Built @motion/web to apps/web/dist");
