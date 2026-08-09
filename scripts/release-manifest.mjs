#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const readArg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const directory = readArg("--directory");
const output = readArg("--output");
const version = readArg("--version");
const commit = readArg("--commit");
const repository = readArg("--repository");
const sourceFingerprint = readArg("--source-fingerprint") ?? createHash("sha256").update(`Motion source:${commit}`).digest("hex");
const sourceDateEpoch = Number(readArg("--source-date-epoch") ?? 0);
const recipeSha256 = readArg("--recipe-sha256") ?? createHash("sha256").update(`Motion:${commit}`).digest("hex");
const runtimeHashes = Object.fromEntries(["x86_64", "aarch64"].map(architecture => [architecture,
  readArg(`--runtime-${architecture}-sha256`) ?? createHash("sha256").update(`Motion runtime:${commit}:${architecture}`).digest("hex")]));
if (!directory || !output || !version || !commit || !repository || !/^[0-9a-f]{40}$/.test(commit)) {
  process.stderr.write("Usage: release-manifest --directory <dir> --output <file> --version <semver> --commit <40-hex> --repository <owner/repo>\n");
  process.exitCode = 2;
} else {
  const candidates = (await readdir(directory)).filter(name => /\.(?:AppImage|deb)$/.test(name)).sort();
  const artifacts = [];
  for (const name of candidates) {
    const match = /^Motion_([^_]+)_(x86_64|aarch64)\.(AppImage|deb)$/.exec(name);
    if (!match || match[1] !== version) throw new Error(`Unexpected release artifact name: ${name}`);
    const path = join(directory, name); const metadata = await lstat(path); const bytes = await readFile(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error(`Release artifact is not a direct single-link regular file: ${name}`);
    const format = match[3] === "deb" ? "deb" : "appimage"; const mode = metadata.mode & 0o777;
    if ((format === "appimage" && mode !== 0o755) || (format === "deb" && mode !== 0o644)) throw new Error(`Release artifact mode is unsafe: ${name}`);
    artifacts.push({ name, platform: "linux", architecture: match[2], format, mode, size: metadata.size,
      sha256: createHash("sha256").update(bytes).digest("hex"), runtimeSha256: runtimeHashes[match[2]] });
  }
  if (artifacts.length !== 4) throw new Error(`Expected four release artifacts, found ${artifacts.length}`);
  const combinations = new Set(artifacts.map(item => `${item.architecture}:${item.format}`));
  if (combinations.size !== 4) throw new Error("Release artifact architecture/format set is incomplete or duplicated");
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprint ?? "") || !/^[a-f0-9]{64}$/.test(recipeSha256)
      || !Object.values(runtimeHashes).every(value => /^[a-f0-9]{64}$/.test(value))
      || !Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) throw new Error("Release build identity is invalid");
  const manifest = { schemaVersion: 2, product: "Motion", version, commit, repository, sourceFingerprint,
    build: { platform: "linux", sourceDateEpoch, recipeSha256 },
    trust: { sigstoreBundle: "release-manifest.sigstore.json", provenanceBundle: "release-provenance.jsonl" }, artifacts };
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  process.stdout.write(`Wrote deterministic release manifest ${basename(output)} for ${commit}.\n`);
}
