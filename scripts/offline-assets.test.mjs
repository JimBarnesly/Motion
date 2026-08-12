import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("offline asset policy accepts local Motion internal URLs", () => {
  const result = spawnSync(process.execPath, ["scripts/check-offline-assets.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Offline asset scan passed/);
});
