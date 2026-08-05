import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scanner = process.env.GITLEAKS_BIN ?? resolve(".tools/gitleaks");
const decodeFixture = value => Buffer.from(value, "base64").toString("utf8");

function run(staging, report) {
  return spawnSync(process.execPath, ["scripts/secret-scan.mjs", "--scanner", scanner, "--staging", staging, "--report", report], { encoding: "utf8" });
}

function runGoverned(staging, report, config, policy) {
  return spawnSync(process.execPath, ["scripts/secret-scan.mjs", "--scanner", scanner, "--staging", staging, "--report", report, "--config", config, "--policy", policy], { encoding: "utf8" });
}

test("repository and representative package resources pass with a private report", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-secret-pass-"));
  try {
    await writeFile(join(root, "release-manifest.json"), '{"version":"0.1.0","artifacts":[]}\n');
    await writeFile(join(root, "resource.js"), 'export const product = "Motion";\n');
    await writeFile(join(root, "payload.bin"), Buffer.from([0, 1, 2, 3]));
    const report = join(root, "reports", "findings.json");
    const result = run(root, report);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(report, "utf8")).findings, []);
    assert.equal((await stat(report)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("suppression requires exact governed path and exact whole-line literal", async () => {
  const approved = decodeFixture("TU9USU9OX1RFU1RfQ0FOQVJZX05PVF9BX1NFQ1JFVF8yMDI2");
  const root = await mkdtemp(join(tmpdir(), "motion-secret-conjunction-"));
  try {
    const exact = join(root, "exact"); await mkdir(join(exact, "scripts", "test", "fixtures"), { recursive: true });
    await writeFile(join(exact, "scripts", "test", "fixtures", "secret-scan-allowlisted-canary.txt"), `${approved}\n`);
    assert.equal(run(exact, join(root, "exact.json")).status, 0);

    const cases = [
      ["neighbour", "scripts/test/fixtures/neighbour.txt", approved],
      ["different", "scripts/test/fixtures/secret-scan-allowlisted-canary.txt", decodeFixture("YWNjZXNzX3Rva2VuID0gJ210bl85S3E0VmM3WHMyTHA4SGQ2UmYzV3oxQm41SnkwJw==")],
      ["quoted-double", "scripts/test/fixtures/secret-scan-allowlisted-canary.txt", `"${approved}"`],
      ["quoted-single", "scripts/test/fixtures/secret-scan-allowlisted-canary.txt", `'${approved}'`],
      ["leading-space", "scripts/test/fixtures/secret-scan-allowlisted-canary.txt", `  ${approved}`],
      ["trailing-space", "scripts/test/fixtures/secret-scan-allowlisted-canary.txt", `${approved}  `],
      ["assigned", "scripts/test/fixtures/secret-scan-allowlisted-canary.txt", `value=${approved}`],
      ["prefixed", "scripts/test/fixtures/secret-scan-allowlisted-canary.txt", `prefix-${approved}`],
      ["suffixed", "scripts/test/fixtures/secret-scan-allowlisted-canary.txt", `${approved}-suffix`]
    ];
    for (const [name, path, value] of cases) {
      const staging = join(root, name); const target = join(staging, path);
      await mkdir(resolve(target, ".."), { recursive: true }); await writeFile(target, `${value}\n`);
      const report = join(root, `${name}.json`); const result = run(staging, report);
      assert.notEqual(result.status, 0, `${name} suppression scope unexpectedly passed`);
      assert.equal(`${result.stdout}${result.stderr}${await readFile(report, "utf8")}`.includes(value), false);
      assert.equal((await stat(report)).mode & 0o777, 0o600);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing or differently versioned scanner fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-secret-version-"));
  try {
    await writeFile(join(root, "resource.txt"), "ordinary package resource\n");
    const missing = spawnSync(process.execPath, ["scripts/secret-scan.mjs", "--scanner", join(root, "absent-gitleaks"), "--staging", root, "--report", join(root, "missing.json")], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    const result = spawnSync(process.execPath, ["scripts/secret-scan.mjs", "--scanner", process.execPath, "--staging", root, "--report", join(root, "wrong.json")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ungoverned or expired allowlists cannot hide a seeded token", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-secret-governance-"));
  const token = decodeFixture("YWNjZXNzX3Rva2VuID0gJ210bl80UXI4VHkyV3A2THM5WGEzSGo3S2QxTno1QmMwJw==");
  try {
    const staging = join(root, "staging");
    await mkdir(join(staging, "scripts", "test"), { recursive: true });
    await writeFile(join(staging, "scripts", "test", "seed.txt"), `${token}\n`);
    const base = await readFile("gitleaks.toml", "utf8");
    const productionPolicy = JSON.parse(await readFile("secret-scan-policy.json", "utf8"));
    const policyPath = join(root, "policy.json"); await writeFile(policyPath, JSON.stringify(productionPolicy));
    const unmanagedConfig = join(root, "unmanaged.toml");
    await writeFile(unmanagedConfig, `${base}\n[[allowlists]]\ndescription = "unmanaged"\npaths = [".*"]\n`);
    const unmanaged = runGoverned(staging, join(root, "unmanaged.json"), unmanagedConfig, policyPath);
    assert.notEqual(unmanaged.status, 0);
    assert.equal(`${unmanaged.stdout}${unmanaged.stderr}`.includes(token), false);

    const expiredPolicy = structuredClone(productionPolicy);
    expiredPolicy.suppressions.push({ id: "expired-seed", scope: { paths: ["scripts/test/seed.txt"], matches: [token] }, rationale: "Synthetic expired suppression must never hide this regression token.", owner: "Operations & Security Director", expires: "2020-01-01" });
    await writeFile(policyPath, JSON.stringify(expiredPolicy));
    const expired = runGoverned(staging, join(root, "expired.json"), join(resolve("gitleaks.toml")), policyPath);
    assert.notEqual(expired.status, 0);
    assert.equal(`${expired.stdout}${expired.stderr}`.includes(token), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("suppression governance rejects metadata, scope, duplicate, and config drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-secret-policy-"));
  try {
    const staging = join(root, "staging"); await mkdir(staging);
    await writeFile(join(staging, "resource.txt"), "ordinary resource\n");
    const baseConfig = join(resolve("gitleaks.toml"));
    const original = JSON.parse(await readFile("secret-scan-policy.json", "utf8"));
    const mutations = [
      policy => { policy.suppressions[0].owner = ""; },
      policy => { policy.suppressions[0].rationale = "short"; },
      policy => { policy.suppressions[0].expires = "not-a-date"; },
      policy => { policy.suppressions[0].scope.extra = ["mismatch"]; },
      policy => { policy.suppressions[0].scope.paths = ["scripts/*"]; },
      policy => { policy.suppressions.push(structuredClone(policy.suppressions[0])); },
      policy => { const duplicate = structuredClone(policy.suppressions[0]); duplicate.id = "different-id"; policy.suppressions.push(duplicate); }
    ];
    for (const [index, mutate] of mutations.entries()) {
      const candidate = structuredClone(original); mutate(candidate);
      const policyPath = join(root, `policy-${index}.json`); await writeFile(policyPath, JSON.stringify(candidate));
      const result = runGoverned(staging, join(root, `report-${index}.json`), baseConfig, policyPath);
      assert.notEqual(result.status, 0, `governance mutation ${index} unexpectedly passed`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [name, value] of [
  ["API token", decodeFixture("YWNjZXNzX3Rva2VuID0gJ210bl83THEyVng5S3A0TmM4UnQ2V3kzRmg1SmQxQnMwJw==")],
  ["private key", decodeFixture("LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tClpYaGhiWEJzWlE9PQotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0t")],
  ["credential URL", decodeFixture("aHR0cHM6Ly9idWlsZC11c2VyOnNvbWV0aGluZy1wcml2YXRlLTEyMzQ1QGV4YW1wbGUuaW52YWxpZC9wYXRo")],
  ["high-entropy secret", decodeFixture("Y2xpZW50X3NlY3JldCA9ICcyWXg5UW03Vms0TnA4SnQ2UnMzV2Q1SGMxTGYwWmFCdSc=")],
]) test(`seeded ${name} fails without echoing its value`, async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-secret-fail-"));
  try {
    const seeded = join(root, "seed.txt");
    await writeFile(seeded, `${value}\n`);
    const report = join(root, "findings.json");
    const result = run(root, report);
    assert.notEqual(result.status, 0);
    assert.equal(`${result.stdout}${result.stderr}`.includes(value), false);
    assert.equal((await readFile(report, "utf8")).includes(value), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
