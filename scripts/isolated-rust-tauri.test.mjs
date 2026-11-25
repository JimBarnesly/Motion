import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateFingerprint, inspectPackageInventory, packageInventoryEvidence, verifyInputs } from "./isolated-rust-tauri.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");

test("candidate fingerprint and both dependency locks fail closed on substitution or absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-rust-input-"));
  try {
    await mkdir(join(root, "apps/desktop/src-tauri"), { recursive: true }); execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "package-lock.json"), "package-lock\n"); await writeFile(join(root, "apps/desktop/src-tauri/Cargo.lock"), "cargo-lock\n");
    execFileSync("git", ["add", "."], { cwd: root });
    const policy = { schemaVersion: "1.0.0", image: { reference: "local", baseDigest: `sha256:${"b".repeat(64)}`, rustBaseDigest: `sha256:${"f".repeat(64)}`,
      os: "linux", architecture: "arm64", packageInventorySha256: "c".repeat(64) }, rust: { version: "1.97.1", rustcSha256: "d".repeat(64), cargoSha256: "e".repeat(64) },
      inputs: { cargoLockSha256: digest(Buffer.from("cargo-lock\n")), packageLockSha256: digest(Buffer.from("package-lock\n")) } };
    const expected = (await candidateFingerprint(root)).sha256; assert.equal((await verifyInputs(root, policy, expected)).sha256, expected);
    await writeFile(join(root, "apps/desktop/src-tauri/Cargo.lock"), "substituted\n");
    await assert.rejects(verifyInputs(root, policy, expected), /rejected/);
    await rm(join(root, "apps/desktop/src-tauri/Cargo.lock"));
    await assert.rejects(verifyInputs(root, policy, expected), /rejected/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rootless validation copies the exact read-only candidate into private executable tmpfs mounts", async () => {
  const source = await readFile("scripts/isolated-rust-tauri.mjs", "utf8");
  assert.match(source, /type=bind,src=\$\{candidate\},dst=\/candidate,readonly/);
  assert.match(source, /--tmpfs", "\/workspace:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000"/);
  assert.match(source, /--tmpfs", "\/target:rw,exec,nosuid,nodev,size=6g,uid=1000,gid=1000"/);
  assert.match(source, /--tmpfs", "\/tmp:rw,exec,nosuid,nodev,size=2g,uid=1000,gid=1000,mode=1777"/);
  assert.match(source, /cp -a \/candidate\/\. \/workspace/);
  assert.match(source, /cp -a \/opt\/motion-seed\/node_modules \/workspace\/node_modules/);
  const dockerfile = await readFile("tooling/rust-tauri/Dockerfile", "utf8");
  assert.match(dockerfile, /chmod -R a\+rX \/opt\/motion-seed\/node_modules/);
  assert.match(source, /cd \/workspace/);
  assert.match(source, /CARGO_TARGET_DIR=\/target/);
  assert.match(source, /name\.startsWith\("\.project-office\/"\) && !name\.startsWith\("\.cache\/"\)/);
  assert.match(source, /const excluded = \[join\(root, "\.project-office"\), join\(root, "\.cache"\)/);
  assert.doesNotMatch(source, /type=bind,src=\$\{candidate\},dst=\/workspace/);
});

test("package inventory preserves the pinned LC_ALL=C sorted-byte hash and reports exact mismatch evidence", () => {
  const canonical = "apt=2.6.1\nbase-files=12.4+deb12u12\nlibc6:arm64=2.36-9+deb12u13\n";
  const observed = digest(canonical);
  const result = { status: 0, signal: null,
    stdout: "libc6:arm64=2.36-9+deb12u13\napt=2.6.1\nbase-files=12.4+deb12u12\n" };
  const matched = packageInventoryEvidence(result, observed);
  assert.equal(matched.verdict, "PASS");
  assert.equal(matched.observedSha256, observed);
  assert.equal(matched.inventoryComplete, true);
  assert.equal(matched.packageCount, 3);
  assert.deepEqual(matched.packages, canonical.trim().split("\n"));
  const rejected = packageInventoryEvidence(result, "f".repeat(64));
  assert.equal(rejected.verdict, "FAIL");
  assert.equal(rejected.reason, "inventory-hash-mismatch");
  assert.equal(rejected.expectedSha256, "f".repeat(64));
  assert.equal(rejected.observedSha256, observed);
  assert.equal(rejected.commandStatus, 0);
});

test("a failed inventory command cannot pass even when stdout matches the pinned hash", () => {
  const stdout = "apt=2.6.1\n", expected = digest(stdout);
  for (const execution of [
    { status: 2, stdout },
    { status: 0, stdout, signal: "SIGTERM" },
    { status: 0, stdout, error: Object.assign(new Error("private command diagnostic"), { code: "ENOBUFS" }) }
  ]) {
    const result = packageInventoryEvidence(execution, expected);
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.reason, "command-failed");
    assert.equal(result.inventoryComplete, false);
    assert.equal(result.observedSha256, expected);
    assert.doesNotMatch(JSON.stringify(result), /private command diagnostic/);
  }
});

test("inventory diagnostics bound and validate records and never expose arbitrary process output", () => {
  const sensitive = "DO_NOT_LOG_private_token";
  for (const stdout of [
    sensitive, `apt=2.6.1\n${sensitive}\n`, "apt=2.6.1\r\n", "apt=2.6.1", "", "a".repeat(2 * 1024 * 1024 + 1),
    "apt=2.6.1\n".repeat(10_001), "../private=1\n", "apt=1;secret\n"
  ]) {
    const result = packageInventoryEvidence({ status: 0, stdout, stderr: sensitive }, "a".repeat(64));
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.reason, "invalid-inventory-output");
    assert.equal(result.observedSha256, null);
    assert.deepEqual(result.packages, []);
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LOG|private_token|stderr|\.\.\//);
  }
  const failed = packageInventoryEvidence({ status: null, stdout: sensitive, stderr: sensitive,
    signal: sensitive, error: { code: sensitive, message: sensitive } }, "a".repeat(64));
  assert.equal(failed.signal, "OTHER");
  assert.equal(failed.errorCode, "OTHER");
  assert.doesNotMatch(JSON.stringify(failed), /DO_NOT_LOG|private_token/);
});

test("inventory collection preserves confinement and observes dpkg failure directly without a masking shell pipeline", () => {
  const image = `sha256:${"b".repeat(64)}`, output = "apt=2.6.1\n";
  let execution;
  const result = inspectPackageInventory(image, digest(output), (command, args, options) => {
    execution = { command, args, options };
    return { status: 0, stdout: output };
  });
  assert.equal(result.verdict, "PASS");
  assert.equal(execution.command, "docker");
  assert.deepEqual(execution.args, ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "1000:1000", image, "/usr/bin/dpkg-query", "-W", "-f=${Package}=${Version}\\n"]);
  assert.equal(execution.options.maxBuffer, 2 * 1024 * 1024);
  assert.equal(execution.options.timeout, 120000);
  const unavailable = inspectPackageInventory(image, digest(output), () => {
    throw Object.assign(new Error("do not expose an environment secret"), { code: "ENOENT" });
  });
  assert.equal(unavailable.reason, "command-failed");
  assert.equal(unavailable.errorCode, "ENOENT");
  assert.doesNotMatch(JSON.stringify(unavailable), /environment secret/);
  assert.throws(() => inspectPackageInventory("untrusted image", digest(output), () => assert.fail("Invalid image must not execute")), /rejected/);
});
