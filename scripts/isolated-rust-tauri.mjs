#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const fail = () => { throw new Error("isolated Rust/Tauri validation input or environment was rejected"); };

export async function candidateFingerprint(root) {
  const names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
    .toString().split("\0").filter(name => name && !name.startsWith(".project-office/") && !name.startsWith(".cache/")).sort();
  const digest = createHash("sha256");
  for (const name of names) {
    const path = join(root, name); const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail();
    const bytes = await readFile(path); const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail();
    digest.update(`${name}\0${before.mode & 0o777}\0${bytes.length}\0`); digest.update(bytes);
  }
  return { sha256: digest.digest("hex"), fileCount: names.length };
}

export async function verifyInputs(root, policy, expectedFingerprint) {
  try {
  if (!exactKeys(policy, ["schemaVersion", "image", "rust", "inputs"])
      || policy.schemaVersion !== "1.0.0"
      || !exactKeys(policy.image, ["reference", "baseDigest", "rustBaseDigest", "os", "architecture", "packageInventorySha256"])
      || typeof policy.image.reference !== "string" || policy.image.reference.length === 0
      || !/^sha256:[a-f0-9]{64}$/.test(policy.image.baseDigest)
      || !/^sha256:[a-f0-9]{64}$/.test(policy.image.rustBaseDigest)
      || policy.image.os !== "linux" || policy.image.architecture !== "arm64"
      || !/^[a-f0-9]{64}$/.test(policy.image.packageInventorySha256)
      || !exactKeys(policy.rust, ["version", "rustcSha256", "cargoSha256"])
      || policy.rust.version !== "1.97.1" || !/^[a-f0-9]{64}$/.test(policy.rust.rustcSha256) || !/^[a-f0-9]{64}$/.test(policy.rust.cargoSha256)
      || !exactKeys(policy.inputs, ["cargoLockSha256", "packageLockSha256"])
      || !/^[a-f0-9]{64}$/.test(policy.inputs.cargoLockSha256) || !/^[a-f0-9]{64}$/.test(policy.inputs.packageLockSha256)
      || !/^[a-f0-9]{64}$/.test(expectedFingerprint ?? "")) fail();
  const cargoLock = await readFile(join(root, "apps/desktop/src-tauri/Cargo.lock"));
  const packageLock = await readFile(join(root, "package-lock.json"));
  if (sha256(cargoLock) !== policy.inputs.cargoLockSha256 || sha256(packageLock) !== policy.inputs.packageLockSha256) fail();
  const fingerprint = await candidateFingerprint(root); if (fingerprint.sha256 !== expectedFingerprint) fail();
    return fingerprint;
  } catch (error) {
    if (error?.message === "isolated Rust/Tauri validation input or environment was rejected") throw error;
    fail();
  }
}

async function writePrivate(path, value) {
  const output = resolve(path); await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, output); await chmod(output, 0o600);
}

async function main() {
  const root = resolve(arg("--root") ?? "."); const policyPath = resolve(arg("--policy") ?? "tooling/rust-tauri/policy.json");
  if (process.argv.includes("--print-fingerprint")) { process.stdout.write(`${(await candidateFingerprint(root)).sha256}\n`); return; }
  const expectedFingerprint = arg("--candidate-fingerprint"); const report = arg("--report"); if (!report) fail();
  // Keep the disposable copy outside the checkout: Node correctly rejects a
  // recursive copy whose destination is a child of its source.
  const work = await mkdtemp(join(dirname(root), ".motion-rust-tauri-"));
  try {
    const policy = JSON.parse(await readFile(policyPath, "utf8")); const fingerprint = await verifyInputs(root, policy, expectedFingerprint);
    const inspect = spawnSync("docker", ["image", "inspect", policy.image.reference, "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}|{{.Config.User}}"], { encoding: "utf8" });
    const [imageId, imageOs, imageArchitecture, imageUser] = inspect.stdout.trim().split("|");
    if (inspect.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId)
      || imageOs !== "linux" || imageArchitecture !== "arm64" || imageUser !== "1000:1000") fail();
    const packages = spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "1000:1000", imageId, "sh", "-lc", "dpkg-query -W -f='${Package}=${Version}\\n' | LC_ALL=C sort | sha256sum | cut -d' ' -f1"], { encoding: "utf8", timeout: 120000 });
    if (packages.status !== 0 || packages.stdout.trim() !== policy.image.packageInventorySha256) fail();
    const candidate = join(work, "candidate");
    const excluded = [join(root, ".project-office"), join(root, ".cache"), join(root, "artifacts"), join(root, "node_modules"), join(root, "apps/desktop/src-tauri/target")];
    await cp(root, candidate, { recursive: true, filter: path => !excluded.some(item => path === item || path.startsWith(`${item}/`)) });
    const npmValidation = "npm run lint; npm run typecheck; npm run test --workspaces --if-present";
    const cargoTest = "cargo test --offline --locked --target-dir /target --manifest-path apps/desktop/src-tauri/Cargo.toml";
    const tauriCheck = "cargo check --offline --locked --all-targets --target-dir /target --manifest-path apps/desktop/src-tauri/Cargo.toml";
    const command = "set -eu; export PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; "
      + "test \"$(id -u):$(id -g)\" = 1000:1000; test \"$(uname -m)\" = aarch64; "
      + "test \"$(rustc --version)\" = 'rustc 1.97.1 (8bab26f4f 2026-07-14)'; test \"$(node --version)\" = 'v24.18.0'; "
      + `test \"$(sha256sum \"$(rustup which rustc)\" | cut -d' ' -f1)\" = '${policy.rust.rustcSha256}'; `
      + `test \"$(sha256sum \"$(rustup which cargo)\" | cut -d' ' -f1)\" = '${policy.rust.cargoSha256}'; `
      + `cp -a /candidate/. /workspace; cp -a /opt/motion-seed/node_modules /workspace/node_modules; cd /workspace; ${npmValidation}; ${cargoTest}; ${tauriCheck}`;
    const validation = spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "512", "--user", "1000:1000",
      "--tmpfs", "/workspace:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000",
      "--tmpfs", "/target:rw,exec,nosuid,nodev,size=6g,uid=1000,gid=1000",
      "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=2g,uid=1000,gid=1000,mode=1777",
      "--mount", `type=bind,src=${candidate},dst=/candidate,readonly`,
      "--env", "CARGO_NET_OFFLINE=true", "--env", "CARGO_TARGET_DIR=/target",
      "--workdir", "/workspace", imageId,
      "sh", "-lc", command], { encoding: "utf8", timeout: 900000, maxBuffer: 1024 * 1024 });
    if (validation.status !== 0) {
      if (process.env.MOTION_ISOLATED_VALIDATION_DEBUG === "1") {
        process.stderr.write(`${validation.stdout}\n${validation.stderr}`.slice(-8_192));
      }
      fail();
    }
    await writePrivate(report, { schemaVersion: 1, verdict: "PASS", candidateFingerprint: fingerprint.sha256, candidateFileCount: fingerprint.fileCount,
      architecture: "arm64", imageId, baseImageDigest: policy.image.baseDigest, rustBaseImageDigest: policy.image.rustBaseDigest,
      packageInventorySha256: policy.image.packageInventorySha256, node: "24.18.0", rust: policy.rust.version,
      commands: { npmValidation, cargoTest, tauriCheck }, npmValidation: true, cargoTest: true, tauriCompileCheck: true,
      runtimeNetwork: "none", rootlessProcess: true });
    process.stdout.write("Isolated ARM64 Rust/Tauri validation passed.\n");
  } catch (error) {
    if (process.env.MOTION_ISOLATED_VALIDATION_DEBUG === "1") process.stderr.write(`${error?.stack ?? error}\n`);
    process.stderr.write("Isolated Rust/Tauri validation failed closed.\n"); process.exitCode = 1;
  }
  finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
