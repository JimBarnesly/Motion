import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";

const TEXT_EXTENSIONS = new Set([".cjs", ".conf", ".css", ".env", ".html", ".ini", ".js", ".json", ".md", ".mjs", ".properties", ".rs", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"]);
const TEXT_NAMES = new Set(["Dockerfile"]);
const RULES = [
  ["permissive-bind", /(?:\b(?:host|hostname|bind|listen(?:_address)?)\b\s*[:=]\s*["']?0\.0\.0\.0\b|--host(?:=|\s+)0\.0\.0\.0\b)/i],
  ["disabled-authentication", /(?:\b(?:disable|skip|bypass)[_-]?auth(?:entication)?\b\s*[:=]\s*(?:true|1)|\bauth(?:entication)?\b\s*[:=]\s*["']?(?:false|none|off|disabled)\b)/i],
  ["unsafe-cors", /(?:access-control-allow-origin\s*[:=]\s*["']?\*|\bcors\b[^\r\n]{0,40}\borigin\b\s*[:=]\s*["']?\*)/i],
  ["unsafe-csp", /(?:content-security-policy|\bcsp\b)\s*[:=][^\r\n]*(?:unsafe-inline|unsafe-eval|\b(?:false|null|disabled)\b)/i],
  ["production-debug-default", /\b(?:debug|diagnostics?|test[_-]?mode|mock[_-]?mode)\b\s*[:=]\s*(?:true|1)\b/i],
];
const SENSITIVE_NAME = /^(?:credentials?|secrets?|private[_-]?key|id_(?:rsa|dsa|ecdsa|ed25519)|\.env)(?:\.[a-z0-9_-]+)?$/i;

function values(flag) { const found = []; for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === flag) found.push(process.argv[++i]); return found; }
function value(flag, fallback) { return values(flag).at(-1) ?? fallback; }
function logicalPath(root, path) { const result = relative(root, path).split(sep).join("/"); if (!result || result === ".." || result.startsWith("../")) throw new Error("audit path escaped its declared root"); return result; }
function productionCandidate(path) { return !/\.test\.[^.]+$/i.test(basename(path)) && !path.split("/").some(part => ["test", "tests", "fixtures", "spikes", "docs", "node_modules", "target", "dist", "dist-ts", "artifacts"].includes(part)); }
async function textual(path) { if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase()) && !TEXT_NAMES.has(basename(path))) return false; const data = await readFile(path); return !data.subarray(0, 8192).includes(0); }
async function walk(root, directory, prefix, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name); const logical = `${prefix}${logicalPath(root, path)}`;
    if (entry.isSymbolicLink()) throw new Error(`release input contains a symbolic link: ${logical}`);
    if (entry.isDirectory()) await walk(root, path, prefix, files);
    else if (entry.isFile()) files.push({ path, logical, mode: (await lstat(path)).mode & 0o777 });
  }
}

const root = resolve(value("--root", "."));
const report = resolve(value("--report", "artifacts/unsafe-default-scan/findings.json"));
const staging = values("--staging").map(path => resolve(path));
const fixture = value("--fixture", null);
const work = await mkdtemp(join(tmpdir(), "motion-unsafe-default-audit-"));
try {
  const files = [];
  if (fixture) await walk(resolve(fixture), resolve(fixture), "fixture/", files);
  else {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    for (const logical of tracked) { const path = resolve(root, logical); const metadata = await lstat(path); if (metadata.isFile()) files.push({ path, logical: `repository/${logical}`, mode: metadata.mode & 0o777 }); }
    for (const [index, path] of staging.entries()) { const metadata = await lstat(path); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("release staging input must be a real directory"); await walk(path, path, `release-${index + 1}/`, files); }
  }
  const findings = [];
  for (const file of files) {
    const candidate = file.logical.replace(/^(?:repository|release-[0-9]+|fixture)\//, "");
    if (SENSITIVE_NAME.test(basename(candidate)) && (file.mode & 0o077) !== 0) findings.push({ rule: "sensitive-file-permissions", file: file.logical });
    if (!productionCandidate(candidate) || !await textual(file.path)) continue;
    const content = await readFile(file.path, "utf8");
    for (const [rule, pattern] of RULES) if (pattern.test(content)) findings.push({ rule, file: file.logical });
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  await mkdir(resolve(report, ".."), { recursive: true, mode: 0o700 });
  await writeFile(report, `${JSON.stringify({ schemaVersion: 1, findings }, null, 2)}\n`, { mode: 0o600 }); await chmod(report, 0o600);
  if (findings.length) { console.error(`Unsafe-default audit rejected ${findings.length} finding(s). Values are redacted; inspect the private JSON report.`); process.exitCode = 1; }
  else console.log(`Unsafe-default audit passed ${files.length} tracked and release-input files.`);
} catch (error) { console.error(`Unsafe-default audit failed closed: ${error.message}`); process.exitCode = 2; }
finally { await rm(work, { recursive: true, force: true }); }
