import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const TRUST = JSON.parse(await readFile(new URL("dependency-policy-trust.json", ROOT), "utf8"));
if (!exactKeys(TRUST, ["schemaVersion", "policySha256"]) || TRUST.schemaVersion !== 1
    || typeof TRUST.policySha256 !== "string" || !/^[a-f0-9]{64}$/.test(TRUST.policySha256)) {
  throw new Error("dependency policy trust anchor is invalid");
}
const REVIEWED_POLICY_SHA256 = TRUST.policySha256;

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validatePolicyShape(policy) {
  if (!exactKeys(policy, ["schemaVersion", "allowedLicenceIdentifiers", "prohibitedLicenceIdentifiers", "allowedSources", "failureConditions"])
      || policy.schemaVersion !== 2
      || !Array.isArray(policy.allowedLicenceIdentifiers) || !Array.isArray(policy.prohibitedLicenceIdentifiers)
      || !exactKeys(policy.allowedSources, ["npmRegistry", "cargoRegistry", "workspace", "git", "file", "unknown"])
      || !exactKeys(policy.failureConditions, ["missingVersion", "missingLicence", "missingSource", "unknownLicence", "prohibitedLicence", "unapprovedSource"])) {
    throw new Error("dependency policy schema is invalid or broadened");
  }
  const allIdentifiers = [...policy.allowedLicenceIdentifiers, ...policy.prohibitedLicenceIdentifiers];
  if (allIdentifiers.some(item => typeof item !== "string" || !item)
      || new Set(allIdentifiers).size !== allIdentifiers.length
      || typeof policy.allowedSources.npmRegistry !== "string" || typeof policy.allowedSources.cargoRegistry !== "string"
      || policy.allowedSources.workspace !== true || policy.allowedSources.git !== false
      || policy.allowedSources.file !== false || policy.allowedSources.unknown !== false
      || Object.values(policy.failureConditions).some(value => value !== true)) {
    throw new Error("dependency policy weakens reviewed fail-closed requirements");
  }
}

async function loadReviewedPolicy(pathOrUrl) {
  const bytes = await readFile(pathOrUrl);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== REVIEWED_POLICY_SHA256) throw new Error("dependency policy differs from the immutable reviewed baseline");
  const policy = JSON.parse(bytes.toString("utf8")); validatePolicyShape(policy); return policy;
}

const POLICY = await loadReviewedPolicy(new URL("dependency-policy.json", ROOT));

function licenceTokens(expression) {
  return expression.replaceAll("/", " OR ").match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [];
}

export function evaluateLicence(expression, policy = POLICY) {
  if (typeof expression !== "string" || !expression.trim()) return { valid: false, reason: "missing licence" };
  const tokens = licenceTokens(expression); let offset = 0; const unknown = new Set();
  const value = identifier => {
    if (policy.prohibitedLicenceIdentifiers.includes(identifier)) return false;
    if (policy.allowedLicenceIdentifiers.includes(identifier)) return true;
    unknown.add(identifier); return false;
  };
  const primary = () => {
    const token = tokens[offset++];
    if (token === "(") { const result = or(); if (tokens[offset++] !== ")") throw new Error("unbalanced licence expression"); return result; }
    if (!token || ["AND", "OR", "WITH", ")"].includes(token)) throw new Error("invalid licence expression");
    return value(token);
  };
  const withException = () => { let result = primary(); while (tokens[offset] === "WITH") { offset++; result = primary() && result; } return result; };
  const and = () => { let result = withException(); while (tokens[offset] === "AND") { offset++; result = withException() && result; } return result; };
  const or = () => { let result = and(); while (tokens[offset] === "OR") { offset++; result = and() || result; } return result; };
  try {
    const permitted = or();
    if (offset !== tokens.length) return { valid: false, reason: "invalid licence expression" };
    if (unknown.size) return { valid: false, reason: `unknown licence identifier(s): ${[...unknown].sort().join(", ")}` };
    return permitted ? { valid: true } : { valid: false, reason: "prohibited licence expression" };
  } catch { return { valid: false, reason: "invalid licence expression" }; }
}

function npmInventory(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") throw new Error("npm lockfile v3 packages are required");
  const roots = Object.keys(lock.packages).filter(path => /^(?:apps|packages)\//.test(path));
  const resolve = (name) => {
    const linkPath = `node_modules/${name}`; const link = lock.packages[linkPath];
    if (link?.link && typeof link.resolved === "string") return link.resolved;
    return linkPath;
  };
  const rootDependencies = new Set(roots.flatMap(path => Object.keys(lock.packages[path]?.dependencies ?? {})));
  const pending = roots.flatMap(path => Object.keys(lock.packages[path]?.dependencies ?? {}).map(resolve));
  const visited = new Set();
  while (pending.length) {
    const path = pending.shift(); if (!path || visited.has(path)) continue; visited.add(path);
    const metadata = lock.packages[path]; if (!metadata) throw new Error(`unresolved npm package path: ${path}`);
    for (const name of Object.keys(metadata.dependencies ?? {})) pending.push(resolve(name));
  }
  return [...visited].map(path => {
    const pkg = lock.packages[path];
    const name = pkg.name ?? (path.startsWith("node_modules/") ? path.slice("node_modules/".length) : null);
    if (!name || typeof pkg.version !== "string" || !pkg.version) throw new Error(`unresolved npm package identity: ${path}`);
    const workspace = /^(?:apps|packages)\//.test(path);
    const source = workspace ? `workspace:${path}` : pkg.resolved;
    return { ecosystem: "npm", name, version: pkg.version, licence: pkg.license ?? null, direct: rootDependencies.has(name), sourcePackage: source ?? null };
  });
}

function cargoInventory(metadata) {
  if (!metadata.resolve?.root || !Array.isArray(metadata.resolve.nodes) || !Array.isArray(metadata.packages)) throw new Error("resolved Cargo metadata is required");
  const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const direct = new Set(); const visited = new Set(); const pending = [metadata.resolve.root];
  const productionDeps = node => (node?.deps ?? []).filter(dep => (dep.dep_kinds ?? []).some(kind => kind.kind !== "dev"));
  for (const dep of productionDeps(nodes.get(metadata.resolve.root))) direct.add(dep.pkg);
  while (pending.length) {
    const id = pending.shift(); if (!id || visited.has(id)) continue; visited.add(id);
    for (const dep of productionDeps(nodes.get(id))) pending.push(dep.pkg);
  }
  return [...visited].filter(id => id !== metadata.resolve.root).map(id => {
    const pkg = packages.get(id); if (!pkg || typeof pkg.version !== "string" || !pkg.version) throw new Error(`unresolved Cargo package: ${id}`);
    return { ecosystem: "cargo", name: pkg.name, version: pkg.version, licence: pkg.license ?? null, direct: direct.has(id), sourcePackage: pkg.source ?? null };
  });
}

export function checkInventory(entries, policy = POLICY) {
  const failures = [];
  for (const entry of entries) {
    const label = `${entry.ecosystem}:${entry.name}@${entry.version ?? "unresolved"}`;
    if (typeof entry.version !== "string" || !entry.version) failures.push(`${label}: unresolved version`);
    const licence = evaluateLicence(entry.licence, policy); if (!licence.valid) failures.push(`${label}: ${licence.reason}`);
    if (typeof entry.sourcePackage !== "string" || !entry.sourcePackage) failures.push(`${label}: unresolved source package`);
    else if (/^(?:git\+|git:|file:)/i.test(entry.sourcePackage)) failures.push(`${label}: disallowed source ${entry.sourcePackage.split(":", 1)[0]}`);
    else if (entry.sourcePackage.startsWith("workspace:")) { /* tracked first-party package */ }
    else if (entry.ecosystem === "npm" && !entry.sourcePackage.startsWith(policy.allowedSources.npmRegistry)) failures.push(`${label}: unapproved npm source`);
    else if (entry.ecosystem === "cargo" && entry.sourcePackage !== policy.allowedSources.cargoRegistry) failures.push(`${label}: unapproved Cargo source`);
  }
  return failures.sort();
}

export async function generateInventory({ npmLock, cargoMetadata }) {
  const entries = [...npmInventory(npmLock), ...cargoInventory(cargoMetadata)]
    .sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.sourcePackage.localeCompare(b.sourcePackage));
  return { schemaVersion: 2, policySha256: REVIEWED_POLICY_SHA256, productionOnly: true, offline: true, packages: entries };
}

async function main() {
  const policyIndex = process.argv.indexOf("--policy");
  let policy = POLICY;
  if (policyIndex !== -1) {
    if (!process.argv[policyIndex + 1]) { console.error("--policy requires a path"); process.exit(2); }
    try { policy = await loadReviewedPolicy(process.argv[policyIndex + 1]); }
    catch (error) { console.error(`Dependency policy failed closed: ${error.message}`); process.exit(1); }
  }
  const fixtureIndex = process.argv.indexOf("--fixture");
  if (fixtureIndex !== -1) {
    const fixture = JSON.parse(await readFile(process.argv[fixtureIndex + 1], "utf8")); const failures = checkInventory(fixture.packages, policy);
    if (failures.length) { console.error(failures.join("\n")); process.exit(1); } return;
  }
  const npmLock = JSON.parse(await readFile(new URL("package-lock.json", ROOT), "utf8"));
  let cargoMetadata;
  try {
    cargoMetadata = JSON.parse(execFileSync("cargo", ["metadata", "--offline", "--locked", "--format-version", "1", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml"], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, CARGO_NET_OFFLINE: "true" },
    }));
  } catch (error) {
    console.error("Cargo dependency metadata failed in locked offline mode. Prime the local cache with `cargo fetch --locked --manifest-path apps/desktop/src-tauri/Cargo.toml` before running this check.");
    process.exit(typeof error.status === "number" && error.status !== 0 ? error.status : 1);
  }
  const inventory = await generateInventory({ npmLock, cargoMetadata }); const failures = checkInventory(inventory.packages, policy);
  if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  const checkIndex = process.argv.indexOf("--check");
  if (checkIndex !== -1) {
    const canonicalPath = process.argv[checkIndex + 1];
    if (!canonicalPath) { console.error("--check requires a canonical inventory path"); process.exit(2); }
    let canonical;
    try { canonical = await readFile(canonicalPath, "utf8"); }
    catch { console.error(`Cannot read canonical dependency inventory: ${canonicalPath}`); process.exit(1); }
    if (canonical !== serialized) {
      console.error(`Dependency inventory drift detected in ${canonicalPath}. Run \`npm run inventory:dependencies\` and review the resulting policy-compliant diff.`);
      process.exit(1);
    }
  }
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex !== -1) await writeFile(process.argv[outputIndex + 1], serialized);
  console.log(`Dependency inventory passed: ${inventory.packages.length} production packages; all versions, licences, and sources satisfy policy.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
