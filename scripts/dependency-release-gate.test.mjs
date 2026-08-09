import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const gate = new URL("./dependency-release-gate.mjs", import.meta.url).pathname;
const canary = `SENSITIVE_DEPENDENCY_${process.pid}`;
const packageLock = (extra = {}) => ({ name: "candidate", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
  "": { name: "candidate", version: "1.0.0", workspaces: ["packages/*"], dependencies: { app: "1.0.0" } },
  "packages/app": { name: "app", version: "1.0.0", dependencies: { dep: "1.0.0" } },
  "node_modules/app": { resolved: "packages/app", link: true },
  "node_modules/dep": { version: "1.0.0", resolved: "https://registry.npmjs.org/dep/-/dep-1.0.0.tgz", integrity: "sha512-seeded", license: "MIT" }, ...extra } });

async function candidate(mutate = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "motion-dependency-candidate-"));
  for (const path of ["packages/app", "apps/desktop/src-tauri", "apps/desktop/scripts", ".github/workflows", "scripts", "docs"]) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "candidate", version: "1.0.0", workspaces: ["packages/*"], dependencies: { app: "1.0.0" } }));
  await writeFile(join(root, "packages/app/package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { dep: "1.0.0" } }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify(packageLock()));
  await writeFile(join(root, "apps/desktop/src-tauri/Cargo.toml"), '[package]\nname = "candidate"\nversion = "1.0.0"\n');
  await writeFile(join(root, "apps/desktop/src-tauri/Cargo.lock"), 'version = 4\n\n[[package]]\nname = "candidate"\nversion = "1.0.0"\n');
  await writeFile(join(root, "apps/desktop/scripts/prepare-node-runtime.mjs"), `const runtimes=[{url:"https://nodejs.org/dist/v1/node-x64.tar.xz",sha256:"${"a".repeat(64)}"},{url:"https://nodejs.org/dist/v1/node-arm64.tar.xz",sha256:"${"b".repeat(64)}"}]; fetch(runtimes[0].url,{redirect: "error"});\n`);
  const workflow = "steps:\n  - run: npm ci --ignore-scripts\n  - run: cargo build --locked\n  - run: npm run tauri:build -- --locked --bundles deb,appimage\n";
  await writeFile(join(root, ".github/workflows/ci.yml"), workflow); await writeFile(join(root, ".github/workflows/release-provenance.yml"), workflow);
  await writeFile(join(root, "scripts/dependency-inventory.mjs"), "process.exit(0);\n"); await writeFile(join(root, "docs/dependency-inventory.json"), "{}\n");
  await mutate(root); execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
  const fingerprint = execFileSync("git", ["ls-tree", "-r", "--full-tree", "HEAD"], { cwd: root });
  return { root, fingerprint: (await import("node:crypto")).createHash("sha256").update(fingerprint).digest("hex") };
}

const run = fixture => spawnSync(process.execPath, [gate, "--root", fixture.root, "--source-fingerprint", fixture.fingerprint, "--report", join(fixture.root, "evidence.json")], { encoding: "utf8" });

test("clean exact candidate dependency inventory passes with private evidence", async () => {
  const fixture = await candidate(); try {
    const result = run(fixture); assert.equal(result.status, 0, result.stderr); const evidence = JSON.parse(await readFile(join(fixture.root, "evidence.json")));
    assert.equal(evidence.verdict, "PASS"); assert.equal(evidence.packageManifestCount, 2); assert.equal((await stat(join(fixture.root, "evidence.json"))).mode & 0o777, 0o600);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

const mutations = [
  ["missing", async root => rm(join(root, "packages/app/package.json"))],
  ["stale", async root => writeFile(join(root, "packages/app/package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { dep: "2.0.0" } }))],
  ["substituted", async root => writeFile(join(root, "packages/app/package.json"), JSON.stringify({ name: canary, version: "1.0.0", dependencies: { dep: "1.0.0" } }))],
  ["unlocked", async root => writeFile(join(root, ".github/workflows/release-provenance.yml"), "steps:\n  - run: npm install\n")],
  ["network", async root => writeFile(join(root, "apps/desktop/scripts/prepare-node-runtime.mjs"), `fetch("https://${canary}.invalid/runtime")\n`)],
  ["package-only", async root => { await mkdir(join(root, "packages/extra")); await writeFile(join(root, "packages/extra/package.json"), JSON.stringify({ name: canary, version: "1.0.0" })); }],
  ["rust-unlocked", async root => writeFile(join(root, ".github/workflows/ci.yml"), "steps:\n  - run: npm ci --ignore-scripts\n  - run: cargo build\n")],
  ["inventory-drift", async root => writeFile(join(root, "scripts/dependency-inventory.mjs"), "process.exit(1);\n")]
];
for (const [name, mutate] of mutations) test(`${name} dependency tamper exits nonzero without disclosure`, async () => {
  const fixture = await candidate(mutate); try { const result = run(fixture); assert.notEqual(result.status, 0); assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false); }
  finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("untracked package manifest fails closed", async () => {
  const fixture = await candidate(); try {
    await mkdir(join(fixture.root, "packages/untracked")); await writeFile(join(fixture.root, "packages/untracked/package.json"), JSON.stringify({ name: canary, version: "1.0.0" }));
    const result = run(fixture); assert.notEqual(result.status, 0); assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
