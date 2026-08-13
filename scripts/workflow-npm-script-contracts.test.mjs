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

test("workflow script-contract validation is itself release-gated", async () => {
  assert.equal(root.scripts?.["test:workflow-script-contracts"], "node --test scripts/workflow-npm-script-contracts.test.mjs");
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /run: npm run test:workflow-script-contracts/);
});

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

test("workflows that invoke cargo clippy install the pinned clippy component", async () => {
  const missing = [];
  const workflows = (await readdir(".github/workflows")).filter(path => path.endsWith(".yml")).sort();
  for (const workflow of workflows) {
    const source = await readFile(join(".github/workflows", workflow), "utf8");
    if (!/\bcargo clippy\b/.test(source)) continue;
    const toolchainSteps = source.match(/- uses: dtolnay\/rust-toolchain@[\s\S]*?(?=\n\s*- (?:uses:|name:|run:)|$)/g) ?? [];
    if (!toolchainSteps.some(step => /^\s*components:\s*clippy\s*$/m.test(step))) missing.push(workflow);
  }
  assert.deepEqual(missing, []);
});

test("native Tauri resources are prepared before every Cargo validation path", async () => {
  const source = await readFile(".github/workflows/ci.yml", "utf8");
  const nativeJob = source.slice(source.indexOf("  native-desktop:"));
  const resources = [
    ["npm run runtime:prepare --workspace @motion/desktop", "bundled runtime"],
    ["npm run build --workspace @motion/desktop", "bundled service"],
    ["npm run build --workspace @motion/web", "frontend distribution"],
  ];
  for (const [resourceCommand, resourceLabel] of resources) {
    const prepare = nativeJob.indexOf(resourceCommand);
    assert.ok(prepare >= 0, `native desktop job does not prepare its ${resourceLabel} resource`);
    for (const command of ["npm run validate:isolated-rust-tauri", "cargo clippy", "cargo test", "npm run tauri:build"]) {
      const validation = nativeJob.indexOf(command);
      assert.ok(validation >= 0, `native desktop job does not run ${command}`);
      assert.ok(prepare < validation, `${resourceLabel} preparation must precede ${command}`);
    }
  }
});

test("native packaging passes Cargo lock enforcement after the Tauri argument boundary", async () => {
  const source = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(source, /npm run tauri:build --workspace @motion\/desktop -- --bundles deb,appimage -- --locked/);
});
