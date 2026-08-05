import assert from "node:assert/strict";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { build } from "esbuild";

const node = process.execPath;
const generator = new URL("./release-manifest.mjs", import.meta.url).pathname;
const preVerifier = new URL("./verify-release-structure.mjs", import.meta.url).pathname;
const verifier = new URL("./verify-release.mjs", import.meta.url).pathname;
const commit = "a".repeat(40); const version = "0.1.0";
const run = (script, args) => spawnSync(node, [script, ...args], { encoding: "utf8" });
const structureArgs = (directory, expectedVersion = version, expectedCommit = commit) => ["--directory", directory, "--version", expectedVersion, "--commit", expectedCommit, "--repository", "owner/repo"];
const verifyArgs = (directory, tool) => [...structureArgs(directory), "--certificate-identity-regexp", "^https://github.example/workflow$", "--cosign", tool, "--gh", tool];

test("pre-sign verifier rejects metadata and every package-set tamper before signing", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-pre-sign-test-")); const source = join(root, "source");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(source));
    for (const architecture of ["x86_64", "aarch64"]) for (const extension of ["AppImage", "deb"]) await writeFile(join(source, `Motion_${version}_${architecture}.${extension}`), `${architecture}:${extension}`);
    assert.equal(run(generator, ["--directory", source, "--output", join(source, "release-manifest.json"), "--version", version, "--commit", commit, "--repository", "owner/repo"]).status, 0);
    assert.equal(run(preVerifier, structureArgs(source)).status, 0);
    const fixture = async name => { const directory = join(root, name); await import("node:fs/promises").then(({ mkdir }) => mkdir(directory)); for (const file of await import("node:fs/promises").then(({ readdir }) => readdir(source))) await copyFile(join(source, file), join(directory, file)); return directory; };
    const wrongVersion = join(root, "self-consistent-wrong-version"); await import("node:fs/promises").then(({ mkdir }) => mkdir(wrongVersion));
    for (const architecture of ["x86_64", "aarch64"]) for (const extension of ["AppImage", "deb"]) await writeFile(join(wrongVersion, `Motion_9.9.9_${architecture}.${extension}`), `${architecture}:${extension}`);
    assert.equal(run(generator, ["--directory", wrongVersion, "--output", join(wrongVersion, "release-manifest.json"), "--version", "9.9.9", "--commit", commit, "--repository", "owner/repo"]).status, 0);
    assert.notEqual(run(preVerifier, structureArgs(wrongVersion)).status, 0);
    const wrongCommit = join(root, "self-consistent-wrong-commit"); await import("node:fs/promises").then(({ mkdir }) => mkdir(wrongCommit));
    for (const file of await import("node:fs/promises").then(({ readdir }) => readdir(source))) if (file !== "release-manifest.json") await copyFile(join(source, file), join(wrongCommit, file));
    assert.equal(run(generator, ["--directory", wrongCommit, "--output", join(wrongCommit, "release-manifest.json"), "--version", version, "--commit", "b".repeat(40), "--repository", "owner/repo"]).status, 0);
    assert.notEqual(run(preVerifier, structureArgs(wrongCommit)).status, 0);
    const tampered = await fixture("tampered"); await writeFile(join(tampered, `Motion_${version}_x86_64.deb`), "changed"); assert.notEqual(run(preVerifier, structureArgs(tampered)).status, 0);
    const omitted = await fixture("omitted"); await rm(join(omitted, `Motion_${version}_aarch64.AppImage`)); assert.notEqual(run(preVerifier, structureArgs(omitted)).status, 0);
    const substituted = await fixture("substituted"); await writeFile(join(substituted, `Motion_${version}_x86_64.AppImage`), await readFile(join(source, `Motion_${version}_aarch64.AppImage`))); assert.notEqual(run(preVerifier, structureArgs(substituted)).status, 0);
    const extra = await fixture("extra"); await writeFile(join(extra, `Motion_${version}_riscv64.deb`), "extra"); assert.notEqual(run(preVerifier, structureArgs(extra)).status, 0);
    const duplicate = await fixture("duplicate"); const manifest = JSON.parse(await readFile(join(duplicate, "release-manifest.json"))); manifest.artifacts[1] = structuredClone(manifest.artifacts[0]); await writeFile(join(duplicate, "release-manifest.json"), JSON.stringify(manifest)); assert.notEqual(run(preVerifier, structureArgs(duplicate)).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release workflow gates every signing, attestation, and final upload behind pre-sign verification", async () => {
  const workflow = await readFile(".github/workflows/release-provenance.yml", "utf8");
  const gate = workflow.indexOf("Verify unsigned release structure before signing");
  assert.ok(gate > workflow.indexOf("Scan release manifests and packaged text resources before signing"));
  assert.ok(gate < workflow.indexOf("sigstore/cosign-installer")); assert.ok(gate < workflow.indexOf("Sign manifest with GitHub OIDC identity"));
  assert.ok(gate < workflow.indexOf("Generate keyless GitHub build provenance")); assert.ok(gate < workflow.indexOf("motion-release-${{ needs.plan.outputs.version }}"));
});

test("release verifier binds version, commit, artifacts, signature, provenance, and signer", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-provenance-test-"));
  const source = join(root, "source"); const tool = join(root, "trust-tool");
  try {
    await writeFile(tool, "#!/bin/sh\nexit 0\n"); await chmod(tool, 0o700);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(source));
    for (const architecture of ["x86_64", "aarch64"]) for (const extension of ["AppImage", "deb"]) await writeFile(join(source, `Motion_${version}_${architecture}.${extension}`), `${architecture}:${extension}`);
    const manifest = join(source, "release-manifest.json");
    assert.equal(run(generator, ["--directory", source, "--output", manifest, "--version", version, "--commit", commit, "--repository", "owner/repo"]).status, 0);
    const repeatedManifest = join(source, "release-manifest-repeated.json");
    assert.equal(run(generator, ["--directory", source, "--output", repeatedManifest, "--version", version, "--commit", commit, "--repository", "owner/repo"]).status, 0);
    assert.deepEqual(await readFile(repeatedManifest), await readFile(manifest));
    await rm(repeatedManifest);
    assert.equal(run(preVerifier, structureArgs(source)).status, 0);
    await writeFile(join(source, "release-manifest.sigstore.json"), "signed");
    await writeFile(join(source, "release-provenance.jsonl"), "provenance");
    assert.equal(run(verifier, verifyArgs(source, tool)).status, 0);

    const fixture = async name => { const directory = join(root, name); await import("node:fs/promises").then(({ mkdir }) => mkdir(directory)); for (const file of await import("node:fs/promises").then(({ readdir }) => readdir(source))) await copyFile(join(source, file), join(directory, file)); return directory; };
    const wrongVersion = join(root, "wrong-version"); await import("node:fs/promises").then(({ mkdir }) => mkdir(wrongVersion));
    for (const architecture of ["x86_64", "aarch64"]) for (const extension of ["AppImage", "deb"]) await writeFile(join(wrongVersion, `Motion_9.9.9_${architecture}.${extension}`), `${architecture}:${extension}`);
    assert.equal(run(generator, ["--directory", wrongVersion, "--output", join(wrongVersion, "release-manifest.json"), "--version", "9.9.9", "--commit", commit, "--repository", "owner/repo"]).status, 0);
    await writeFile(join(wrongVersion, "release-manifest.sigstore.json"), "signed"); await writeFile(join(wrongVersion, "release-provenance.jsonl"), "provenance");
    assert.notEqual(run(verifier, verifyArgs(wrongVersion, tool)).status, 0);
    const tampered = await fixture("tampered"); await writeFile(join(tampered, `Motion_${version}_x86_64.deb`), "changed"); assert.notEqual(run(verifier, verifyArgs(tampered, tool)).status, 0);
    const omitted = await fixture("omitted"); await rm(join(omitted, `Motion_${version}_aarch64.AppImage`)); assert.notEqual(run(verifier, verifyArgs(omitted, tool)).status, 0);
    const substituted = await fixture("substituted"); await writeFile(join(substituted, `Motion_${version}_x86_64.AppImage`), await readFile(join(source, `Motion_${version}_aarch64.AppImage`))); assert.notEqual(run(verifier, verifyArgs(substituted, tool)).status, 0);
    const unexpected = await fixture("unexpected"); await writeFile(join(unexpected, `Motion_${version}_riscv64.deb`), "unexpected"); assert.notEqual(run(verifier, verifyArgs(unexpected, tool)).status, 0);
    const wrongCommit = await fixture("wrong-commit"); assert.notEqual(run(verifier, verifyArgs(wrongCommit, tool).map((value, index, args) => args[index - 1] === "--commit" ? "b".repeat(40) : value)).status, 0);
    const unsigned = await fixture("unsigned"); await rm(join(unsigned, "release-manifest.sigstore.json")); assert.notEqual(run(verifier, verifyArgs(unsigned, tool)).status, 0);
    const failedTrust = await fixture("failed-trust"); await writeFile(tool, "#!/bin/sh\nexit 1\n"); assert.notEqual(run(verifier, verifyArgs(failedTrust, tool)).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release control files reject links and non-regular types before trust tools run", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-release-controls-test-"));
  const valid = join(root, "valid"); const tool = join(root, "trust-tool"); const marker = join(root, "trust-invoked");
  try {
    await mkdir(valid);
    for (const architecture of ["x86_64", "aarch64"]) for (const extension of ["AppImage", "deb"]) await writeFile(join(valid, `Motion_${version}_${architecture}.${extension}`), `${architecture}:${extension}`);
    assert.equal(run(generator, ["--directory", valid, "--output", join(valid, "release-manifest.json"), "--version", version, "--commit", commit, "--repository", "owner/repo"]).status, 0);
    await writeFile(join(valid, "release-manifest.sigstore.json"), "signed"); await writeFile(join(valid, "release-provenance.jsonl"), "provenance");
    await writeFile(tool, `#!/bin/sh\nfor argument in "$@"; do case "$argument" in /proc/self/fd/*) test -r "$argument" || exit 4;; esac; done\nprintf invoked >> "${marker}"\n`); await chmod(tool, 0o700);
    assert.equal(run(verifier, verifyArgs(valid, tool)).status, 0);
    await rm(marker);

    const fixture = async name => { const directory = join(root, name); await mkdir(directory); for (const file of await import("node:fs/promises").then(({ readdir }) => readdir(valid))) await copyFile(join(valid, file), join(directory, file)); return directory; };
    const controls = ["release-manifest.json", "release-manifest.sigstore.json", "release-provenance.jsonl"];
    for (const control of controls) for (const kind of ["symlink", "directory", "fifo", "hardlink"]) {
      const directory = await fixture(`${control}-${kind}`); const path = join(directory, control); const preserved = join(root, `${control}-${kind}-target`);
      await rm(path);
      if (kind === "symlink") { await writeFile(preserved, "control-target"); await symlink(preserved, path); }
      else if (kind === "directory") await mkdir(path);
      else if (kind === "fifo") assert.equal(spawnSync("mkfifo", [path]).status, 0);
      else { await writeFile(preserved, "hard-linked-control"); await link(preserved, path); }
      const results = control === "release-manifest.json"
        ? [run(preVerifier, structureArgs(directory)), run(verifier, verifyArgs(directory, tool))]
        : [run(verifier, verifyArgs(directory, tool))];
      for (const result of results) assert.notEqual(result.status, 0, `${control} ${kind} unexpectedly passed`);
      await assert.rejects(readFile(marker));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release control-file replacements fail identity checks before trust tools run", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-release-race-test-")); const valid = join(root, "valid");
  const tool = join(root, "trust-tool"); const marker = join(root, "trust-invoked");
  try {
    await mkdir(valid);
    for (const architecture of ["x86_64", "aarch64"]) for (const extension of ["AppImage", "deb"]) await writeFile(join(valid, `Motion_${version}_${architecture}.${extension}`), `${architecture}:${extension}`);
    assert.equal(run(generator, ["--directory", valid, "--output", join(valid, "release-manifest.json"), "--version", version, "--commit", commit, "--repository", "owner/repo"]).status, 0);
    await writeFile(join(valid, "release-manifest.sigstore.json"), "signed"); await writeFile(join(valid, "release-provenance.jsonl"), "provenance");
    await writeFile(tool, `#!/bin/sh\nprintf invoked >> "${marker}"\n`); await chmod(tool, 0o700);
    const replacement = new URL("./test/release-race-filesystem.mjs", import.meta.url).pathname;
    const bundle = async (entry, outfile) => build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", target: "node24",
      plugins: [{ name: "release-race-test-adapter", setup(api) { api.onResolve({ filter: /release-filesystem\.mjs$/ }, () => ({ path: replacement })); } }] });
    const racePre = join(root, "race-pre.mjs"); const racePost = join(root, "race-post.mjs"); await bundle(preVerifier, racePre); await bundle(verifier, racePost);
    const fixture = async name => { const directory = join(root, name); await mkdir(directory); for (const file of await readdir(valid)) await copyFile(join(valid, file), join(directory, file)); return directory; };

    for (const control of ["release-manifest.json", "release-manifest.sigstore.json", "release-provenance.jsonl"]) {
      const directory = await fixture(`same-device-${control}`); const target = join(directory, control); const original = await readFile(target); const originalState = await lstat(target);
      const incoming = join(root, `same-device-${control}.incoming`); const incomingBytes = Buffer.from(`replacement-${control}`); await writeFile(incoming, incomingBytes); const incomingState = await lstat(incoming);
      const originalEvidence = join(root, `same-device-${control}.original`);
      const environment = { ...process.env, MOTION_RELEASE_RACE_PLAN: JSON.stringify({ target, replacement: incoming, originalEvidence }) };
      const result = spawnSync(node, [control === "release-manifest.json" ? racePre : racePost, ...(control === "release-manifest.json" ? structureArgs(directory) : verifyArgs(directory, tool))], { encoding: "utf8", env: environment });
      assert.notEqual(result.status, 0); await assert.rejects(readFile(marker));
      assert.deepEqual(await readFile(originalEvidence), original); assert.equal((await lstat(originalEvidence)).ino, originalState.ino);
      assert.deepEqual(await readFile(target), incomingBytes); assert.equal((await lstat(target)).ino, incomingState.ino);
    }

    const crossRoot = "/dev/shm"; let crossSupported = false;
    try { crossSupported = (await stat(crossRoot)).isDirectory() && (await stat(crossRoot)).dev !== (await stat(root)).dev; } catch {}
    if (crossSupported) for (const control of ["release-manifest.json", "release-manifest.sigstore.json", "release-provenance.jsonl"]) {
      const directory = await fixture(`cross-device-${control}`); const target = join(directory, control); const original = await readFile(target);
      const crossDirectory = await mkdtemp(join(crossRoot, "motion-release-race-")); const incoming = join(crossDirectory, "incoming"); await writeFile(incoming, `cross-${control}`);
      const originalEvidence = join(root, `cross-device-${control}.original`); const environment = { ...process.env, MOTION_RELEASE_RACE_PLAN: JSON.stringify({ target, replacement: incoming, originalEvidence }) };
      try {
        const result = spawnSync(node, [control === "release-manifest.json" ? racePre : racePost, ...(control === "release-manifest.json" ? structureArgs(directory) : verifyArgs(directory, tool))], { encoding: "utf8", env: environment });
        assert.notEqual(result.status, 0); await assert.rejects(readFile(marker)); assert.deepEqual(await readFile(target), original); assert.equal(await readFile(incoming, "utf8"), `cross-${control}`);
      } finally { await rm(crossDirectory, { recursive: true, force: true }); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
