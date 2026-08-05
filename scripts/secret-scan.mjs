import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";

const EXPECTED_VERSION = "8.28.0";
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".csv", ".html", ".ini", ".js", ".json", ".md", ".mjs",
  ".properties", ".rs", ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"
]);
const TEXT_NAMES = new Set(["LICENSE", "NOTICE"]);

function argValues(name) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) values.push(process.argv[++index]);
  }
  return values;
}
function argValue(name, fallback) { return argValues(name).at(-1) ?? fallback; }

const scanner = argValue("--scanner", process.env.GITLEAKS_BIN ?? "gitleaks");
const reportPath = resolve(argValue("--report", "artifacts/secret-scan/findings.json"));
const baseConfigPath = resolve(argValue("--config", "gitleaks.toml"));
const policyPath = resolve(argValue("--policy", "secret-scan-policy.json"));
const stagingRoots = argValues("--staging").map(value => resolve(value));
const work = await mkdtemp(join(tmpdir(), "motion-secret-scan-"));
const scanRoot = join(work, "input");
const rawReport = join(work, "gitleaks.json");

const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

function validatePolicy(policy, baseConfig) {
  if (/^\s*\[\[?[^\]\r\n]*allowlists?[^\]\r\n]*\]\]?/mi.test(baseConfig)) {
    throw new Error("base Gitleaks config contains an unmanaged effective allowlist");
  }
  if (!exactKeys(policy, ["schemaVersion", "scanner", "scope", "suppressions"]) || policy.schemaVersion !== "1.0.0"
      || policy.scanner?.name !== "gitleaks" || policy.scanner?.version !== EXPECTED_VERSION
      || !Array.isArray(policy.suppressions)) {
    throw new Error("secret scanning policy structure or pinned scanner is invalid");
  }
  const ids = new Set();
  const scopes = new Set();
  const governed = [];
  for (const suppression of policy.suppressions) {
    if (!exactKeys(suppression, ["id", "scope", "rationale", "owner", "expires"])) {
      throw new Error("every suppression requires exactly id, scope, rationale, owner, and expiry");
    }
    if (typeof suppression.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(suppression.id) || ids.has(suppression.id)) {
      throw new Error("secret suppression has an invalid or duplicate id");
    }
    ids.add(suppression.id);
    if (typeof suppression.owner !== "string" || suppression.owner.trim().length < 3) throw new Error(`secret suppression is unowned: ${suppression.id}`);
    if (typeof suppression.rationale !== "string" || suppression.rationale.trim().length < 20) throw new Error(`secret suppression is unjustified: ${suppression.id}`);
    if (typeof suppression.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(suppression.expires)) throw new Error(`secret suppression expiry is invalid: ${suppression.id}`);
    const expiry = Date.parse(`${suppression.expires}T23:59:59Z`);
    if (!Number.isFinite(expiry) || expiry < Date.now()) throw new Error(`secret suppression expired: ${suppression.id}`);
    if (!exactKeys(suppression.scope, ["paths", "matchesBase64"])
        || !Array.isArray(suppression.scope.paths) || suppression.scope.paths.length !== 1
        || suppression.scope.paths.some(path => typeof path !== "string" || path.startsWith("/") || path.includes("..")
          || /[*?[\]{}\\]/.test(path) || !path.startsWith("scripts/") || !(path.includes("/test/") || path.endsWith(".test.mjs")))) {
      throw new Error(`secret suppression scope is invalid or broadened: ${suppression.id}`);
    }
    if (!Array.isArray(suppression.scope.matchesBase64) || suppression.scope.matchesBase64.length !== 1
        || suppression.scope.matchesBase64.some(match => typeof match !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(match) || match.length > 280)) {
      throw new Error(`secret suppression match scope is invalid: ${suppression.id}`);
    }
    const scopeKey = JSON.stringify(suppression.scope);
    if (scopes.has(scopeKey)) throw new Error(`duplicate secret suppression scope: ${suppression.id}`);
    scopes.add(scopeKey);
    const literal = Buffer.from(suppression.scope.matchesBase64[0], "base64").toString("utf8");
    if (literal.length < 8 || literal.length > 200 || Buffer.from(literal).toString("base64") !== suppression.scope.matchesBase64[0]) throw new Error(`secret suppression match encoding is invalid: ${suppression.id}`);
    governed.push({ id: suppression.id, path: suppression.scope.paths[0], literal });
  }
  return governed;
}

function safeRelative(root, path) {
  const value = relative(root, path);
  if (!value || value.startsWith(`..${sep}`) || value === "..") throw new Error("scan path escaped its declared root");
  return value;
}

async function isText(path) {
  const name = basename(path);
  if (!TEXT_EXTENSIONS.has(extname(name).toLowerCase()) && !TEXT_NAMES.has(name)) return false;
  const data = await readFile(path);
  return !data.subarray(0, 8192).includes(0);
}

async function copyTextTree(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink in package staging tree: ${safeRelative(source, from)}`);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 });
      await copyTextTree(from, to);
    } else if (entry.isFile() && await isText(from)) {
      await mkdir(resolve(to, ".."), { recursive: true, mode: 0o700 });
      await cp(from, to);
    }
  }
}

try {
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  const baseConfig = await readFile(baseConfigPath, "utf8");
  const governedSuppressions = validatePolicy(policy, baseConfig);
  const version = spawnSync(scanner, ["version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== EXPECTED_VERSION) {
    throw new Error(`gitleaks ${EXPECTED_VERSION} is required; refusing to scan with an absent or different scanner`);
  }

  await mkdir(scanRoot, { recursive: true, mode: 0o700 });
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of tracked) {
    const metadata = await lstat(file);
    if (!metadata.isFile()) continue;
    const target = join(scanRoot, "repository", file);
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await cp(file, target);
  }
  for (const [index, staging] of stagingRoots.entries()) {
    const metadata = await lstat(staging);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("package staging root must be a real directory");
    await copyTextTree(staging, join(scanRoot, `package-${index + 1}`));
  }

  const result = spawnSync(scanner, [
    "dir", scanRoot, "--config", baseConfigPath, "--no-banner",
    "--report-format", "json", "--report-path", rawReport, "--exit-code", "17"
  ], { encoding: "utf8" });
  if (![0, 17].includes(result.status)) throw new Error("secret scanner failed before producing a trustworthy result");
  await chmod(rawReport, 0o600).catch(() => {});
  const raw = JSON.parse(await readFile(rawReport, "utf8").catch(() => "[]"));
  const unsuppressed = [];
  const sourceLines = new Map();
  for (const finding of raw) {
    const file = relative(scanRoot, finding.File);
    const logical = file.replace(/^(?:repository|package-[0-9]+)\//, "");
    if (!sourceLines.has(finding.File)) sourceLines.set(finding.File, (await readFile(finding.File, "utf8")).split(/\r?\n/));
    const fullLine = sourceLines.get(finding.File)[finding.StartLine - 1];
    const suppressed = governedSuppressions.some(suppression => logical === suppression.path
      && finding.Secret === suppression.literal && finding.Match === suppression.literal && fullLine === suppression.literal);
    if (!suppressed) unsuppressed.push(finding);
  }
  const findings = unsuppressed.map(({ RuleID, File, StartLine }) => {
    const file = relative(scanRoot, File);
    return { rule: RuleID, file, line: StartLine, fingerprint: `${RuleID}:${file}:${StartLine}` };
  });
  await mkdir(resolve(reportPath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify({ scanner: `gitleaks-${EXPECTED_VERSION}`, findings }, null, 2)}\n`, { mode: 0o600 });
  await chmod(reportPath, 0o600);
  if (findings.length) {
    console.error(`Secret scan rejected ${findings.length} finding(s). Values are redacted; inspect the private JSON report.`);
    process.exitCode = 1;
  } else {
    console.log(`Secret scan passed ${tracked.length} tracked files and ${stagingRoots.length} package staging tree(s).`);
  }
} catch (error) {
  console.error(`Secret scan failed closed: ${error.message}`);
  process.exitCode = 2;
} finally {
  await rm(work, { recursive: true, force: true });
}
