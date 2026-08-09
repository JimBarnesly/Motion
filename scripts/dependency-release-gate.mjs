#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const normalized = value => Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
const exact = (left, right) => JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const safeMessage = message => { process.stderr.write(`Dependency release gate failed: ${message}.\n`); process.exitCode = 1; };

async function manifests(root) {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "package.json", "apps/*/package.json", "packages/*/package.json"], { cwd: root, encoding: "utf8" });
  return [...new Set(output.trim().split("\n").filter(Boolean))].sort();
}

export async function auditCandidate(root, expectedSourceFingerprint) {
  const files = await manifests(root);
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "package.json", "apps/*/package.json", "packages/*/package.json", "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/Cargo.lock"], { cwd: root, encoding: "utf8" }).trim();
  if (untracked) throw new Error("untracked dependency manifest");
  const fingerprint = hash(execFileSync("git", ["ls-tree", "-r", "--full-tree", "HEAD"], { cwd: root }));
  if (fingerprint !== expectedSourceFingerprint) throw new Error("candidate fingerprint mismatch");
  const lockBytes = await readFile(join(root, "package-lock.json")); const lock = JSON.parse(lockBytes);
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") throw new Error("npm lockfile is missing or malformed");
  for (const file of files) {
    const path = file === "package.json" ? "" : dirname(file); const manifest = JSON.parse(await readFile(join(root, file), "utf8")); const locked = lock.packages[path];
    if (!locked || locked.name !== manifest.name || locked.version !== manifest.version) throw new Error("package manifest is absent from the npm lockfile");
    for (const field of dependencyFields) if (!exact(manifest[field], locked[field])) throw new Error("package dependency declaration is stale or unlocked");
  }
  for (const path of Object.keys(lock.packages).filter(value => value === "" || /^(?:apps|packages)\//.test(value))) {
    const file = path ? `${path}/package.json` : "package.json"; if (!files.includes(file)) throw new Error("npm lockfile contains a missing or substituted package manifest");
  }
  const cargoLock = await readFile(join(root, "apps/desktop/src-tauri/Cargo.lock"));
  const cargoToml = await readFile(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
  if (!/^version = 4$/m.test(cargoLock.toString("utf8")) || !/^\[package\]/m.test(cargoToml)) throw new Error("Cargo lock or manifest is missing or malformed");
  const workflowPaths = [".github/workflows/ci.yml", ".github/workflows/release-provenance.yml"];
  const buildSources = [];
  for (const path of workflowPaths) buildSources.push([path, await readFile(join(root, path), "utf8")]);
  for (const name of (await readdir(root)).filter(value => /^Dockerfile(?:\.|$)/.test(value))) buildSources.push([name, await readFile(join(root, name), "utf8")]);
  for (const [, source] of buildSources) {
    if (/\bnpm\s+(?:i|install)\b/.test(source) || /\bnpm\s+ci\b(?![^\n]*--ignore-scripts)/.test(source)) throw new Error("production build uses an unlocked npm install");
    if (/npm run tauri:build[^\n]*(?:\n[^\n]*){0,2}--bundles/.test(source) && !/npm run tauri:build[^\n]*(?:\n[^\n]*){0,2}--locked/.test(source)) throw new Error("Tauri package build is not locked");
    for (const match of source.matchAll(/\bcargo\s+(?:build|test|fetch|clippy)\b[^\n]*/g)) if (!match[0].includes("--locked")) throw new Error("production Cargo command is not locked");
  }
  const runtimeSource = await readFile(join(root, "apps/desktop/scripts/prepare-node-runtime.mjs"), "utf8");
  const runtimeMatches = [...runtimeSource.matchAll(/sha256:\s*"([a-f0-9]{64})"/g)].map(match => match[1]);
  const runtimeUrls = [...runtimeSource.matchAll(/url:\s*"(https:\/\/nodejs\.org\/dist\/[^"\s]+)"/g)].map(match => match[1]);
  if (runtimeMatches.length !== 2 || runtimeUrls.length !== 2 || /fetch\(/.test(runtimeSource) && !runtimeSource.includes("redirect: \"error\"")) throw new Error("packaged runtime source is not completely pinned");
  return { schemaVersion: 1, sourceFingerprint: fingerprint, npmLockSha256: hash(lockBytes), cargoLockSha256: hash(cargoLock),
    packageManifestSha256: hash(Buffer.from(files.map(file => `${file}\0`).join("") + (await Promise.all(files.map(file => readFile(join(root, file))))).map(hash).join(""))),
    packageManifestCount: files.length, runtimeSha256: runtimeMatches.sort(), buildPathCount: buildSources.length };
}

async function writePrivate(path, value) {
  const output = resolve(path); await mkdir(dirname(output), { recursive: true, mode: 0o700 }); const temporary = `${output}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, output); await chmod(output, 0o600);
}

async function main() {
  const root = resolve(arg("--root") ?? "."); const expected = arg("--source-fingerprint"); const report = arg("--report");
  if (!/^[a-f0-9]{64}$/.test(expected ?? "") || !report) { safeMessage("required candidate identity or private report path is missing"); return; }
  try {
    const evidence = await auditCandidate(root, expected);
    const inventory = spawnSync(process.execPath, [resolve(root, "scripts/dependency-inventory.mjs"), "--check", resolve(root, "docs/dependency-inventory.json")],
      { cwd: root, encoding: "utf8", timeout: 120000, env: { ...process.env, CARGO_NET_OFFLINE: "true", npm_config_offline: "true" } });
    if (inventory.status !== 0) throw new Error(inventory.error?.code === "ETIMEDOUT" ? "locked inventory timed out" : "canonical inventory drift or locked metadata failure");
    await writePrivate(report, { ...evidence, verdict: "PASS", canonicalInventory: true });
    process.stdout.write(`Dependency release gate passed: ${evidence.packageManifestCount} package manifests are candidate-bound and locked.\n`);
  } catch { safeMessage("candidate dependency inventory was rejected"); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
