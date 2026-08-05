import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir } from "./release-filesystem.mjs";
import { join } from "node:path";

const exactKeys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");

export async function openDirectRegularFile(path, label) {
  let before;
  try { before = await lstat(path); }
  catch { throw new Error(`${label} is missing`); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`${label} must be a direct single-link regular file`);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error(`${label} could not be opened without following links`); }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error(`${label} changed while being authenticated`);
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function readDirectRegularFile(path, label) {
  const handle = await openDirectRegularFile(path, label);
  try { return await handle.readFile(); }
  finally { await handle.close(); }
}

export async function verifyReleaseStructure({ directory, expectedVersion, expectedCommit, expectedRepository, signed = false }) {
  if (typeof expectedVersion !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(expectedVersion)
      || typeof expectedCommit !== "string" || !/^[0-9a-f]{40}$/.test(expectedCommit)
      || typeof expectedRepository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(expectedRepository)) {
    throw new Error("expected version, full immutable commit, and repository are required");
  }
  const manifestPath = join(directory, "release-manifest.json");
  let manifest; let manifestBytes;
  try { manifestBytes = await readDirectRegularFile(manifestPath, "release manifest"); manifest = JSON.parse(manifestBytes.toString("utf8")); }
  catch { throw new Error("manifest is missing or invalid JSON"); }
  if (!exactKeys(manifest, ["schemaVersion", "product", "version", "commit", "repository", "artifacts"])
      || manifest.schemaVersion !== 1 || manifest.product !== "Motion") throw new Error("manifest shape or product is invalid");
  if (manifest.version !== expectedVersion) throw new Error("manifest version does not match the expected Motion version");
  if (manifest.commit !== expectedCommit) throw new Error("manifest commit does not match the expected immutable commit");
  if (manifest.repository !== expectedRepository) throw new Error("manifest repository does not match the expected repository");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 4) throw new Error("manifest must contain exactly four artifacts");

  const required = new Set(["x86_64:appimage", "x86_64:deb", "aarch64:appimage", "aarch64:deb"]);
  const names = new Set();
  for (const artifact of manifest.artifacts) {
    if (!exactKeys(artifact, ["architecture", "format", "name", "size", "sha256"])) throw new Error("artifact manifest shape is invalid");
    const combination = `${artifact.architecture}:${artifact.format}`;
    if (!required.delete(combination)) throw new Error("artifact architecture/format is duplicated or unsupported");
    const extension = artifact.format === "appimage" ? "AppImage" : "deb";
    const expectedName = `Motion_${expectedVersion}_${artifact.architecture}.${extension}`;
    if (artifact.name !== expectedName || names.has(artifact.name)) throw new Error("artifact name is invalid, substituted, or duplicated");
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error("artifact size or SHA-256 metadata is invalid");
    }
    names.add(artifact.name);
    const path = join(directory, artifact.name); let metadata; let bytes;
    try { metadata = await lstat(path); bytes = await readFile(path); } catch { throw new Error(`manifest artifact is missing: ${artifact.name}`); }
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`artifact is not a regular file: ${artifact.name}`);
    if (bytes.byteLength !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      throw new Error(`artifact size or SHA-256 mismatch: ${artifact.name}`);
    }
  }
  if (required.size) throw new Error("required architecture/format entries are omitted");
  const allowed = new Set(["release-manifest.json", ...names]);
  if (signed) { allowed.add("release-manifest.sigstore.json"); allowed.add("release-provenance.jsonl"); }
  const entries = await readdir(directory);
  const extras = entries.filter(name => !allowed.has(name));
  if (extras.length || entries.length !== allowed.size || [...allowed].some(name => !entries.includes(name))) {
    throw new Error(`release directory contains omitted or extra files${extras.length ? `: ${extras.sort().join(", ")}` : ""}`);
  }
  return { manifest, manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), names: [...names].sort(), manifestPath };
}
