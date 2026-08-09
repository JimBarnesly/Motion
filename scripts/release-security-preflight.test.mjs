import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { executeGateChain, productionGates } from "./release-security-preflight.mjs";

const fixture = new URL("./test/fixtures/release-preflight-gate.mjs", import.meta.url).pathname;
const harness = new URL("./test/fixtures/release-preflight-harness.mjs", import.meta.url).pathname;
const names = ["secret", "unsafe-default", "diagnostic-leakage", "runtime-confinement", "backup-integrity", "release-manifest"];
const plan = modes => names.map(name => ({ name, command: process.execPath, args: [fixture, modes[name] ?? "pass"], env: { npm_config_offline: "true" } }));
const withRoot = async action => { const root = await mkdtemp(join(tmpdir(), "motion-release-preflight-")); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } };

test("clean synthetic candidate passes with private non-disclosing evidence", () => withRoot(async root => {
  const evidence = join(root, "evidence.json"); const result = await executeGateChain(plan({}), evidence);
  assert.equal(result.verdict, "PASS"); assert.deepEqual(result.gates.map(gate => gate.name), names);
  assert.equal((await stat(evidence)).mode & 0o777, 0o600);
  const bytes = await readFile(evidence, "utf8"); assert.doesNotMatch(bytes, /PRIVATE_CANARY|private\/operator/);
  assert.equal(spawnSync(process.execPath, [harness], { encoding: "utf8" }).status, 0);
}));

for (const name of names) test(`${name} independently blocks release without disclosing command output`, () => withRoot(async root => {
  const evidence = join(root, "evidence.json"); const result = await executeGateChain(plan({ [name]: "leak" }), evidence);
  assert.equal(result.verdict, "FAIL"); assert.equal(result.gates.find(gate => gate.name === name)?.passed, false);
  assert.equal(result.gates.filter(gate => gate.passed).length, names.length - 1);
  const bytes = await readFile(evidence, "utf8"); assert.doesNotMatch(bytes, /PRIVATE_CANARY|private\/operator/); assert.equal((await stat(evidence)).mode & 0o777, 0o600);
  const exited = spawnSync(process.execPath, [harness, name], { encoding: "utf8" });
  assert.notEqual(exited.status, 0); assert.doesNotMatch(exited.stdout + exited.stderr, /PRIVATE_CANARY|private\/operator/);
}));

test("missing or skipped command fails closed", () => withRoot(async root => {
  const gates = plan({}); gates[2] = { ...gates[2], command: join(root, "missing-command") };
  const result = await executeGateChain(gates, join(root, "evidence.json"));
  assert.equal(result.verdict, "FAIL"); assert.deepEqual(result.gates[2], { name: "diagnostic-leakage", passed: false, exitStatus: null });
}));

test("production plan is fixed, offline, and scans source plus staging", () => {
  const gates = productionGates({ directory: "candidate", version: "0.1.0", commit: "a".repeat(40), repository: "owner/repo", scanner: ".tools/gitleaks", evidenceDirectory: "evidence" });
  assert.deepEqual(gates.map(gate => gate.name), names);
  assert.ok(gates.every(gate => gate.command === process.execPath && gate.env.CARGO_NET_OFFLINE === "true" && gate.env.npm_config_offline === "true"));
  assert.deepEqual(gates[0].args.slice(0, 7), ["scripts/secret-scan.mjs", "--scanner", ".tools/gitleaks", "--root", ".", "--staging", "candidate"]);
  assert.deepEqual(gates[5].args.slice(0, 5), ["scripts/release-candidate-integrity.mjs", "--root", ".", "--report", "evidence/dependency-inventory.json"]);
  assert.ok(gates.every(gate => !gate.args.includes("||") && !gate.args.includes("true")));
});

test("workflow keeps least privilege and all gates before signing and release upload", async () => {
  const workflow = await readFile(".github/workflows/release-provenance.yml", "utf8");
  const gate = workflow.indexOf("Run mandatory local release security preflight");
  assert.ok(gate > 0 && gate < workflow.indexOf("sigstore/cosign-installer"));
  assert.ok(gate < workflow.indexOf("Sign manifest with GitHub OIDC identity"));
  assert.ok(gate < workflow.indexOf("Generate keyless GitHub build provenance"));
  assert.ok(gate < workflow.indexOf("motion-release-${{ needs.plan.outputs.version }}"));
  assert.match(workflow, /permissions: \{\}/); assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /path: artifacts\/release-security\/\*\.json/);
  assert.doesNotMatch(workflow, /release-security-preflight[^\n]*\|\| true/);
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  for (const command of ["test:secret-scan", "test:unsafe-defaults", "test:diagnostic-leakage", "test:dependency-release-gate", "test:runtime-confinement", "test:backup-integrity", "test:release-security-preflight"]) assert.ok(ci.includes(command), command);
  for (const source of [workflow, ci]) for (const line of source.split("\n").filter(value => /^\s*- uses:/.test(value))) assert.match(line, /@[a-f0-9]{40}(?:\s|$)/, line);
  const preflightJob = workflow.slice(workflow.indexOf("  preflight:"), workflow.indexOf("  provenance:"));
  assert.doesNotMatch(preflightJob, /id-token:\s*write|attestations:\s*write/);
});
