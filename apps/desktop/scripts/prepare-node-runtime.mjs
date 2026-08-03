import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "24.18.0";
export const OFFICIAL_ARCHIVES = Object.freeze({
  x64: { file: `node-v${NODE_VERSION}-linux-x64.tar.xz`, url: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz", sha256: "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742" },
  arm64: { file: `node-v${NODE_VERSION}-linux-arm64.tar.xz`, url: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-arm64.tar.xz", sha256: "58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6" }
});

const exec = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = resolve(SCRIPT_PATH, "..", "..");
const REPOSITORY_ROOT = resolve(DESKTOP_ROOT, "..", "..");
export const sha256 = async path => createHash("sha256").update(await readFile(path)).digest("hex");

export async function prepareNodeRuntime(options = {}) {
  const architecture = options.architecture ?? process.arch;
  const selected = OFFICIAL_ARCHIVES[architecture];
  if (!selected) throw new Error(`Unsupported Node runtime architecture: ${architecture}`);
  const cacheRoot = resolve(options.cacheRoot ?? process.env.MOTION_NODE_RUNTIME_CACHE ?? join(REPOSITORY_ROOT, ".cache/node-runtime"));
  const output = resolve(options.output ?? process.env.MOTION_NODE_RUNTIME_OUTPUT ?? join(DESKTOP_ROOT, "dist/node-runtime"));
  const archive = join(cacheRoot, selected.file);
  await mkdir(cacheRoot, { recursive: true });
  let cached = false;
  try { cached = (await stat(archive)).isFile(); } catch {}
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
  const member = `node-v${NODE_VERSION}-linux-${architecture}/bin/node`;
  const { stdout } = await exec("tar", ["-xJOf", archive, member], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
  await writeFile(temporaryOutput, stdout, { mode: 0o755 });
  await chmod(temporaryOutput, 0o755);
  await rename(temporaryOutput, output);
  const licenseOutput = `${output}-LICENSE`;
  const license = await exec("tar", ["-xJOf", archive, `node-v${NODE_VERSION}-linux-${architecture}/LICENSE`], { encoding: "buffer", maxBuffer: 1024 * 1024 });
  await writeFile(licenseOutput, license.stdout, { mode: 0o644 });
  return { architecture, archive, output, licenseOutput, sha256: actual, source: selected.url };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  prepareNodeRuntime().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
