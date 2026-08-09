import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeGateChain } from "./release-security-preflight.mjs";

const node = process.execPath;
const worker = new URL("./diagnostic-leakage-worker.mjs", import.meta.url).pathname;
const scanner = new URL("./diagnostic-leakage-scan.mjs", import.meta.url).pathname;

const runFixture = async (root, canary, mode) => {
  const output = join(root, mode);
  const result = spawnSync(node, [worker, output, canary, mode], { encoding: "utf8" });
  await writeFile(join(root, `${mode}-stdout.txt`), result.stdout, { mode: 0o600 });
  await writeFile(join(root, `${mode}-stderr.txt`), result.stderr, { mode: 0o600 });
  await chmod(join(root, `${mode}-stdout.txt`), 0o600); await chmod(join(root, `${mode}-stderr.txt`), 0o600);
  const generated = result.status === 0 ? (await readdir(output)).map(name => join(output, name)) : [];
  const intentional = join(output, "intentional-user-content.json");
  return { result, intentional, artifacts: generated.filter(file => file !== intentional)
    .concat(join(root, `${mode}-stdout.txt`), join(root, `${mode}-stderr.txt`)) };
};

test("end-to-end diagnostic leakage gate fails closed and accepts redacted failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-diagnostic-test-"));
  const canary = `CANARY_${Date.now()}_${process.pid}_filename_content_metadata_path_identifier`;
  try {
    const unsafe = await runFixture(root, canary, "leak");
    assert.equal(unsafe.result.status, 0, unsafe.result.stderr);
    assert.match(unsafe.result.stdout, /8 redacted failures captured/);
    const unsafeScan = spawnSync(node, [scanner, "--canary", canary, ...unsafe.artifacts], { encoding: "utf8" });
    assert.notEqual(unsafeScan.status, 0, "controlled unredacted fixture unexpectedly passed");
    assert.match(unsafeScan.stderr, /gate failed/i);
    assert.equal(unsafeScan.stderr.includes(canary), false, "scanner disclosed the canary in CI-visible output");
    assert.equal(unsafeScan.stderr.includes(root), false, "scanner disclosed a private fixture path in CI-visible output");

    const safe = await runFixture(root, canary, "safe");
    assert.equal(safe.result.status, 0, safe.result.stderr);
    assert.match(safe.result.stdout, /8 redacted failures captured/);
    const returned = JSON.parse(await readFile(join(root, "safe", "returned-errors.json"), "utf8"));
    assert.deepEqual(returned.map(item => [item.operation, item.code]), [
      ["import", "VALIDATION_FAILED"],
      ["storage.commit", "STORAGE_FAILURE"],
      ["attachment.write", "STORAGE_FAILURE"],
      ["attachment.read", "INTERNAL_ERROR"],
      ["backup.create", "INTERNAL_ERROR"],
      ["backup.restore", "STORAGE_FAILURE"],
      ["startup.recovery", "INTERNAL_ERROR"],
      ["storage.open", "STORAGE_FAILURE"]
    ]);
    assert.deepEqual(returned.at(-1), { operation: "storage.open", code: "STORAGE_FAILURE", message: "Local database operation failed", details: {} });
    const safeScan = spawnSync(node, [scanner, "--canary", canary, ...safe.artifacts], { encoding: "utf8" });
    assert.equal(safeScan.status, 0, safeScan.stderr);
    assert.match(safeScan.stdout, /5 scoped artifact\(s\) scanned/);
    assert.equal((await readFile(safe.intentional, "utf8")).includes(canary), true, "user-visible workspace, search, and backup content was not preserved");
    assert.equal((await stat(safe.intentional)).mode & 0o777, 0o600);
    for (const artifact of safe.artifacts) assert.equal((await stat(artifact)).mode & 0o777, 0o600, artifact);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scanner, native IPC, build, and preflight failures fail closed without disclosing a candidate canary", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-candidate-leakage-"));
  const canary = `CANARY_${Date.now()}_${process.pid}_scanner_ipc_build_preflight`;
  try {
    const missing = join(root, `missing-${canary}.json`);
    const scan = spawnSync(node, [scanner, "--canary", canary, missing], { encoding: "utf8" });
    assert.notEqual(scan.status, 0); assert.equal(`${scan.stdout}${scan.stderr}`.includes(canary), false);

    const runner = new URL("../apps/desktop/service-runner.mjs", import.meta.url).pathname;
    const ipcRoot = join(root, "ipc");
    const malformed = join(root, `malformed-${canary}.json`); await writeFile(malformed, `{${canary}`, { mode: 0o600 });
    const ipc = spawnSync(node, [runner, ipcRoot], { input: `${JSON.stringify({ lane: "native-backup-inspect", payload: { destination: malformed } })}\n`, encoding: "utf8" });
    assert.equal(ipc.status, 0, ipc.stderr); assert.equal(`${ipc.stdout}${ipc.stderr}`.includes(canary), false);
    assert.deepEqual(JSON.parse(ipc.stdout).error, { code: "VALIDATION_FAILED", message: "Selected target is not a valid private Motion backup" });

    const harness = new URL("./test/fixtures/release-preflight-harness.mjs", import.meta.url).pathname;
    for (const gate of ["diagnostic-leakage", "release-manifest"]) {
      const failed = spawnSync(node, [harness, gate, canary], { encoding: "utf8" });
      assert.notEqual(failed.status, 0); assert.equal(`${failed.stdout}${failed.stderr}`.includes(canary), false);
    }
    const gateWorker = new URL("./test/fixtures/release-preflight-gate.mjs", import.meta.url).pathname;
    const buildEvidence = join(root, "build-evidence.json");
    const build = await executeGateChain([{ name: "candidate-build", command: node, args: [gateWorker, "leak", canary], env: {} }], buildEvidence);
    assert.equal(build.verdict, "FAIL");
    assert.equal((await readFile(buildEvidence, "utf8")).includes(canary), false);
    assert.equal((await stat(buildEvidence)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
