import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateFingerprint, verifyInputs } from "./isolated-rust-tauri.mjs";

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
  assert.match(source, /--tmpfs", "\/workspace:rw,nosuid,nodev,size=1g,uid=1000,gid=1000"/);
  assert.match(source, /--tmpfs", "\/target:rw,nosuid,nodev,size=6g,uid=1000,gid=1000"/);
  assert.match(source, /cp -a \/candidate\/\. \/workspace/);
  assert.match(source, /cp -a \/opt\/motion-seed\/node_modules \/workspace\/node_modules/);
  assert.match(source, /cd \/workspace/);
  assert.match(source, /CARGO_TARGET_DIR=\/target/);
  assert.doesNotMatch(source, /type=bind,src=\$\{candidate\},dst=\/workspace/);
});
