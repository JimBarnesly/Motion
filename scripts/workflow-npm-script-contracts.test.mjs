import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = JSON.parse(await readFile("package.json", "utf8"));
const workspacePackages = new Map();
for (const pattern of root.workspaces ?? []) {
  assert.match(pattern, /\/\*$/, `unsupported workspace pattern: ${pattern}`);
  const directory = pattern.slice(0, -2);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(await readFile(join(directory, entry.name, "package.json"), "utf8"));
    workspacePackages.set(manifest.name, manifest);
  }
}

test("every workflow npm run command references a declared script", async () => {
  const missing = [];
  const workflows = (await readdir(".github/workflows")).filter(path => path.endsWith(".yml")).sort();
  for (const workflow of workflows) {
    const source = await readFile(join(".github/workflows", workflow), "utf8");
    for (const match of source.matchAll(/\bnpm\s+run\s+([^\s"'\\]+)/g)) {
      const script = match[1];
      const command = source.slice(match.index, source.indexOf("\n", match.index));
      const workspaces = [...command.matchAll(/--workspace(?:=|\s+)([^\s"'\\]+)/g)].map(value => value[1]);
      if (workspaces.length === 0) {
        if (!root.scripts?.[script]) missing.push(`${workflow}: root script ${script}`);
        continue;
      }
      for (const workspace of workspaces) {
        const manifest = workspacePackages.get(workspace);
        if (!manifest?.scripts?.[script]) missing.push(`${workflow}: workspace ${workspace} script ${script}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
