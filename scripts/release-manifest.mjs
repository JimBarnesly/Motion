#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const readArg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const directory = readArg("--directory");
const output = readArg("--output");
const version = readArg("--version");
const commit = readArg("--commit");
const repository = readArg("--repository");
if (!directory || !output || !version || !commit || !repository || !/^[0-9a-f]{40}$/.test(commit)) {
  process.stderr.write("Usage: release-manifest --directory <dir> --output <file> --version <semver> --commit <40-hex> --repository <owner/repo>\n");
  process.exitCode = 2;
} else {
  const candidates = (await readdir(directory)).filter(name => /\.(?:AppImage|deb)$/.test(name)).sort();
  const artifacts = [];
  for (const name of candidates) {
    const match = /^Motion_([^_]+)_(x86_64|aarch64)\.(AppImage|deb)$/.exec(name);
    if (!match || match[1] !== version) throw new Error(`Unexpected release artifact name: ${name}`);
    const path = join(directory, name); const metadata = await stat(path); const bytes = await readFile(path);
    if (!metadata.isFile()) throw new Error(`Release artifact is not a regular file: ${name}`);
    artifacts.push({ name, architecture: match[2], format: match[3] === "deb" ? "deb" : "appimage", size: metadata.size, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (artifacts.length !== 4) throw new Error(`Expected four release artifacts, found ${artifacts.length}`);
  const combinations = new Set(artifacts.map(item => `${item.architecture}:${item.format}`));
  if (combinations.size !== 4) throw new Error("Release artifact architecture/format set is incomplete or duplicated");
  const manifest = { schemaVersion: 1, product: "Motion", version, commit, repository, artifacts };
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  process.stdout.write(`Wrote deterministic release manifest ${basename(output)} for ${commit}.\n`);
}
