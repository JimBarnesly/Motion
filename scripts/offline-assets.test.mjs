import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { allowed, inspectOfflineAssets } from "./check-offline-assets.mjs";

test("offline asset policy accepts local Motion internal URLs", () => {
  const result = spawnSync(process.execPath, ["scripts/check-offline-assets.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Offline asset scan passed/);
});

test("only four exact pinned runtime archives are allowed, only in the build preparation source", () => {
  for (const archive of ["linux-x64.tar.xz", "linux-arm64.tar.xz", "win-x64.zip", "win-arm64.zip"]) {
    const url = `https://nodejs.org/dist/v24.22.3/node-v24.22.3-${archive}`;
    assert.equal(allowed(url, "desktop/scripts/prepare-node-runtime.mjs"), true);
    for (const path of ["web/app.js", "desktop/service-runner.mjs", "desktop/scripts/other.mjs"]) {
      assert.equal(allowed(url, path), false);
    }
    assert.equal(allowed(url.replaceAll("24.22.3", "24.22.4"), "desktop/scripts/prepare-node-runtime.mjs"), false);
    assert.equal(allowed(`${url}?redirect=1`, "desktop/scripts/prepare-node-runtime.mjs"), false);
  }
  assert.equal(allowed("https://nodejs.org/", "desktop/scripts/prepare-node-runtime.mjs"), false);
});

test("generated Tauri schema examples are excluded without hiding generated application code", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-offline-policy-"));
  try {
    const write = async (path, contents) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    };
    await write("desktop/src-tauri/gen/schemas/windows-schema.json", JSON.stringify({ example: "https://schema-example.invalid/" }));
    await write("desktop/src-tauri/gen/runtime.js", 'fetch("https://runtime.invalid/api");');
    await write("web/gen/schemas/runtime.js", 'fetch("https://web-runtime.invalid/api");');
    await write("web/app.js", 'fetch("https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip");');
    assert.deepEqual((await inspectOfflineAssets(root)).sort(), [
      "desktop/src-tauri/gen/runtime.js: https://runtime.invalid/api",
      "web/app.js: https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip",
      "web/gen/schemas/runtime.js: https://web-runtime.invalid/api"
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("offline evidence exceptions require the exact reviewed path and complete file bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-offline-evidence-"));
  const paths = [
    "desktop/licenses/windows/WebView2-Evergreen-Terms.html",
    "desktop/src-tauri/windows/nsis-template-provenance.json",
    "desktop/test/windows-prerequisite-template.test.mjs"
  ];
  try {
    for (const path of paths) {
      const bytes = await readFile(new URL(`../apps/${path}`, import.meta.url));
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      assert.deepEqual(await inspectOfflineAssets(root), [], `reviewed ${path}`);
      for (const changed of [Buffer.concat([bytes, Buffer.from('\nfetch("https://new-runtime.invalid/api")')]), Buffer.from("changed without a URL")]) {
        await writeFile(target, changed);
        assert.deepEqual(await inspectOfflineAssets(root), [`${path}: reviewed offline evidence bytes changed`]);
      }
      await writeFile(target, bytes);
      const runtimePath = `web/${path.split("/").at(-1)}`;
      await mkdir(join(root, "web"), { recursive: true });
      await writeFile(join(root, runtimePath), bytes);
      const copied = await inspectOfflineAssets(root);
      assert.ok(copied.length > 0, `copied ${path} is still scanned`);
      assert.ok(copied.every(failure => failure.startsWith(`${runtimePath}: `)));
      await rm(join(root, runtimePath));
    }
    const sibling = "desktop/licenses/windows/unreviewed-terms.html";
    await writeFile(join(root, sibling), '<a href="https://aka.ms/privacy">Privacy</a>');
    assert.ok((await inspectOfflineAssets(root)).some(failure => failure.startsWith(`${sibling}: `)));
    assert.equal(allowed("https://aka.ms/privacy", paths[0]), false, "a path alone never permits a network reference");
  } finally { await rm(root, { recursive: true, force: true }); }
});
