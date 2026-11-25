import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OFFICIAL_ARCHIVES, WINDOWS_ARCHIVES, NODE_VERSION, prepareNodeRuntime, runtimeSpecification } from "../scripts/prepare-node-runtime.mjs";

test("runtime provenance pins official Node 24 archives and SHA-256", () => {
  assert.equal(NODE_VERSION, "24.18.0");
  for (const entry of Object.values(OFFICIAL_ARCHIVES)) {
    assert.match(entry.file, /^node-v24\.18\.0-linux-(x64|arm64)\.tar\.xz$/);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }
});

test("offline preparation rejects a corrupt preseed before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-node-cache-"));
  try {
    const entry = OFFICIAL_ARCHIVES.x64;
    await mkdir(join(root, "cache"));
    await writeFile(join(root, "cache", entry.file), "not the official archive");
    await assert.rejects(prepareNodeRuntime({ platform: "linux", architecture: "x64", cacheRoot: join(root, "cache"), output: join(root, "node"), offline: true }), /checksum mismatch/);
  } finally { await rm(root, { recursive: true }); }
});

test("unsupported platforms fail before creating a cache or preparing a Linux runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-node-platform-"));
  try {
    for (const platform of ["freebsd", "darwin"]) {
      const cacheRoot = join(root, platform, "cache");
      const output = join(root, platform, "node-runtime");
      await assert.rejects(prepareNodeRuntime({ platform, architecture: "x64", cacheRoot, output }), /Unsupported native Motion runtime platform/);
      await assert.rejects(stat(cacheRoot), { code: "ENOENT" });
      await assert.rejects(stat(output), { code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows runtime selection has independent official pins, PE naming and exact ZIP members", () => {
  for (const architecture of ["x64", "arm64"]) {
    const spec = runtimeSpecification("win32", architecture);
    assert.equal(spec.url, `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-${architecture}.zip`);
    assert.match(WINDOWS_ARCHIVES[architecture].sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(spec.sha256, OFFICIAL_ARCHIVES[architecture].sha256);
    assert.equal(spec.member, `node-v${NODE_VERSION}-win-${architecture}/node.exe`);
    assert.equal(spec.licenseMember, `node-v${NODE_VERSION}-win-${architecture}/LICENSE`);
    assert.equal(spec.executable, "node-runtime.exe");
    assert.equal(spec.extractFlag, "-xOf");
  }
  assert.throws(() => runtimeSpecification("win32", "ia32"), /Unsupported Node runtime architecture/);
  assert.throws(() => runtimeSpecification("__proto__", "x64"), /Unsupported native Motion runtime platform/);
});

test("Windows offline preparation rejects corrupt and missing caches before creating output", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-win-cache-"));
  try {
    const output = join(root, "node-runtime.exe"), cacheRoot = join(root, "cache");
    await assert.rejects(prepareNodeRuntime({ platform: "win32", architecture: "x64", cacheRoot, output, offline: true }), /not in the offline cache/);
    await writeFile(join(cacheRoot, WINDOWS_ARCHIVES.x64.file), "MZ malformed executable");
    await assert.rejects(prepareNodeRuntime({ platform: "win32", architecture: "x64", cacheRoot, output, offline: true }), /checksum mismatch/);
    await assert.rejects(stat(output), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
