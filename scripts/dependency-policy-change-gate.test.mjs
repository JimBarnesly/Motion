import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONTROL_PLANE_PATHS, controlPlaneDiff, deriveBasePlan, resolveComparisonBase, scopeDiff, verifyPolicyChange } from "./dependency-policy-change-gate.mjs";

const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const digest = value => createHash("sha256").update(value).digest("hex");
const trust = policyBytes => bytes({ schemaVersion: 1, policySha256: digest(policyBytes) });
const record = (oldPolicy, newPolicy, oldControlPlane = {}, newControlPlane = {}) => bytes({
  schemaVersion: 2,
  oldPolicySha256: digest(oldPolicy),
  newPolicySha256: digest(newPolicy),
  rationale: "Separately reviewed synthetic policy change for governance testing.",
  approverRole: "Operations & Security Director",
  scopeDiff: scopeDiff(oldPolicy, newPolicy),
  controlPlaneDiff: controlPlaneDiff(oldControlPlane, newControlPlane),
});

test("event base plans never silently fall back to the previous commit", () => {
  const base = "1".repeat(40); const before = "2".repeat(40);
  assert.deepEqual(deriveBasePlan({ eventName: "pull_request", event: { pull_request: { base: { sha: base } } } }), { kind: "merge-base", ref: base });
  assert.deepEqual(deriveBasePlan({ eventName: "push", event: { before, repository: { default_branch: "main" } } }), { kind: "exact", ref: before });
  assert.deepEqual(deriveBasePlan({ eventName: "push", event: { before: "0".repeat(40), repository: { default_branch: "main" } } }), { kind: "merge-base", ref: "refs/remotes/origin/main" });
  assert.deepEqual(deriveBasePlan({ eventName: "workflow_dispatch", event: {}, manualBase: base }), { kind: "exact", ref: base });
  assert.throws(() => deriveBasePlan({ eventName: "workflow_dispatch", event: {} }), /explicit.*comparison_base/);
});

test("a multi-commit new branch compares against the default-branch merge base", async () => {
  const directory = await mkdtemp(join(tmpdir(), "motion-governance-base-"));
  const run = args => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  try {
    run(["init", "-q", "-b", "main"]); run(["config", "user.name", "Governance Test"]); run(["config", "user.email", "test@example.invalid"]);
    await writeFile(join(directory, "state.txt"), "base\n"); run(["add", "state.txt"]); run(["commit", "-qm", "base"]); const base = run(["rev-parse", "HEAD"]);
    run(["update-ref", "refs/remotes/origin/main", base]); run(["switch", "-qc", "feature"]);
    await writeFile(join(directory, "state.txt"), "policy change\n"); run(["commit", "-qam", "policy"]);
    await writeFile(join(directory, "state.txt"), "policy change\nanchor change\n"); run(["commit", "-qam", "anchor"]); const head = run(["rev-parse", "HEAD"]);
    const resolved = resolveComparisonBase({ eventName: "push", event: { before: "0".repeat(40), repository: { default_branch: "main" } }, headSha: head, cwd: directory });
    assert.equal(resolved, base); assert.notEqual(resolved, run(["rev-parse", "HEAD^"]));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const path of [".github/workflows/ci.yml", "scripts/dependency-policy-change-gate.mjs", ".github/CODEOWNERS"]) {
  test(`${path} tampering requires an exact independently reviewed control-plane record`, async () => {
    assert.ok(CONTROL_PLANE_PATHS.includes(path));
    const policy = await readFile("dependency-policy.json"); const anchor = await readFile("dependency-policy-trust.json");
    const oldFiles = { [path]: Buffer.from("reviewed\n") }; const newFiles = { [path]: Buffer.from("tampered\n") };
    assert.throws(() => verifyPolicyChange({ oldPolicyBytes: policy, newPolicyBytes: policy, oldTrustBytes: anchor, newTrustBytes: anchor,
      recordBytes: null, oldControlPlane: oldFiles, newControlPlane: newFiles }), /separately reviewed/);
    assert.doesNotThrow(() => verifyPolicyChange({ oldPolicyBytes: policy, newPolicyBytes: policy, oldTrustBytes: anchor, newTrustBytes: anchor,
      recordBytes: record(policy, policy, oldFiles, newFiles), oldControlPlane: oldFiles, newControlPlane: newFiles }));
  });
}

test("ordinary package inventory updates need no policy-change record", async () => {
  const policy = await readFile("dependency-policy.json"); const anchor = await readFile("dependency-policy-trust.json");
  assert.deepEqual(verifyPolicyChange({ oldPolicyBytes: policy, newPolicyBytes: policy, oldTrustBytes: anchor, newTrustBytes: anchor, recordBytes: null }), { changed: false });
});

for (const [name, mutate] of [
  ["licence", policy => { policy.allowedLicenceIdentifiers.push("GPL-3.0-only"); }],
  ["source", policy => { policy.allowedSources.git = true; }],
  ["failure", policy => { policy.failureConditions.missingLicence = false; }],
]) test(`${name} broadening plus refreshed anchor fails without independent record`, async () => {
  const oldPolicy = await readFile("dependency-policy.json"); const oldTrust = await readFile("dependency-policy-trust.json");
  const changed = JSON.parse(oldPolicy); mutate(changed); const newPolicy = bytes(changed); const newTrust = trust(newPolicy);
  assert.throws(() => verifyPolicyChange({ oldPolicyBytes: oldPolicy, newPolicyBytes: newPolicy, oldTrustBytes: oldTrust, newTrustBytes: newTrust, recordBytes: null }), /separately reviewed/);
  assert.doesNotThrow(() => verifyPolicyChange({ oldPolicyBytes: oldPolicy, newPolicyBytes: newPolicy, oldTrustBytes: oldTrust, newTrustBytes: newTrust, recordBytes: record(oldPolicy, newPolicy) }));
});

test("stale digests, self-asserted role, and incomplete scope fail closed", async () => {
  const oldPolicy = await readFile("dependency-policy.json"); const oldTrust = await readFile("dependency-policy-trust.json");
  const changed = JSON.parse(oldPolicy); changed.allowedSources.file = true; const newPolicy = bytes(changed); const newTrust = trust(newPolicy);
  for (const mutate of [
    item => { item.newPolicySha256 = "0".repeat(64); },
    item => { item.approverRole = "Engineering Director"; },
    item => { item.scopeDiff = []; },
  ]) {
    const item = JSON.parse(record(oldPolicy, newPolicy)); mutate(item);
    assert.throws(() => verifyPolicyChange({ oldPolicyBytes: oldPolicy, newPolicyBytes: newPolicy, oldTrustBytes: oldTrust, newTrustBytes: newTrust, recordBytes: bytes(item) }));
  }
});
