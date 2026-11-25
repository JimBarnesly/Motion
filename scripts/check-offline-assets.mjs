import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../apps/", import.meta.url));
const textExtensions = new Set([".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".json"]);
const networkReference = /(?:https?:\/\/|(?<!:)\/\/)[^\s'"`)]+/gi;
// The Tauri JSON schema is editor/build metadata, not a fetched runtime asset.
const allowedRuntimeMetadata = /^(?:http:\/\/www\.w3\.org\/2000\/svg|https:\/\/schema\.tauri\.app\/config\/2|http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$))/;
const pinnedBuildToolUrls = new Set([
  "https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz",
  "https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-arm64.tar.xz",
  "https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip",
  "https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-arm64.zip"
]);

// These exact reviewed bytes are vendor legal text, historical build provenance,
// and a build-only assertion source. Their URLs are citations, not runtime loads.
// Path and content must both match; changed or relocated copies are never exempt.
const pinnedOfflineEvidence = new Map([
  ["desktop/licenses/windows/WebView2-Evergreen-Terms.html", "ce6fa83e57c338256e5cabe9e1eea83076c271b0fdb253408213eeb08859d7b6"],
  ["desktop/src-tauri/windows/nsis-template-provenance.json", "4dbfcec169662cd72dc0ad990a08d51a3edad5183020f39457c2d397c252b14b"],
  ["desktop/test/windows-prerequisite-template.test.mjs", "d52d8ea14103e30faa1be31dc36ec005a909b185a118edeee41bc44bfd7ba04f"]
]);

export function allowed(reference, sourcePath) {
  if (allowedRuntimeMetadata.test(reference)) return true;
  if (sourcePath === "web/test/internal-links.test.mjs" && reference.startsWith("https://example.test/")) return true;
  return sourcePath === "desktop/scripts/prepare-node-runtime.mjs" && pinnedBuildToolUrls.has(reference);
}

// Policy regression guards: do not accidentally broaden this build-only exception.
if (allowed("https://nodejs.org/", "desktop/scripts/prepare-node-runtime.mjs")
  || allowed("https://nodejs.org/dist/v25.0.0/node-v25.0.0-linux-x64.tar.xz", "desktop/scripts/prepare-node-runtime.mjs")
  || allowed([...pinnedBuildToolUrls][0], "web/app.js")) throw new Error("Offline scanner build-tool URL policy is too broad");

export async function inspectOfflineAssets(appsRoot = root) {
  const failures = [];
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["dist", "node_modules"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      const sourcePath = relative(appsRoot, path).split(sep).join("/");
      // Tauri generates editor/permission schema documentation during Cargo builds.
      // Its URL examples are build metadata, not bundled application resources.
      if (entry.isDirectory() && sourcePath === "desktop/src-tauri/gen/schemas") continue;
      if (entry.isDirectory()) await scan(path);
      else if (textExtensions.has(extname(entry.name))) {
        const bytes = await readFile(path);
        const evidenceSha256 = pinnedOfflineEvidence.get(sourcePath);
        if (evidenceSha256) {
          if (createHash("sha256").update(bytes).digest("hex") !== evidenceSha256) {
            failures.push(`${sourcePath}: reviewed offline evidence bytes changed`);
          }
          continue;
        }
        const source = bytes.toString("utf8");
        for (const match of source.matchAll(networkReference)) {
          if (!allowed(match[0], sourcePath)) failures.push(`${sourcePath}: ${match[0]}`);
        }
      }
    }
  }
  await scan(appsRoot);
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = await inspectOfflineAssets();
  if (failures.length) {
    console.error("Unexpected network-dependent application references:\n" + failures.join("\n"));
    process.exit(1);
  }
  console.log("Offline asset scan passed: application sources contain no remote asset or API URLs.");
}
