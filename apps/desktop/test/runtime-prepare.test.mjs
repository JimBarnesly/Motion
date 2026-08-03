import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OFFICIAL_ARCHIVES, NODE_VERSION, prepareNodeRuntime } from "../scripts/prepare-node-runtime.mjs";

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
    await assert.rejects(prepareNodeRuntime({ architecture: "x64", cacheRoot: join(root, "cache"), output: join(root, "node"), offline: true }), /checksum mismatch/);
  } finally { await rm(root, { recursive: true }); }
});
