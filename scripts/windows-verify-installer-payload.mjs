import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const MAX_MEMBERS = 256;
const DIGEST = /^[a-f0-9]{64}$/;
const memberKeys = new Set(["Path", "Size", "Packed Size", "Modified", "Attributes", "Method", "Solid", "Offset", "Folder", "Encrypted"]);

function requireValue(condition, message) { if (!condition) throw new Error(message); }

export function validatePin(pin) {
  requireValue(pin?.schemaVersion === 1 && /^\d{4}-\d{2}-\d{2}$/.test(pin.reviewedAt), "Invalid payload pin schema");
  const payload = pin.payload, extractor = pin.extractor;
  requireValue(payload?.member === "$TEMP/MicrosoftEdgeWebView2RuntimeInstaller.exe"
    && Number.isSafeInteger(payload.byteLength) && payload.byteLength > 0 && payload.byteLength < MAX_INSTALLER_BYTES
    && DIGEST.test(payload.sha256) && DIGEST.test(payload.signerCertificateSha256)
    && /^\d+\.\d+\.\d+\.\d+$/.test(payload.wrapperVersion)
    && /^\d+\.\d+\.\d+\.\d+$/.test(payload.containedRuntimeVersion)
    && payload.wrapperArchitecture === "x86" && payload.containedRuntimeArchitecture === "x64"
    && /^https:\/\/msedge\.sf\.dl\.delivery\.mp\.microsoft\.com\/filestreamingservice\/files\/[a-f0-9-]+\/MicrosoftEdgeWebView2RuntimeInstallerX64\.exe$/.test(payload.officialUrl), "Invalid Evergreen payload pin");
  requireValue(extractor?.architecture === "x64" && /^\d{2}\.\d{2}$/.test(extractor.version)
    && DIGEST.test(extractor.officialAsset?.sha256) && Number.isSafeInteger(extractor.officialAsset?.byteLength)
    && extractor.officialAsset.byteLength > 0 && extractor.officialAsset.byteLength < 16 * 1024 * 1024
    && extractor.officialAsset.url === `https://github.com/ip7z/7zip/releases/download/${extractor.version}/7z${extractor.version.replace(".", "")}-x64.exe`
    && Array.isArray(extractor.files) && extractor.files.length === 2, "Invalid extraction-tool provenance");
  requireValue(extractor.files.map(file => file.name).sort().join(",") === "7z.dll,7z.exe"
    && extractor.files.every(file => Number.isSafeInteger(file.byteLength) && file.byteLength > 0
      && file.byteLength < 4 * 1024 * 1024 && DIGEST.test(file.sha256)), "Invalid extraction-tool file pin");
  requireValue(Array.isArray(pin.allowedWindowsSdks) && pin.allowedWindowsSdks.length > 0
    && pin.allowedWindowsSdks.length <= 8 && pin.allowedWindowsSdks.every(value => /^10\.0\.\d+\.0$/.test(value))
    && new Set(pin.allowedWindowsSdks).size === pin.allowedWindowsSdks.length, "Invalid Windows SDK allowlist");
  return pin;
}

export function requirePinnedMeasurement(actual, expected, label) {
  requireValue(actual.byteLength === expected.byteLength && actual.sha256 === expected.sha256, `${label} does not match its reviewed bytes`);
}

function fields(text, allowed) {
  const result = Object.create(null);
  for (const line of text.split("\n")) {
    const match = /^([^=\r\n]+) = (.*)$/.exec(line);
    requireValue(match && (!allowed || allowed.has(match[1])) && !Object.hasOwn(result, match[1]), "Malformed or ambiguous archive listing field");
    result[match[1]] = match[2];
  }
  return result;
}

export function validateNsisListing(listing, payload, installerBytes, extractorVersion) {
  requireValue(typeof listing === "string" && Buffer.byteLength(listing) <= MAX_TOOL_OUTPUT_BYTES
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(listing), "Invalid or oversized archive listing");
  const text = listing.replaceAll("\r\n", "\n");
  requireValue(!text.includes("\r"), "Malformed archive line endings");
  const parts = text.split("\n----------\n");
  requireValue(parts.length === 2 && parts[0].includes(`7-Zip ${extractorVersion} (x64)`), "Unexpected extraction-tool or archive listing format");
  const headers = parts[0].split("\n--\n");
  requireValue(headers.length === 2, "Missing unique archive header");
  const header = fields(headers[1].trim());
  requireValue(header.Type === "Nsis" && /^\d+$/.test(header["Physical Size"])
    && Number(header["Physical Size"]) === installerBytes, "Listing does not describe the complete NSIS candidate");
  const records = parts[1].trim().split(/\n\n+/);
  requireValue(records.length > 0 && records.length <= MAX_MEMBERS, "Invalid archive member count");
  const seen = new Set(), candidates = [];
  let declaredBytes = 0;
  for (const record of records) {
    const entry = fields(record, memberKeys);
    const path = entry.Path?.replaceAll("\\", "/");
    requireValue(typeof path === "string" && path.length > 0 && path.length < 1024
      && !path.startsWith("/") && !/[\x00-\x1f\x7f:<>"|?*]/.test(path)
      && path.split("/").every(part => part && part !== "." && part !== ".." && !/[. ]$/.test(part))
      && !seen.has(path.toLowerCase()), "Unsafe, duplicate or ambiguous archive member path");
    seen.add(path.toLowerCase());
    requireValue(["Size", "Packed Size", "Modified", "Attributes", "Method", "Solid", "Offset"].every(key => Object.hasOwn(entry, key))
      && (/^\d+$/.test(entry.Size) || (path === "uninstall.exe" && entry.Size === ""))
      && (entry["Packed Size"] === "" || /^\d+$/.test(entry["Packed Size"]))
      && /^\d+$/.test(entry.Offset) && Number(entry.Offset) <= MAX_INSTALLER_BYTES,
    "Incomplete or malformed archive member metadata");
    declaredBytes += Number(entry.Size);
    requireValue(Number.isSafeInteger(declaredBytes) && declaredBytes <= MAX_INSTALLER_BYTES, "Archive declared bytes exceed the inspection bound");
    if (path.split("/").at(-1).toLowerCase() !== "microsoftedgewebview2runtimeinstaller.exe") continue;
    requireValue(path === payload.member && /^\d+$/.test(entry.Size)
      && Number(entry.Size) === payload.byteLength
      && [undefined, "-"].includes(entry.Folder) && [undefined, "-"].includes(entry.Encrypted)
      && !/[DL]/i.test(entry.Attributes ?? ""), "Unexpected WebView payload location, type or size");
    candidates.push(entry.Path);
  }
  requireValue(candidates.length === 1, "The installer must contain exactly one reviewed WebView payload");
  return { member: candidates[0], memberCount: records.length };
}

export function validateAuthenticode(signature, { signerCertificateSha256, wrapperVersion, sdkTool = false } = {}) {
  requireValue(signature?.schemaVersion === 1 && signature.status === "Valid"
    && signature.signatureType === "Authenticode" && DIGEST.test(signature.signer?.derSha256)
    && /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/.test(signature.signer.subject), "Windows did not validate an embedded Microsoft signature");
  if (sdkTool) {
    requireValue(typeof signature.originalFilename === "string" && signature.originalFilename.toLowerCase() === "signtool.exe",
      "The approved SDK path does not contain SignTool");
  } else {
    requireValue(signature.signer.derSha256 === signerCertificateSha256, "Unexpected Evergreen signing certificate");
    requireValue(DIGEST.test(signature.timestampSigner?.derSha256), "The Evergreen signature lacks its timestamp certificate");
    requireValue(signature.fileVersion === wrapperVersion, "Unexpected Evergreen wrapper version");
  }
  return signature;
}

export async function measureFile(path, maxBytes, collect = false) {
  const before = await lstat(path, { bigint: true });
  requireValue(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= BigInt(maxBytes), "Expected a bounded regular file");
  const file = await open(path, "r");
  try {
    const opened = await file.stat({ bigint: true });
    requireValue(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, "File identity changed before inspection");
    const hash = createHash("sha256"), chunks = [], buffer = Buffer.alloc(64 * 1024);
    let byteLength = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      byteLength += bytesRead;
      requireValue(byteLength <= maxBytes, "File exceeded its byte limit during inspection");
      hash.update(buffer.subarray(0, bytesRead));
      if (collect) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    requireValue(after.size === before.size && BigInt(byteLength) === before.size && after.mtimeNs === before.mtimeNs
      && current.dev === before.dev && current.ino === before.ino && !current.isSymbolicLink(), "File changed during inspection");
    return { byteLength, sha256: hash.digest("hex"), ...(collect ? { bytes: Buffer.concat(chunks, byteLength) } : {}) };
  } finally { await file.close(); }
}

async function checkExtractedDirectory(directory, expected) {
  const entries = await readdir(directory, { withFileTypes: true });
  requireValue(entries.length <= 1 && entries.every(entry => entry.name === expected && entry.isFile() && !entry.isSymbolicLink()), "Unexpected extracted file or directory");
  return entries.length;
}

export async function runVerificationTool(executable, args, { cwd, env, timeout = 60_000, monitor } = {}) {
  return new Promise((resolveTool, rejectTool) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, failure, polling = false, stopped = false;
    const abort = error => {
      if (failure) return;
      failure = error;
      child.kill();
    };
    const receive = (chunk, diagnostic) => {
      bytes += chunk.length;
      if (bytes > MAX_TOOL_OUTPUT_BYTES) { abort(new Error("Verification tool exceeded its output limit")); return; }
      if (diagnostic) stderr += chunk.toString("utf8"); else stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => receive(chunk, false));
    child.stderr.on("data", chunk => receive(chunk, true));
    child.once("error", error => { failure ??= error; });
    const timer = setTimeout(() => abort(new Error("Verification tool timed out")), timeout);
    const hardDeadline = setTimeout(() => {
      stopped = true;
      child.kill();
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      clearTimeout(timer);
      clearInterval(watcher);
      rejectTool(Object.assign(new Error("Verification tool termination could not be confirmed"), { terminationUnconfirmed: true }));
    }, timeout + 5000);
    const watcher = setInterval(async () => {
      if (!monitor || polling || stopped || failure) return;
      polling = true;
      try { await monitor(); } catch (error) { if (!stopped) abort(error); }
      finally { polling = false; }
    }, 100);
    child.once("close", (code, signal) => {
      stopped = true;
      clearTimeout(timer); clearTimeout(hardDeadline); clearInterval(watcher);
      if (failure) rejectTool(failure);
      else if (code !== 0 || signal !== null) rejectTool(Object.assign(new Error(`Verification tool failed with exit ${code}`), { toolExit: code, stdout, stderr }));
      else resolveTool({ exitCode: code, stdout, stderr });
    });
  });
}
const runTool = runVerificationTool;

function localWindowsPath(value, label) {
  requireValue(typeof value === "string" && /^[a-z]:\\/i.test(value) && !value.includes("\0")
    && win32.normalize(value) === value, `${label} must be an unambiguous absolute local Windows path`);
  return value;
}

export async function verifyInstallerPayload({ installer, output }) {
  requireValue(process.platform === "win32", "Installer payload verification requires actual Windows");
  localWindowsPath(installer, "Installer"); localWindowsPath(output, "Evidence output");
  requireValue(installer !== output, "Evidence cannot overwrite the installer");
  const pinBytes = await readFile(join(SCRIPT_ROOT, "windows-installer-payload-pin.json"));
  const pin = validatePin(JSON.parse(pinBytes.toString("utf8")));
  await mkdir(dirname(output), { recursive: true });
  const report = { schemaVersion: 1, commit: process.env.GITHUB_SHA ?? null, pinSha256: createHash("sha256").update(pinBytes).digest("hex"), status: "failed", phase: "preflight",
    scope: pin.scope, cleanup: { passed: false } };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  let ownedTemp, failure;
  try {
    const systemRoot = localWindowsPath(process.env.SystemRoot, "SystemRoot");
    const programFiles = localWindowsPath(process.env.ProgramFiles, "ProgramFiles");
    const programFilesX86 = localWindowsPath(process.env["ProgramFiles(x86)"], "ProgramFiles(x86)");
    const temporaryRoot = localWindowsPath(process.env.RUNNER_TEMP, "RUNNER_TEMP");
    const powershellRoot = join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
    const powershell = join(powershellRoot, "powershell.exe");
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["PATH", "PSMODULEPATH"].includes(key.toUpperCase())));
    environment.PATH = join(systemRoot, "System32");
    environment.PSModulePath = join(powershellRoot, "Modules");
    ownedTemp = await mkdtemp(join(temporaryRoot, "motion-installer-verification-"));
    const toolsDirectory = join(ownedTemp, "tools"), extractionDirectory = join(ownedTemp, "payload");
    await mkdir(toolsDirectory); await mkdir(extractionDirectory);

    report.phase = "extractor-provenance";
    const verifiedFiles = [];
    for (const expected of pin.extractor.files) {
      const measured = await measureFile(join(programFiles, "7-Zip", expected.name), expected.byteLength, true);
      requirePinnedMeasurement(measured, expected, "Installed extraction tool");
      await writeFile(join(toolsDirectory, expected.name), measured.bytes, { flag: "wx" });
      verifiedFiles.push({ name: expected.name, byteLength: measured.byteLength, sha256: measured.sha256 });
    }
    // The tool directory contains only these two authenticated files. Optional
    // Codecs/Formats plugins from the installed 7-Zip tree are never copied.
    assert.deepEqual((await readdir(toolsDirectory)).sort(), ["7z.dll", "7z.exe"]);
    report.extractor = { version: pin.extractor.version, officialAsset: pin.extractor.officialAsset, verifiedFiles,
      optionalPluginDirectories: "absent", workingDirectory: "owned tool directory", pathSearch: "System32 only" };
    const extractor = join(toolsDirectory, "7z.exe");

    report.phase = "nsis-inventory";
    const outer = await measureFile(installer, MAX_INSTALLER_BYTES);
    report.installer = { name: win32.basename(installer), ...outer };
    const listing = await runTool(extractor, ["l", "-slt", "-tNsis", "-sccUTF-8", "--", installer], { cwd: toolsDirectory, env: environment });
    await writeFile(`${output}.listing.txt`, listing.stdout, { flag: "wx" });
    const inventory = validateNsisListing(listing.stdout, pin.payload, outer.byteLength, pin.extractor.version);
    report.inventory = { memberCount: inventory.memberCount, expectedPayloadCount: 1 };

    report.phase = "payload-extraction";
    const payloadName = win32.basename(pin.payload.member.replaceAll("/", "\\"));
    const payloadPath = join(extractionDirectory, payloadName);
    const extraction = await runTool(extractor, ["e", "-tNsis", "-spd", "-y", "-bd", "-bb0", "-sccUTF-8",
      `-o${extractionDirectory}`, "--", installer, inventory.member], { cwd: toolsDirectory, env: environment,
      monitor: async () => {
        if (await checkExtractedDirectory(extractionDirectory, payloadName)) {
          const size = (await lstat(payloadPath)).size;
          requireValue(size <= pin.payload.byteLength, "Extraction exceeded the reviewed payload byte limit");
        }
      } });
    await writeFile(`${output}.extraction.txt`, extraction.stdout, { flag: "wx" });
    requireValue(await checkExtractedDirectory(extractionDirectory, payloadName) === 1, "The exact payload was not extracted");
    const payload = await measureFile(payloadPath, pin.payload.byteLength);
    requirePinnedMeasurement(payload, pin.payload, "Embedded Evergreen payload");
    report.payload = { member: pin.payload.member, ...payload, wrapperVersion: pin.payload.wrapperVersion,
      containedRuntimeVersion: pin.payload.containedRuntimeVersion, runtimeVersionSource: "Reviewed content of the exact pinned wrapper",
      officialUrl: pin.payload.officialUrl };

    const probe = async path => {
      const result = await runTool(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
        join(SCRIPT_ROOT, "windows-authenticode-probe.ps1"), "-LiteralPath", path], { cwd: toolsDirectory, env: environment });
      return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
    };
    report.phase = "sdk-tool-authentication";
    let signtool;
    for (const version of pin.allowedWindowsSdks) {
      const candidate = join(programFilesX86, "Windows Kits", "10", "bin", version, "x64", "signtool.exe");
      try {
        const metadata = await lstat(candidate);
        requireValue(metadata.isFile() && !metadata.isSymbolicLink(), "SDK SignTool must be a regular installed file");
        signtool = candidate; break;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    requireValue(signtool, "An approved installed Windows SDK SignTool was not found");
    const sdkSignature = validateAuthenticode(await probe(signtool), { sdkTool: true });
    const sdkMeasurement = await measureFile(signtool, 16 * 1024 * 1024);
    report.windowsTrust = { signtool: { path: signtool, ...sdkMeasurement, signature: sdkSignature } };

    report.phase = "windows-authenticode";
    const verified = await runTool(signtool, ["verify", "/pa", "/all", "/tw", "/v", payloadPath], { cwd: toolsDirectory, env: environment });
    await writeFile(`${output}.signtool.txt`, `${verified.stdout}\n${verified.stderr}`, { flag: "wx" });
    report.windowsTrust.signtool.exitCode = verified.exitCode;
    report.windowsTrust.signtool.arguments = ["verify", "/pa", "/all", "/tw", "/v"];
    report.windowsTrust.payloadSignature = validateAuthenticode(await probe(payloadPath), pin.payload);
    requirePinnedMeasurement(await measureFile(payloadPath, pin.payload.byteLength), pin.payload, "Verified Evergreen payload");
    requirePinnedMeasurement(await measureFile(installer, MAX_INSTALLER_BYTES), outer, "Outer installer after inspection");
    report.phase = "cleanup";
  } catch (error) {
    failure = error;
    report.failure = { message: String(error.message).slice(0, 2000), ...(Number.isInteger(error.toolExit) ? { toolExit: error.toolExit } : {}),
      ...(error.terminationUnconfirmed ? { terminationUnconfirmed: true } : {}) };
    if (error.stdout || error.stderr) await writeFile(`${output}.failed-tool.txt`, `${error.stdout ?? ""}\n${error.stderr ?? ""}`, { flag: "wx" });
  } finally {
    try {
      if (ownedTemp) await rm(ownedTemp, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
      report.cleanup.passed = true;
    } catch (error) {
      report.cleanup.failure = String(error.message).slice(0, 1000);
      failure ??= error;
    }
    if (!failure && report.cleanup.passed) { report.status = "passed"; report.phase = "complete"; }
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw new Error(`Installer payload verification failed in ${report.phase}: ${report.failure?.message ?? "owned temporary files could not be removed"}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    requireValue(args.length === 4 && args[0] === "--installer" && args[2] === "--output"
      && isAbsolute(args[1]) && isAbsolute(args[3]), "Usage: --installer <absolute NSIS file> --output <fresh absolute evidence.json>");
    const result = await verifyInstallerPayload({ installer: args[1], output: args[3] });
    console.log(`Verified embedded Evergreen ${result.payload.containedRuntimeVersion}: ${result.payload.sha256}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
