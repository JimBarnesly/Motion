import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../apps/", import.meta.url);
const textExtensions = new Set([".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".json"]);
const networkReference = /(?:https?:)?\/\/[^\s'"`)]+/gi;
// The Tauri JSON schema is editor/build metadata, not a fetched runtime asset.
const allowedRuntimeMetadata = /^(?:http:\/\/www\.w3\.org\/2000\/svg|https:\/\/schema\.tauri\.app\/config\/2|http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$))/;
const pinnedBuildToolUrls = new Set([
  "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz",
  "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-arm64.tar.xz"
]);
const failures = [];

function allowed(reference, sourcePath) {
  if (allowedRuntimeMetadata.test(reference)) return true;
  return sourcePath === "desktop/scripts/prepare-node-runtime.mjs" && pinnedBuildToolUrls.has(reference);
}

// Policy regression guards: do not accidentally broaden this build-only exception.
if (allowed("https://nodejs.org/", "desktop/scripts/prepare-node-runtime.mjs")
  || allowed("https://nodejs.org/dist/v25.0.0/node-v25.0.0-linux-x64.tar.xz", "desktop/scripts/prepare-node-runtime.mjs")
  || allowed([...pinnedBuildToolUrls][0], "web/app.js")) throw new Error("Offline scanner build-tool URL policy is too broad");

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (textExtensions.has(extname(entry.name))) {
      const source = await readFile(path, "utf8");
      const sourcePath = relative(root.pathname, path);
      for (const match of source.matchAll(networkReference)) {
        if (!allowed(match[0], sourcePath)) failures.push(`${sourcePath}: ${match[0]}`);
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
