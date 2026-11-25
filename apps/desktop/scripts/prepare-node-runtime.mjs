import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "24.22.3";
export const OFFICIAL_ARCHIVES = Object.freeze({
  x64: { file: `node-v${NODE_VERSION}-linux-x64.tar.xz`, url: "https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz", sha256: "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb" },
  arm64: { file: `node-v${NODE_VERSION}-linux-arm64.tar.xz`, url: "https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-arm64.tar.xz", sha256: "6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c" }
});
export const WINDOWS_ARCHIVES = Object.freeze({
  x64: { file: `node-v${NODE_VERSION}-win-x64.zip`, url: "https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip", sha256: "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f" },
  arm64: { file: `node-v${NODE_VERSION}-win-arm64.zip`, url: "https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-arm64.zip", sha256: "b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14" }
});
export const RUNTIME_ARCHIVES = Object.freeze({ linux: OFFICIAL_ARCHIVES, win32: WINDOWS_ARCHIVES });

export function runtimeSpecification(platform, architecture) {
  if (!Object.hasOwn(RUNTIME_ARCHIVES, platform)) throw new Error(`Unsupported native Motion runtime platform: ${platform}`);
  if (!Object.hasOwn(RUNTIME_ARCHIVES[platform], architecture)) throw new Error(`Unsupported Node runtime architecture: ${architecture}`);
  const selected = RUNTIME_ARCHIVES[platform][architecture];
  const archiveRoot = `node-v${NODE_VERSION}-${platform === "win32" ? "win" : "linux"}-${architecture}`;
  return { ...selected, platform, architecture, executable: platform === "win32" ? "node-runtime.exe" : "node-runtime",
    member: `${archiveRoot}/${platform === "win32" ? "node.exe" : "bin/node"}`, licenseMember: `${archiveRoot}/LICENSE`,
    extractFlag: platform === "win32" ? "-xOf" : "-xJOf" };
}

const exec = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = resolve(SCRIPT_PATH, "..", "..");
const REPOSITORY_ROOT = resolve(DESKTOP_ROOT, "..", "..");
export const sha256 = async path => createHash("sha256").update(await readFile(path)).digest("hex");

export async function prepareNodeRuntime(options = {}) {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const selected = runtimeSpecification(platform, architecture);
  const cacheRoot = resolve(options.cacheRoot ?? process.env.MOTION_NODE_RUNTIME_CACHE ?? join(REPOSITORY_ROOT, ".cache/node-runtime"));
  const output = resolve(options.output ?? process.env.MOTION_NODE_RUNTIME_OUTPUT ?? join(DESKTOP_ROOT, "dist", selected.executable));
  const archive = join(cacheRoot, selected.file);
  await mkdir(cacheRoot, { recursive: true });
  let cached = false;
  try { cached = (await stat(archive)).isFile(); } catch { cached = false; }
  if (!cached) {
    if (options.offline ?? process.env.MOTION_NODE_RUNTIME_OFFLINE === "1") throw new Error(`Pinned runtime is not in the offline cache: ${archive}`);
    const response = await fetch(selected.url, { redirect: "error" });
    if (!response.ok) throw new Error(`Official Node download failed: HTTP ${response.status}`);
    const temporaryArchive = `${archive}.download`;
    await writeFile(temporaryArchive, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
    await rename(temporaryArchive, archive);
  }
  const actual = await sha256(archive);
  if (actual !== selected.sha256) throw new Error(`Pinned runtime checksum mismatch for ${selected.file}: expected ${selected.sha256}, received ${actual}`);
  await mkdir(resolve(output, ".."), { recursive: true });
  const temporaryOutput = `${output}.tmp`;
  await rm(temporaryOutput, { force: true });
  // Windows includes bsdtar, which can read ZIP members without executing an
  // archive payload. Only the checksum-authenticated executable and licence are extracted.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const { stdout } = await exec(tar, [selected.extractFlag, archive, selected.member], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
  if (platform === "win32" && (stdout[0] !== 0x4d || stdout[1] !== 0x5a)) throw new Error("Pinned Windows runtime is not a PE executable");
  await writeFile(temporaryOutput, stdout, { mode: 0o755 });
  await chmod(temporaryOutput, 0o755);
  await rename(temporaryOutput, output);
  const licenseOutput = platform === "win32" ? join(dirname(output), "node-runtime-LICENSE") : `${output}-LICENSE`;
  const license = await exec(tar, [selected.extractFlag, archive, selected.licenseMember], { encoding: "buffer", maxBuffer: 1024 * 1024 });
  await writeFile(licenseOutput, license.stdout, { mode: 0o644 });
  return { platform, architecture, archive, output, licenseOutput, sha256: actual, source: selected.url };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  prepareNodeRuntime().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
