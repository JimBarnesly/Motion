import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../apps/", import.meta.url);
const textExtensions = new Set([".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".json"]);
const networkReference = /(?:https?:)?\/\/[^\s'"`)]+/gi;
// The Tauri JSON schema is editor/build metadata, not a fetched runtime asset.
const allowed = /^(?:http:\/\/www\.w3\.org\/2000\/svg|https:\/\/schema\.tauri\.app\/config\/2|http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$))/;
const failures = [];

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (textExtensions.has(extname(entry.name))) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(networkReference)) {
        if (!allowed.test(match[0])) failures.push(`${relative(root.pathname, path)}: ${match[0]}`);
      }
    }
  }
}

await scan(root.pathname);
if (failures.length) {
  console.error("Unexpected network-dependent application references:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("Offline asset scan passed: application sources contain no remote asset or API URLs.");
