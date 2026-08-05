import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateLicence } from "./dependency-inventory.mjs";

test("licence expressions fail closed while permitting an approved OR choice", () => {
  assert.deepEqual(evaluateLicence("MIT OR GPL-3.0-only"), { valid: true });
  assert.deepEqual(evaluateLicence("MIT AND GPL-3.0-only"), { valid: false, reason: "prohibited licence expression" });
  assert.match(evaluateLicence("Unknown-Seed-1.0").reason, /unknown licence/);
});

for (const fixture of ["dependency-unknown-licence.json", "dependency-disallowed-source.json"]) {
  test(`seeded policy violation fails: ${fixture}`, () => {
    const result = spawnSync(process.execPath, ["scripts/dependency-inventory.mjs", "--fixture", `scripts/test/fixtures/${fixture}`], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `seeded fixture unexpectedly passed: ${result.stdout}`);
  });
}

test("canonical inventory drift fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "motion-inventory-test-"));
  try {
    const canonical = join(directory, "dependency-inventory.json");
    const current = JSON.parse(await readFile("docs/dependency-inventory.json", "utf8"));
    current.packages[0].version = "0.0.0-seeded-drift";
    await writeFile(canonical, `${JSON.stringify(current, null, 2)}\n`);
    const result = spawnSync(process.execPath, ["scripts/dependency-inventory.mjs", "--check", canonical], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "seeded inventory drift unexpectedly passed");
    assert.match(result.stderr, /inventory drift detected/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reviewed policy baseline rejects licence, source, and failure-condition broadening", async () => {
  const baseline = JSON.parse(await readFile("dependency-policy.json", "utf8"));
  const mutations = [
    policy => { policy.prohibitedLicenceIdentifiers = policy.prohibitedLicenceIdentifiers.filter(id => !id.startsWith("GPL-")); },
    policy => { policy.prohibitedLicenceIdentifiers = policy.prohibitedLicenceIdentifiers.filter(id => !id.startsWith("AGPL-")); },
    policy => { policy.prohibitedLicenceIdentifiers = policy.prohibitedLicenceIdentifiers.filter(id => id !== "SSPL-1.0"); },
    policy => { policy.allowedLicenceIdentifiers.push("GPL-3.0-only"); },
    policy => { policy.allowedSources.git = true; },
    policy => { policy.allowedSources.file = true; },
    policy => { policy.allowedSources.unknown = true; },
    policy => { policy.allowedSources.npmRegistry = "https://"; },
    policy => { policy.failureConditions.missingVersion = false; },
    policy => { policy.failureConditions.missingLicence = false; },
    policy => { policy.failureConditions.missingSource = false; },
    policy => { policy.failureConditions.unknownLicence = false; },
  ];
  const directory = await mkdtemp(join(tmpdir(), "motion-policy-test-"));
  try {
    for (const [index, mutate] of mutations.entries()) {
      const policy = structuredClone(baseline); mutate(policy);
      const path = join(directory, `policy-${index}.json`); await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`);
      const result = spawnSync(process.execPath, ["scripts/dependency-inventory.mjs", "--policy", path, "--fixture", "scripts/test/fixtures/dependency-unknown-licence.json"], { encoding: "utf8" });
      assert.notEqual(result.status, 0, `broadened policy ${index} unexpectedly passed`);
      assert.match(result.stderr, /immutable reviewed baseline/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a legitimate package inventory update passes without changing policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "motion-package-update-"));
  try {
    const fixture = join(directory, "fixture.json");
    await writeFile(fixture, JSON.stringify({ packages: [{
      ecosystem: "npm", name: "new-reviewed-package", version: "1.2.3", licence: "MIT", direct: true,
      sourcePackage: "https://registry.npmjs.org/new-reviewed-package/-/new-reviewed-package-1.2.3.tgz",
    }] }));
    const result = spawnSync(process.execPath, ["scripts/dependency-inventory.mjs", "--fixture", fixture], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
