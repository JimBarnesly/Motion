import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_PATH = resolve(new URL("../", import.meta.url).pathname);
const RULESET_VERSION = "1.2.0";
const SOURCE_ROOTS = ["apps", "packages", "scripts"];
const EXCLUDED_DIRECTORIES = new Set(["dist", "dist-ts", "node_modules", "target", "test", "tests", "fixtures"]);
const SOURCE_EXTENSION = /\.(?:[cm]?js|ts|rs)$/;
const RULES = [
  { id: "js-no-eval", languages: ["js"], pattern: /\beval\s*\(|\bnew\s+Function\s*\(/g, message: "Dynamic code evaluation is injection-prone." },
  { id: "js-no-shell-exec", languages: ["js"], pattern: /\bexecSync\s*\(|\bshell\s*:\s*true\b|(?:import|require)[^\n]*(?:child_process|node:child_process)[^\n]*\bexec\b/g, message: "Shell execution can permit command injection; use argument-vector process APIs." },
  { id: "js-no-html-sink", languages: ["js"], pattern: /\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\s*\(|\bdocument\.write\s*\(/g, message: "Raw HTML sinks require a reviewed sanitizer boundary." },
  { id: "js-no-empty-catch", languages: ["js"], pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g, message: "Empty catch blocks silently discard security-relevant errors." },
  { id: "js-no-user-path", languages: ["js"], pattern: /\b(?:join|resolve)\s*\([^\n)]*\b(?:requestPath|userPath|inputPath)\b[^\n)]*\)/gi, message: "User-derived paths require explicit containment validation." },
  { id: "rust-no-unsafe", languages: ["rust"], pattern: /\bunsafe\s*(?:fn\b|\{)/g, message: "First-party unsafe Rust requires explicit review." },
  { id: "rust-no-shell", languages: ["rust"], pattern: /Command::new\s*\(\s*"(?:sh|bash|cmd|powershell(?:\.exe)?)"|\.arg\s*\(\s*"-c"\s*\)/gi, message: "Shell process execution can permit command injection." },
  { id: "rust-no-user-path", languages: ["rust"], pattern: /PathBuf::from\s*\(\s*(?:request|user|input)\b/gi, message: "User-derived paths require explicit containment validation." },
];

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function exactLogicalPath(file) {
  return typeof file === "string" && file.length > 0 && file === posix.normalize(file)
    && !file.startsWith("/") && !file.includes("\\") && !file.split("/").includes("..")
    && !/[?*\[\]{}]/.test(file);
}

function validatePolicy(policy, now) {
  if (!exactKeys(policy, ["schemaVersion", "rulesetVersion", "suppressions"])
      || policy.schemaVersion !== 2 || policy.rulesetVersion !== RULESET_VERSION || !Array.isArray(policy.suppressions)) {
    throw new Error("static-analysis policy schema/ruleset version mismatch");
  }
  const ruleIds = new Set(RULES.map(rule => rule.id));
  const identities = new Set();
  for (const item of policy.suppressions) {
    if (!exactKeys(item, ["rule", "file", "fingerprint", "evidence", "owner", "rationale", "expires"])) {
      throw new Error("every suppression requires exactly rule, file, fingerprint, evidence, owner, rationale, and expiry");
    }
    if (!ruleIds.has(item.rule) || !exactLogicalPath(item.file)) throw new Error("each suppression requires one exact file and known rule");
    if (typeof item.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.fingerprint)) throw new Error(`${item.file}:${item.rule} has a missing or invalid fingerprint`);
    if (typeof item.evidence !== "string" || item.evidence.trim().length < 20) throw new Error(`${item.file}:${item.rule} requires substantive evidence`);
    if (typeof item.owner !== "string" || item.owner.trim().length < 3) throw new Error(`${item.file}:${item.rule} requires an owner`);
    if (typeof item.rationale !== "string" || item.rationale.trim().length < 20) throw new Error(`${item.file}:${item.rule} requires a substantive rationale`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.expires) || !Number.isFinite(Date.parse(`${item.expires}T23:59:59Z`))
        || Date.parse(`${item.expires}T23:59:59Z`) < now.getTime()) throw new Error(`${item.file}:${item.rule} suppression is invalid or expired`);
    const identity = `${item.rule}\0${item.file}\0${item.fingerprint}`;
    if (identities.has(identity)) throw new Error(`duplicate suppression: ${item.file}:${item.rule}:${item.fingerprint}`);
    identities.add(identity);
  }
}

function language(file) { return extname(file) === ".rs" ? "rust" : "js"; }

function isCandidatePath(file) {
  const parts = file.split("/");
  return SOURCE_ROOTS.includes(parts[0]) && SOURCE_EXTENSION.test(file)
    && !parts.some(part => EXCLUDED_DIRECTORIES.has(part))
    && !file.endsWith(".test.mjs") && !file.endsWith(".test.ts");
}

function fingerprint(ruleId, file, matchedCode, lineText, line, column, occurrence) {
  const digest = createHash("sha256").update(`${ruleId}\0${file}\0${matchedCode}\0${lineText}\0${line}\0${column}\0${occurrence}`).digest("hex");
  return `sha256:${digest}`;
}

function rawFindings(files) {
  const findings = [];
  for (const { file, content } of files) for (const rule of RULES) {
    if (!rule.languages.includes(language(file))) continue;
    const lineOrdinals = new Map();
    for (const match of content.matchAll(rule.pattern)) {
      const before = content.slice(0, match.index);
      const line = before.split("\n").length;
      const lineStart = before.lastIndexOf("\n") + 1;
      const lineEnd = content.indexOf("\n", match.index);
      const lineText = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trim();
      const column = match.index - lineStart + 1;
      const occurrence = lineOrdinals.get(line) ?? 0;
      lineOrdinals.set(line, occurrence + 1);
      const coordinate = { line, column, occurrence };
      findings.push({ ruleId: rule.id, file, line, column, occurrence, coordinate,
        fingerprint: fingerprint(rule.id, file, match[0], lineText, line, column, occurrence), severity: "error", message: rule.message });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId) || a.fingerprint.localeCompare(b.fingerprint));
}

export function analyse(files, policy, now = new Date()) {
  validatePolicy(policy, now);
  const candidates = rawFindings(files);
  const suppressions = new Map(policy.suppressions.map(item => [`${item.rule}\0${item.file}\0${item.fingerprint}`, item]));
  const matched = new Set();
  const findings = candidates.filter(item => {
    const identity = `${item.ruleId}\0${item.file}\0${item.fingerprint}`;
    if (!suppressions.has(identity)) return true;
    matched.add(identity);
    return false;
  });
  for (const identity of suppressions.keys()) if (!matched.has(identity)) throw new Error("static-analysis suppression fingerprint is stale or mismatched");
  return findings;
}

async function walk(directory, results, rootPath) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) await walk(absolute, results, rootPath);
    } else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name) && !entry.name.endsWith(".test.mjs") && !entry.name.endsWith(".test.ts")) {
      results.push(relative(rootPath, absolute).split(sep).join("/"));
    }
  }
}

async function sourceInventory(rootPath = ROOT_PATH) {
  const candidates = [];
  for (const root of SOURCE_ROOTS) {
    const absolute = resolve(rootPath, root);
    const metadata = await lstat(absolute);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`source root is not a trusted directory: ${root}`);
    await walk(absolute, candidates, rootPath);
  }
  candidates.sort();
  const tracked = new Set(execFileSync("git", ["ls-files", "-z", "--", ...SOURCE_ROOTS], { cwd: rootPath, encoding: "utf8" }).split("\0").filter(Boolean));
  const untracked = candidates.filter(file => !tracked.has(file));
  if (untracked.length) throw new Error(`untracked first-party source is outside the candidate: ${untracked.join(", ")}`);
  const inventory = new Set(candidates);
  const omitted = [...tracked].filter(file => isCandidatePath(file) && !inventory.has(file)).sort();
  if (omitted.length) throw new Error(`tracked first-party source is omitted from the scan inventory: ${omitted.join(", ")}`);
  return Promise.all(candidates.map(async file => ({ file, content: await readFile(resolve(rootPath, file), "utf8") })));
}

async function main() {
  const value = flag => { const index = process.argv.indexOf(flag); return index === -1 ? null : process.argv[index + 1]; };
  const policyPath = value("--policy") ?? "static-analysis-policy.json"; const output = value("--output"); const fixture = value("--fixture"); const scanRoot = value("--root");
  try {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    const files = fixture ? JSON.parse(await readFile(fixture, "utf8")).files : await sourceInventory(scanRoot ? resolve(scanRoot) : ROOT_PATH);
    const findings = analyse(files, policy);
    const report = { schemaVersion: 3, rulesetVersion: RULESET_VERSION, inventory: files.map(({ file }) => file), findings };
    if (output) {
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      await chmod(output, 0o600);
    }
    if (findings.length) { for (const item of findings) console.error(`${item.file}:${item.line} ${item.ruleId}: ${item.message}`); process.exit(1); }
    console.log(`Static analysis passed: ${files.length} first-party files checked with ${RULES.length} explicit security rules.`);
  } catch (error) { console.error(`Static analysis failed closed: ${error.message}`); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
