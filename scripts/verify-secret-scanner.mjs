import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const EXPECTED_VERSION = "8.28.0";
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const sha256 = value => createHash("sha256").update(value).digest("hex");

function fail() { throw new Error("pinned offline secret scanner is absent, unsupported, or fails integrity verification"); }

export async function verifySecretScanner({ scanner, policyPath, platform = process.platform, architecture = process.arch, runner = spawnSync }) {
  try {
    const policyFile = resolve(policyPath);
    const policy = JSON.parse(await readFile(policyFile, "utf8"));
    if (!exactKeys(policy, ["schemaVersion", "tool", "version", "platforms"])
        || policy.schemaVersion !== "1.0.0" || policy.tool !== "gitleaks" || policy.version !== EXPECTED_VERSION
        || !policy.platforms || typeof policy.platforms !== "object" || Array.isArray(policy.platforms)) fail();
    const key = `${platform}-${architecture}`;
    const entry = policy.platforms[key];
    const allowedKeys = entry?.executableSha256 ? ["archive", "archiveSha256", "executableSha256"] : ["archive", "archiveSha256"];
    if (!exactKeys(entry, allowedKeys) || !/^gitleaks_8\.28\.0_[a-z0-9_]+\.tar\.gz$/.test(entry.archive)
        || !/^[a-f0-9]{64}$/.test(entry.archiveSha256)
        || (entry.executableSha256 && !/^[a-f0-9]{64}$/.test(entry.executableSha256))) fail();

    const scannerPath = resolve(scanner);
    const metadata = await lstat(scannerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0) fail();
    const executable = await readFile(scannerPath);
    const executableHash = sha256(executable);
    let trustedHash = entry.executableSha256;
    const archivePath = join(dirname(scannerPath), "cache", entry.archive);
    try {
      const archiveMetadata = await lstat(archivePath);
      if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink()) fail();
      const archive = await readFile(archivePath);
      if (sha256(archive) !== entry.archiveSha256) fail();
      const extracted = runner("tar", ["-xOzf", archivePath, "gitleaks"], { encoding: null, maxBuffer: 64 * 1024 * 1024, stdio: "pipe" });
      if (extracted.status !== 0 || !Buffer.isBuffer(extracted.stdout)) fail();
      const archiveExecutableHash = sha256(extracted.stdout);
      if (trustedHash && archiveExecutableHash !== trustedHash) fail();
      trustedHash = archiveExecutableHash;
    } catch (error) {
      if (!trustedHash) fail();
      if (error?.message === "pinned offline secret scanner is absent, unsupported, or fails integrity verification") throw error;
    }
    if (executableHash !== trustedHash) fail();

    if (platform !== "linux" || executable.length < 20 || executable.subarray(0, 4).toString("hex") !== "7f454c46") fail();
    const expectedMachine = architecture === "x64" ? 62 : architecture === "arm64" ? 183 : -1;
    if (executable.readUInt16LE(18) !== expectedMachine) fail();
    const version = runner(scannerPath, ["version"], { encoding: "utf8", stdio: "pipe" });
    if (version.status !== 0 || version.stdout.trim() !== EXPECTED_VERSION) fail();
    return { scannerPath, version: EXPECTED_VERSION, platform: key, sha256: executableHash };
  } catch (error) {
    if (error?.message === "pinned offline secret scanner is absent, unsupported, or fails integrity verification") throw error;
    fail();
  }
}
