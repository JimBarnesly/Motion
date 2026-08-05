import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyse } from "./static-analysis.mjs";

const EMPTY_POLICY = { schemaVersion: 2, rulesetVersion: "1.2.0", suppressions: [] };
const metadata = finding => ({
  rule: finding.ruleId,
  file: finding.file,
  fingerprint: finding.fingerprint,
  evidence: "scripts/static-analysis.test.mjs exact-boundary regression evidence",
  owner: "Operations & Security Director",
  rationale: "This exact synthetic finding is reviewed solely to test narrow governance.",
  expires: "2099-12-31",
});

async function runFixture(files, policy = EMPTY_POLICY) {
  const directory = await mkdtemp(join(tmpdir(), "motion-static-analysis-"));
  const fixture = join(directory, "fixture.json"); const policyPath = join(directory, "policy.json"); const report = join(directory, "report.json");
  await writeFile(fixture, JSON.stringify({ files })); await writeFile(policyPath, JSON.stringify(policy));
  const result = spawnSync(process.execPath, ["scripts/static-analysis.mjs", "--fixture", fixture, "--policy", policyPath, "--output", report], { encoding: "utf8" });
  return { directory, result, report };
}

for (const [name, file, content, rule] of [
  ["JavaScript eval", "seeded.ts", "const result = eval(userInput);", "js-no-eval"],
  ["JavaScript Function", "seeded.js", "const result = new Function(userInput);", "js-no-eval"],
  ["JavaScript shell", "seeded.mjs", "execSync(userInput);", "js-no-shell-exec"],
  ["JavaScript HTML", "seeded.js", "node.innerHTML = userInput;", "js-no-html-sink"],
  ["JavaScript path", "seeded.js", "join(base, userPath);", "js-no-user-path"],
  ["JavaScript catch", "seeded.js", "try { work(); } catch {}", "js-no-empty-catch"],
  ["Rust unsafe", "seeded.rs", "fn run() { unsafe { core::ptr::read(0 as *const u8); } }", "rust-no-unsafe"],
  ["Rust shell", "seeded.rs", "Command::new(\"bash\").arg(\"-c\");", "rust-no-shell"],
  ["Rust path", "seeded.rs", "PathBuf::from(user);", "rust-no-user-path"],
]) test(`seeded ${name} violation exits non-zero`, async () => {
  const run = await runFixture([{ file, content }]);
  try { assert.equal(run.result.status, 1); assert.match(run.result.stderr, new RegExp(rule)); }
  finally { await rm(run.directory, { recursive: true, force: true }); }
});

test("adjacent identical HTML findings have distinct identities and one suppression leaves the other", async () => {
  const file = "apps/web/boundary.js"; const content = "node.innerHTML = escaped;\nnode.innerHTML = escaped;";
  const findings = analyse([{ file, content }], EMPTY_POLICY);
  assert.equal(findings.length, 2); assert.notEqual(findings[0].fingerprint, findings[1].fingerprint);
  assert.deepEqual(findings.map(item => item.coordinate), [{ line: 1, column: 5, occurrence: 0 }, { line: 2, column: 5, occurrence: 0 }]);
  const run = await runFixture([{ file, content }], { ...EMPTY_POLICY, suppressions: [metadata(findings[0])] });
  try {
    assert.equal(run.result.status, 1); assert.match(run.result.stderr, /boundary\.js:2 js-no-html-sink/);
    const report = JSON.parse(await readFile(run.report, "utf8")); assert.equal(report.schemaVersion, 3); assert.equal(report.findings.length, 1);
    assert.deepEqual(report.findings[0].coordinate, { line: 2, column: 5, occurrence: 0 });
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});

test("adjacent identical eval findings have distinct identities and one suppression leaves the other", async () => {
  const file = "apps/web/boundary.js"; const content = "eval(input);\neval(input);";
  const findings = analyse([{ file, content }], EMPTY_POLICY);
  assert.equal(findings.length, 2); assert.notEqual(findings[0].fingerprint, findings[1].fingerprint);
  assert.deepEqual(findings.map(item => item.coordinate), [{ line: 1, column: 1, occurrence: 0 }, { line: 2, column: 1, occurrence: 0 }]);
  const run = await runFixture([{ file, content }], { ...EMPTY_POLICY, suppressions: [metadata(findings[0])] });
  try { assert.equal(run.result.status, 1); assert.match(run.result.stderr, /boundary\.js:2 js-no-eval/); }
  finally { await rm(run.directory, { recursive: true, force: true }); }
});

test("line and occurrence movement invalidates an otherwise identical suppression", () => {
  const file = "apps/web/boundary.js"; const original = "node.innerHTML = escaped;";
  const suppression = metadata(analyse([{ file, content: original }], EMPTY_POLICY)[0]);
  assert.throws(() => analyse([{ file, content: `\n${original}` }], { ...EMPTY_POLICY, suppressions: [suppression] }), /stale or mismatched/);
  assert.throws(() => analyse([{ file, content: `prefix(); ${original}` }], { ...EMPTY_POLICY, suppressions: [suppression] }), /stale or mismatched/);
});

test("governance rejects expired, missing-evidence, stale, broadened, and duplicate suppressions", async () => {
  const file = "seeded.ts"; const content = "eval(input)"; const finding = analyse([{ file, content }], EMPTY_POLICY)[0];
  const base = metadata(finding);
  const invalid = [
    { ...base, expires: "2020-01-01" },
    Object.fromEntries(Object.entries(base).filter(([key]) => key !== "evidence")),
    { ...base, fingerprint: `sha256:${"0".repeat(64)}` },
    { ...base, file: "*.ts" },
  ];
  for (const suppression of invalid) {
    const run = await runFixture([{ file, content }], { ...EMPTY_POLICY, suppressions: [suppression] });
    try { assert.equal(run.result.status, 1); assert.match(run.result.stderr, /failed closed/); }
    finally { await rm(run.directory, { recursive: true, force: true }); }
  }
  const duplicate = await runFixture([{ file, content }], { ...EMPTY_POLICY, suppressions: [base, structuredClone(base)] });
  try { assert.equal(duplicate.result.status, 1); assert.match(duplicate.result.stderr, /duplicate/); }
  finally { await rm(duplicate.directory, { recursive: true, force: true }); }
});

test("an untracked first-party source file fails the inventory closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "motion-static-root-"));
  try {
    for (const root of ["apps", "packages", "scripts"]) await mkdir(join(directory, root), { recursive: true });
    await writeFile(join(directory, "apps", "tracked.js"), "export const safe = true;\n");
    execFileSync("git", ["init", "-q"], { cwd: directory }); execFileSync("git", ["add", "apps/tracked.js"], { cwd: directory });
    await writeFile(join(directory, "apps", "untracked.ts"), "export const hidden = eval(input);\n");
    const policyPath = join(directory, "policy.json"); await writeFile(policyPath, JSON.stringify(EMPTY_POLICY));
    const result = spawnSync(process.execPath, ["scripts/static-analysis.mjs", "--root", directory, "--policy", policyPath], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /untracked first-party source/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("sensitive source content is never retained or echoed by a failing finding", async () => {
  const canary = ["ghp", "SENSITIVE_STATIC_BOUNDARY_1234567890"].join("_");
  const privatePath = "/home/operator/private/static-boundary";
  const run = await runFixture([{ file: "apps/web/seeded.js", content: `eval(input); // ${canary} ${privatePath}` }]);
  try {
    assert.equal(run.result.status, 1);
    const retained = await readFile(run.report, "utf8");
    for (const sensitive of [canary, privatePath]) {
      assert.equal(`${run.result.stdout}${run.result.stderr}`.includes(sensitive), false);
      assert.equal(retained.includes(sensitive), false);
    }
    assert.equal((await import("node:fs/promises").then(({ stat }) => stat(run.report))).mode & 0o777, 0o600);
  } finally { await rm(run.directory, { recursive: true, force: true }); }
});
