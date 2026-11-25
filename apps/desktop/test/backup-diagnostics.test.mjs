import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, win32 } from "node:path";
import test from "node:test";

const source = new URL("../backup-diagnostics.mjs", import.meta.url).href;
const destination = "C:\\Private fixture secret\\Selected notebook.json";
const script = `import { recordBackupInspectionFailure } from ${JSON.stringify(source)};
const error = Object.assign(new Error("Private message and notebook body must never enter diagnostics"),
  { code: process.env.TEST_NATIVE_CODE, name: process.env.TEST_ERROR_TYPE });
recordBackupInspectionFailure(error, ${JSON.stringify(destination)});
process.stdout.write("original refusal preserved");`;

function run(github, enabled, code = "EACCES", type = "Error") {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 5000, maxBuffer: 8192,
    env: { ...process.env, GITHUB_ACTIONS: github, MOTION_ACCEPTANCE_TRACE_BACKUP: enabled,
      TEST_NATIVE_CODE: code, TEST_ERROR_TYPE: type }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "original refusal preserved");
  return result.stderr;
}

test("backup refusal diagnostics require both explicit acceptance gates", () => {
  for (const [github, enabled] of [["", ""], ["true", ""], ["", "1"], ["false", "1"], ["true", "true"]]) {
    assert.equal(run(github, enabled), "");
  }
});

test("acceptance diagnostics preserve exact path fingerprints without raw private data or arbitrary error fields", () => {
  const text = run("true", "1");
  assert.ok(!text.includes("Private") && !text.includes("Selected notebook") && !text.includes("notebook body"));
  const value = JSON.parse(text);
  assert.deepEqual(Object.keys(value), ["schemaVersion", "event", "nativeCode", "errorType", "destinationShape",
    "destinationLength", "normalizedPathSha256", "normalizedParentSha256", "resolvedNativePathSha256"]);
  assert.equal(value.nativeCode, "EACCES");
  assert.equal(JSON.parse(run("true", "1", "STORAGE_FAILURE")).nativeCode, "STORAGE_FAILURE");
  assert.equal(value.destinationShape, "drive");
  const normalized = win32.normalize(destination).toLowerCase();
  assert.equal(value.normalizedPathSha256, createHash("sha256").update(normalized).digest("hex"));
  assert.equal(value.normalizedParentSha256, createHash("sha256").update(win32.dirname(normalized)).digest("hex"));
  assert.equal(value.resolvedNativePathSha256, createHash("sha256").update(win32.normalize(resolve(destination)).toLowerCase()).digest("hex"));
  const untrusted = run("true", "1", "SECRET_NATIVE_CODE_WITH_PRIVATE_CONTENT", "SECRET_CUSTOM_ERROR_TYPE");
  assert.ok(!untrusted.includes("SECRET") && !untrusted.includes("Private") && !untrusted.includes("notebook body"));
  assert.equal(JSON.parse(untrusted).nativeCode, "UNCLASSIFIED");
  assert.equal(JSON.parse(untrusted).errorType, "Unknown");
});
