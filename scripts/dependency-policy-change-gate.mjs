import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const POLICY_PATH = "dependency-policy.json";
const TRUST_PATH = "dependency-policy-trust.json";
const RECORD_PATH = "dependency-policy-change.json";
export const CONTROL_PLANE_PATHS = [
  ".github/CODEOWNERS", ".github/workflows/ci.yml", ".github/workflows/release-provenance.yml",
  "docs/dependency-inventory.json", "scripts/dependency-inventory.mjs", "scripts/dependency-inventory.test.mjs",
  "scripts/dependency-policy-change-gate.mjs", "scripts/dependency-policy-change-gate.test.mjs",
  "scripts/vulnerability-collector.mjs", "scripts/vulnerability-collector.test.mjs", "scripts/vulnerability-gate.mjs", "scripts/vulnerability-gate.test.mjs", "vulnerability-policy.json",
];

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function parseJson(bytes, label) {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}
function flattenPolicy(policy) {
  const values = new Map();
  for (const id of policy.allowedLicenceIdentifiers ?? []) values.set(`licence:allowed:${id}`, true);
  for (const id of policy.prohibitedLicenceIdentifiers ?? []) values.set(`licence:prohibited:${id}`, true);
  for (const [key, value] of Object.entries(policy.allowedSources ?? {})) values.set(`source:${key}`, value);
  for (const [key, value] of Object.entries(policy.failureConditions ?? {})) values.set(`failure:${key}`, value);
  values.set("schemaVersion", policy.schemaVersion); return values;
}
export function scopeDiff(oldPolicyBytes, newPolicyBytes) {
  if (oldPolicyBytes === null) return ["baseline:established"];
  const oldValues = flattenPolicy(parseJson(oldPolicyBytes, "old policy"));
  const newValues = flattenPolicy(parseJson(newPolicyBytes, "new policy"));
  const keys = new Set([...oldValues.keys(), ...newValues.keys()]);
  return [...keys].filter(key => oldValues.get(key) !== newValues.get(key)).sort().map(key => {
    const before = oldValues.has(key) ? JSON.stringify(oldValues.get(key)) : "<absent>";
    const after = newValues.has(key) ? JSON.stringify(newValues.get(key)) : "<absent>";
    return `${key}:${before}->${after}`;
  });
}
export function controlPlaneDiff(oldFiles = {}, newFiles = {}) {
  return CONTROL_PLANE_PATHS.filter(path => {
    const oldValue = oldFiles[path] ?? null; const newValue = newFiles[path] ?? null;
    return (oldValue === null ? null : digest(oldValue)) !== (newValue === null ? null : digest(newValue));
  }).map(path => {
    const describe = value => value === null || value === undefined ? "absent" : `sha256:${digest(value)}`;
    return `${path}:${describe(oldFiles[path])}->${describe(newFiles[path])}`;
  });
}
function trustDigest(bytes, label) {
  if (bytes === null) return null; const trust = parseJson(bytes, label);
  if (!exactKeys(trust, ["schemaVersion", "policySha256"]) || trust.schemaVersion !== 1
      || typeof trust.policySha256 !== "string" || !/^[a-f0-9]{64}$/.test(trust.policySha256)) throw new Error(`${label} is invalid`);
  return trust.policySha256;
}

export function verifyPolicyChange({ oldPolicyBytes, newPolicyBytes, oldTrustBytes, newTrustBytes, recordBytes, oldControlPlane = {}, newControlPlane = {} }) {
  if (newPolicyBytes === null || newTrustBytes === null) throw new Error("dependency policy and trust anchor must not be removed");
  const oldDigest = oldPolicyBytes === null ? null : digest(oldPolicyBytes); const newDigest = digest(newPolicyBytes);
  const policyChanged = oldDigest !== newDigest;
  const trustChanged = oldTrustBytes === null || digest(oldTrustBytes) !== digest(newTrustBytes);
  const expectedControl = controlPlaneDiff(oldControlPlane, newControlPlane);
  if (!policyChanged && !trustChanged && expectedControl.length === 0) return { changed: false };
  if (policyChanged !== trustChanged) throw new Error("policy and trust anchor must change together under independent review");
  if (policyChanged) {
    if (trustDigest(oldTrustBytes, "old trust anchor") !== oldDigest) throw new Error("old trust anchor does not authenticate the old policy");
    if (trustDigest(newTrustBytes, "new trust anchor") !== newDigest) throw new Error("new trust anchor does not authenticate the new policy");
  }
  if (recordBytes === null) throw new Error("governed dependency control-plane change requires a separately reviewed policy-change record");
  const record = parseJson(recordBytes, "policy-change record");
  if (!exactKeys(record, ["schemaVersion", "oldPolicySha256", "newPolicySha256", "rationale", "approverRole", "scopeDiff", "controlPlaneDiff"])
      || record.schemaVersion !== 2 || record.oldPolicySha256 !== oldDigest || record.newPolicySha256 !== newDigest
      || typeof record.rationale !== "string" || record.rationale.trim().length < 30
      || record.approverRole !== "Operations & Security Director" || !Array.isArray(record.scopeDiff) || !Array.isArray(record.controlPlaneDiff)) {
    throw new Error("policy-change record metadata or digests do not match the reviewed change");
  }
  const expectedScope = scopeDiff(oldPolicyBytes, newPolicyBytes);
  if (JSON.stringify(record.scopeDiff) !== JSON.stringify(expectedScope) || JSON.stringify(record.controlPlaneDiff) !== JSON.stringify(expectedControl)) {
    throw new Error("policy-change record scope or control-plane diff does not exactly match the change");
  }
  return { changed: true, oldDigest, newDigest, scopeDiff: expectedScope, controlPlaneDiff: expectedControl };
}

function git(args, cwd = ROOT) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
function validCommit(value) { return typeof value === "string" && /^[a-f0-9]{40}$/.test(value); }
export function deriveBasePlan({ eventName, event, manualBase }) {
  if (eventName === "pull_request") {
    const base = event.pull_request?.base?.sha; if (!validCommit(base)) throw new Error("pull request base SHA is missing or invalid");
    return { kind: "merge-base", ref: base };
  }
  if (eventName === "push") {
    if (validCommit(event.before) && !/^0+$/.test(event.before)) return { kind: "exact", ref: event.before };
    const branch = event.repository?.default_branch;
    if (typeof branch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error("new-branch push lacks a trusted default branch");
    return { kind: "merge-base", ref: `refs/remotes/origin/${branch}` };
  }
  if (eventName === "workflow_dispatch") {
    if (!validCommit(manualBase)) throw new Error("manual dispatch requires an explicit 40-character comparison_base SHA");
    return { kind: "exact", ref: manualBase };
  }
  throw new Error(`unsupported event for dependency governance: ${eventName || "missing"}`);
}
export function resolveComparisonBase({ eventName, event, manualBase, headSha, cwd = ROOT }) {
  if (!validCommit(headSha)) throw new Error("head SHA is missing or invalid");
  const plan = deriveBasePlan({ eventName, event, manualBase });
  git(["cat-file", "-e", `${plan.ref}^{commit}`], cwd);
  const base = plan.kind === "merge-base" ? git(["merge-base", headSha, plan.ref], cwd) : git(["rev-parse", `${plan.ref}^{commit}`], cwd);
  if (!validCommit(base)) throw new Error("trusted comparison base could not be resolved"); return base;
}
function fromGit(ref, path) {
  try { return Buffer.from(execFileSync("git", ["show", `${ref}:${path}`], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return null; }
}
async function current(path, required = true) {
  try { return await readFile(new URL(path, ROOT)); }
  catch (error) { if (!required && error.code === "ENOENT") return null; throw error; }
}
async function main() {
  const value = flag => { const index = process.argv.indexOf(flag); return index === -1 ? null : process.argv[index + 1]; };
  try {
    const eventName = value("--event-name"); const eventPath = value("--event-path"); const headSha = value("--head-sha");
    if (!eventPath) throw new Error("event payload path is required");
    const event = JSON.parse(await readFile(eventPath, "utf8"));
    const baseRef = resolveComparisonBase({ eventName, event, manualBase: value("--manual-base"), headSha });
    const oldControlPlane = {}; const newControlPlane = {};
    for (const path of CONTROL_PLANE_PATHS) { oldControlPlane[path] = fromGit(baseRef, path); newControlPlane[path] = await current(path, false); }
    const result = verifyPolicyChange({
      oldPolicyBytes: fromGit(baseRef, POLICY_PATH), newPolicyBytes: await current(POLICY_PATH),
      oldTrustBytes: fromGit(baseRef, TRUST_PATH), newTrustBytes: await current(TRUST_PATH),
      recordBytes: await current(RECORD_PATH, false), oldControlPlane, newControlPlane,
    });
    console.log(result.changed ? `Dependency governance record verified against ${baseRef}.` : `Dependency governance control plane is unchanged from ${baseRef}.`);
  } catch (error) { console.error(`Dependency policy change gate failed closed: ${error.message}`); process.exit(1); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
