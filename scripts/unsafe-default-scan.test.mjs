import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function executeAudit(files) {
  const root = await mkdtemp(join(tmpdir(), "motion-unsafe-default-test-"));
  for (const [path, content, mode = 0o600] of files) { const target = join(root, path); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, content, { mode }); await chmod(target, mode); }
  const report = join(root, "private", "report.json");
  const result = spawnSync(process.execPath, ["scripts/unsafe-default-scan.mjs", "--fixture", root, "--report", report], { encoding: "utf8" });
  return { root, report, result };
}

for (const [rule, content] of [
  ["permissive-bind", "host = '0.0.0.0'"], ["disabled-authentication", "disable_auth = true"],
  ["unsafe-cors", "Access-Control-Allow-Origin: *"], ["unsafe-csp", "csp = \"script-src 'unsafe-eval'\""],
  ["production-debug-default", "diagnostics: true"],
]) test(`seeded ${rule} fails with redacted private evidence`, async () => {
  const seeded = `prefix-${content}-private-token`;
  const audit = await executeAudit([["config/production.yml", seeded]]);
  try { assert.equal(audit.result.status, 1); const body = await readFile(audit.report, "utf8"); assert.match(body, new RegExp(rule)); assert.equal(body.includes(seeded), false); assert.equal(`${audit.result.stdout}${audit.result.stderr}`.includes(seeded), false); assert.equal((await stat(audit.report)).mode & 0o777, 0o600); }
  finally { await rm(audit.root, { recursive: true, force: true }); }
});

test("world-readable sensitive files fail without retaining contents", async () => {
  const seeded = "credential-material-must-not-appear"; const audit = await executeAudit([["config/credentials.json", seeded, 0o644]]);
  try { assert.equal(audit.result.status, 1); const body = await readFile(audit.report, "utf8"); assert.match(body, /sensitive-file-permissions/); assert.equal(body.includes(seeded), false); }
  finally { await rm(audit.root, { recursive: true, force: true }); }
});

test("local fail-closed production defaults pass", async () => {
  const audit = await executeAudit([["config/production.json", JSON.stringify({ host: "127.0.0.1", authentication: "required", diagnostics: false })]]);
  try { assert.equal(audit.result.status, 0, audit.result.stderr); assert.deepEqual(JSON.parse(await readFile(audit.report, "utf8")).findings, []); }
  finally { await rm(audit.root, { recursive: true, force: true }); }
});
