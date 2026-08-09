import assert from "node:assert/strict";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const node = process.execPath;
const generator = new URL("./release-manifest.mjs", import.meta.url).pathname;
const verifier = new URL("./verify-release-structure.mjs", import.meta.url).pathname;
const version = "0.1.0"; const commit = "a".repeat(40); const fingerprint = "b".repeat(64);
const recipe = "c".repeat(64); const runtimes = { x86_64: "d".repeat(64), aarch64: "e".repeat(64) };
const run = (script, args) => spawnSync(node, [script, ...args], { encoding: "utf8" });
const verifyArgs = directory => ["--directory", directory, "--version", version, "--commit", commit, "--repository", "owner/repo", "--source-fingerprint", fingerprint,
  "--runtime-x86_64-sha256", runtimes.x86_64, "--runtime-aarch64-sha256", runtimes.aarch64];
const packagePath = (directory, architecture, format) => join(directory, `Motion_${version}_${architecture}.${format === "appimage" ? "AppImage" : "deb"}`);

async function completeCandidate(root) {
  const directory = join(root, "complete"); await mkdir(directory);
  for (const architecture of ["x86_64", "aarch64"]) for (const format of ["appimage", "deb"]) {
    const path = packagePath(directory, architecture, format); const mode = format === "appimage" ? 0o755 : 0o644;
    await writeFile(path, `synthetic-${architecture}-${format}`, { mode }); await chmod(path, mode);
  }
  const result = run(generator, ["--directory", directory, "--output", join(directory, "release-manifest.json"), "--version", version,
    "--commit", commit, "--repository", "owner/repo", "--source-fingerprint", fingerprint, "--source-date-epoch", "1700000000",
    "--recipe-sha256", recipe, "--runtime-x86_64-sha256", runtimes.x86_64, "--runtime-aarch64-sha256", runtimes.aarch64]);
  assert.equal(result.status, 0, result.stderr); return directory;
}

async function cloneCandidate(source, root, name) {
  const target = join(root, name); await mkdir(target);
  for (const entry of await readdir(source)) await copyFile(join(source, entry), join(target, entry));
  return target;
}

test("complete synthetic release is deterministic and exactly bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-manifest-complete-"));
  try {
    const candidate = await completeCandidate(root); const result = run(verifier, verifyArgs(candidate));
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(candidate, "release-manifest.json")));
    assert.equal(manifest.schemaVersion, 2); assert.equal(manifest.sourceFingerprint, fingerprint);
    assert.deepEqual(manifest.build, { platform: "linux", sourceDateEpoch: 1700000000, recipeSha256: recipe });
    assert.deepEqual(manifest.trust, { sigstoreBundle: "release-manifest.sigstore.json", provenanceBundle: "release-provenance.jsonl" });
    assert.deepEqual(manifest.artifacts.map(item => [item.name, item.platform, item.mode, item.runtimeSha256]), [
      [`Motion_${version}_aarch64.AppImage`, "linux", 0o755, runtimes.aarch64], [`Motion_${version}_aarch64.deb`, "linux", 0o644, runtimes.aarch64],
      [`Motion_${version}_x86_64.AppImage`, "linux", 0o755, runtimes.x86_64], [`Motion_${version}_x86_64.deb`, "linux", 0o644, runtimes.x86_64]
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("every candidate tamper fails closed without disclosing seeded content", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-manifest-tamper-")); const canary = `SENSITIVE_${Date.now()}_${process.pid}`;
  try {
    const source = await completeCandidate(root);
    const cases = [
      ["missing", async d => rm(packagePath(d, "aarch64", "deb"))],
      ["substituted", async d => writeFile(packagePath(d, "x86_64", "deb"), canary)],
      ["duplicated", async d => { const m = JSON.parse(await readFile(join(d, "release-manifest.json"))); m.artifacts[1] = m.artifacts[0]; await writeFile(join(d, "release-manifest.json"), JSON.stringify(m), { mode: 0o644 }); }],
      ["extra", async d => writeFile(join(d, `extra-${canary}`), "extra", { mode: 0o600 })],
      ["stale", async d => { const m = JSON.parse(await readFile(join(d, "release-manifest.json"))); m.sourceFingerprint = "f".repeat(64); await writeFile(join(d, "release-manifest.json"), JSON.stringify(m), { mode: 0o644 }); }],
      ["malformed", async d => writeFile(join(d, "release-manifest.json"), `{${canary}`, { mode: 0o644 })],
      ["traversal", async d => { const m = JSON.parse(await readFile(join(d, "release-manifest.json"))); m.artifacts[0].name = `../${canary}`; await writeFile(join(d, "release-manifest.json"), JSON.stringify(m), { mode: 0o644 }); }],
      ["permission", async d => chmod(packagePath(d, "aarch64", "deb"), 0o666)],
      ["manifest-permission", async d => chmod(join(d, "release-manifest.json"), 0o666)],
      ["hash", async d => { const m = JSON.parse(await readFile(join(d, "release-manifest.json"))); m.artifacts[0].sha256 = "0".repeat(64); await writeFile(join(d, "release-manifest.json"), JSON.stringify(m), { mode: 0o644 }); }],
      ["size", async d => { const m = JSON.parse(await readFile(join(d, "release-manifest.json"))); m.artifacts[0].size += 1; await writeFile(join(d, "release-manifest.json"), JSON.stringify(m), { mode: 0o644 }); }],
      ["runtime", async d => { const m = JSON.parse(await readFile(join(d, "release-manifest.json"))); m.artifacts[0].runtimeSha256 = "0".repeat(64); await writeFile(join(d, "release-manifest.json"), JSON.stringify(m), { mode: 0o644 }); }],
      ["platform", async d => { const m = JSON.parse(await readFile(join(d, "release-manifest.json"))); m.artifacts[0].platform = "other"; await writeFile(join(d, "release-manifest.json"), JSON.stringify(m), { mode: 0o644 }); }],
      ["build", async d => { const m = JSON.parse(await readFile(join(d, "release-manifest.json"))); m.build.sourceDateEpoch = -1; await writeFile(join(d, "release-manifest.json"), JSON.stringify(m), { mode: 0o644 }); }],
      ["trust", async d => { const m = JSON.parse(await readFile(join(d, "release-manifest.json"))); m.trust.sigstoreBundle = `../${canary}`; await writeFile(join(d, "release-manifest.json"), JSON.stringify(m), { mode: 0o644 }); }]
    ];
    for (const [name, mutate] of cases) {
      const candidate = await cloneCandidate(source, root, name); await mutate(candidate); const result = run(verifier, verifyArgs(candidate));
      assert.notEqual(result.status, 0, `${name} unexpectedly passed`); assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false, name);
    }
    for (const kind of ["symlink", "hardlink"]) {
      const candidate = await cloneCandidate(source, root, kind); const path = packagePath(candidate, "x86_64", "appimage"); const target = join(root, `${kind}-target`);
      await rm(path); await copyFile(packagePath(source, "x86_64", "appimage"), target); await chmod(target, 0o755);
      if (kind === "symlink") await symlink(target, path); else await link(target, path);
      const result = run(verifier, verifyArgs(candidate)); assert.notEqual(result.status, 0); assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
