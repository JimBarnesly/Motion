#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const readArg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

export async function executeGateChain(gates, evidencePath, runner = spawnSync) {
  if (!Array.isArray(gates) || !gates.length || gates.some(gate => !exactKeys(gate, ["name", "command", "args", "env"])
      || typeof gate.name !== "string" || typeof gate.command !== "string" || !Array.isArray(gate.args)
      || gate.args.some(value => typeof value !== "string") || !gate.env || typeof gate.env !== "object" || Array.isArray(gate.env))) {
    throw new Error("Release security gate plan is invalid");
  }
  const names = new Set(gates.map(gate => gate.name));
  if (names.size !== gates.length) throw new Error("Release security gate names must be unique");
  const results = [];
  for (const gate of gates) {
    const result = runner(gate.command, gate.args, { cwd: resolve("."), env: { ...process.env, ...gate.env }, encoding: "utf8", stdio: "pipe" });
    results.push({ name: gate.name, passed: result.status === 0, exitStatus: Number.isInteger(result.status) ? result.status : null });
  }
  const evidence = { schemaVersion: 1, verdict: results.every(result => result.passed) ? "PASS" : "FAIL", gates: results };
  const output = resolve(evidencePath); await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, output); await chmod(output, 0o600);
  return evidence;
}

export function productionGates({ directory, version, commit, repository, scanner, evidenceDirectory, sourceFingerprint = createHash("sha256").update(`Motion source:${commit}`).digest("hex"),
    runtimeX8664Sha256 = createHash("sha256").update(`Motion runtime:${commit}:x86_64`).digest("hex"), runtimeAarch64Sha256 = createHash("sha256").update(`Motion runtime:${commit}:aarch64`).digest("hex") }) {
  const node = process.execPath;
  const env = { CARGO_NET_OFFLINE: "true", npm_config_offline: "true" };
  return [
    { name: "secret", command: node, args: ["scripts/secret-scan.mjs", "--scanner", scanner, "--root", ".", "--staging", directory, "--report", `${evidenceDirectory}/secret.json`], env },
    { name: "unsafe-default", command: node, args: ["scripts/unsafe-default-scan.mjs", "--root", ".", "--staging", directory, "--report", `${evidenceDirectory}/unsafe-default.json`], env },
    { name: "diagnostic-leakage", command: node, args: ["--test", "scripts/diagnostic-leakage.test.mjs"], env },
    { name: "runtime-confinement", command: node, args: ["--test", "apps/web/test/network-confinement.test.mjs", "apps/desktop/test/runner.test.mjs"], env },
    { name: "backup-integrity", command: node, args: ["--test", "apps/desktop/test/backup-file.test.mjs", "packages/backup/dist/test/backup.test.js"], env },
    { name: "release-manifest", command: node, args: ["scripts/release-candidate-integrity.mjs", "--root", ".", "--report", `${evidenceDirectory}/dependency-inventory.json`,
      "--directory", directory, "--version", version, "--commit", commit, "--repository", repository, "--source-fingerprint", sourceFingerprint,
      "--runtime-x86_64-sha256", runtimeX8664Sha256, "--runtime-aarch64-sha256", runtimeAarch64Sha256], env }
  ];
}

async function main() {
  const directory = readArg("--directory"); const version = readArg("--version"); const commit = readArg("--commit");
  const repository = readArg("--repository"); const scanner = readArg("--scanner");
  const sourceFingerprint = readArg("--source-fingerprint");
  const runtimeX8664Sha256 = readArg("--runtime-x86_64-sha256"); const runtimeAarch64Sha256 = readArg("--runtime-aarch64-sha256");
  const evidence = readArg("--evidence") ?? "artifacts/release-security/preflight.json";
  const evidenceDirectory = dirname(resolve(evidence));
  if (!directory || !version || !/^[0-9a-f]{40}$/.test(commit ?? "") || !/^[^/\s]+\/[^/\s]+$/.test(repository ?? "") || !/^[a-f0-9]{64}$/.test(sourceFingerprint ?? "")
      || !/^[a-f0-9]{64}$/.test(runtimeX8664Sha256 ?? "") || !/^[a-f0-9]{64}$/.test(runtimeAarch64Sha256 ?? "") || !scanner) {
    process.stderr.write("Release security preflight failed: required release identity or pinned scanner is missing.\n"); process.exit(2);
  }
  const result = await executeGateChain(productionGates({ directory, version, commit, repository, scanner, evidenceDirectory, sourceFingerprint, runtimeX8664Sha256, runtimeAarch64Sha256 }), evidence);
  if (result.verdict !== "PASS") { process.stderr.write("Release security preflight failed: one or more mandatory gates rejected the candidate.\n"); process.exit(1); }
  process.stdout.write("Release security preflight passed all mandatory gates.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
