import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

const OPERATION = "active-webview";
const OUTPUT_LIMIT = 65_536;
const INPUT_LIMIT = 16_384;
const DEADLINE_MS = 30_000;
const CLEANUP_MS = 5_000;
const identityKeys = ["processId", "executablePath", "startTimeFileTimeUtc", "sessionId"];
const resultKeys = ["schemaVersion", "operation", "ok", "phase", "motionIdentity", "listener", "runtimeIdentity",
  "parentProcessId", "executable", "minimumVersion", "cdpProduct", "rechecked", "error"];
const phases = new Set(["input", "host", "modules", "motion", "listener", "runtime", "parent", "path", "version", "minimum", "recheck", "complete"]);
const nativeCodes = new Set(["INVALID_INPUT", "UNSUPPORTED_HOST", "UNSUPPORTED_PROBE", "PROCESS_IDENTITY_MISMATCH",
  "LISTENER_QUERY_FAILED", "LISTENER_NOT_FOUND", "LISTENER_AMBIGUOUS", "LISTENER_IDENTITY_MISMATCH",
  "RUNTIME_IDENTITY_MISMATCH", "RUNTIME_PARENT_MISMATCH", "RUNTIME_PATH_INVALID", "RUNTIME_VERSION_MISMATCH",
  "RUNTIME_TOO_OLD", "CDP_VERSION_MISMATCH", "EVIDENCE_CHANGED", "DEADLINE_EXCEEDED"]);

function fail(code, message, evidence) {
  const error = new Error(message);
  error.code = code;
  if (evidence !== undefined) error.evidence = evidence;
  throw error;
}

function requireThat(condition, message) {
  if (!condition) fail("INVALID_EVIDENCE", message);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function localPath(value) {
  return typeof value === "string" && value.length <= 4096 && /^[A-Za-z]:\\/.test(value)
    && !/[\x00-\x1f\x7f/]/.test(value) && !value.slice(2).includes(":")
    && win32.normalize(value).toLowerCase() === value.toLowerCase()
    && value.slice(3).split("\\").every(part => part.length > 0 && !/[. ]$/.test(part));
}

function versionParts(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){3}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts[0] > 0 && parts.every(part => part <= 65535) ? parts : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 4; index += 1) {
    if (left[index] !== right[index]) return Math.sign(left[index] - right[index]);
  }
  return 0;
}

function validIdentity(identity, basename) {
  return exactKeys(identity, identityKeys)
    && Number.isInteger(identity.processId) && identity.processId > 0 && identity.processId <= 2147483647
    && Number.isInteger(identity.sessionId) && identity.sessionId >= 0 && identity.sessionId <= 2147483647
    && localPath(identity.executablePath) && win32.basename(identity.executablePath).toLowerCase() === basename
    && typeof identity.startTimeFileTimeUtc === "string" && /^[1-9]\d{14,18}$/.test(identity.startTimeFileTimeUtc)
    && BigInt(identity.startTimeFileTimeUtc) <= 9223372036854775807n;
}

function sameIdentity(left, right) {
  return left.processId === right.processId && left.sessionId === right.sessionId
    && left.startTimeFileTimeUtc === right.startTimeFileTimeUtc
    && left.executablePath.toLowerCase() === right.executablePath.toLowerCase();
}

/** Build the same strict request used by the native probe; no execution hooks. */
export function createActiveWebViewRequest(options) {
  const expected = ["motionIdentity", "debugPort", "minimumVersion", ...(Object.hasOwn(options ?? {}, "cdpProduct") ? ["cdpProduct"] : [])];
  if (!exactKeys(options, expected) || !validIdentity(options.motionIdentity, "motion-desktop.exe")
    || !Number.isInteger(options.debugPort) || options.debugPort < 1 || options.debugPort > 65535
    || !versionParts(options.minimumVersion)) fail("INVALID_INPUT", "Invalid active WebView2 probe request.");
  const cdpProduct = options.cdpProduct ?? null;
  if (cdpProduct !== null && (typeof cdpProduct !== "string" || cdpProduct.length === 0 || cdpProduct.length > 256
    || /[\x00-\x1f\x7f]/.test(cdpProduct) || (cdpProduct.startsWith("Edg/") && !versionParts(cdpProduct.slice(4))))) {
    fail("INVALID_INPUT", "Invalid raw CDP product observation.");
  }
  const request = { schemaVersion: 1, operation: OPERATION, motionIdentity: { ...options.motionIdentity },
    debugPort: options.debugPort, minimumVersion: options.minimumVersion, cdpProduct };
  if (Buffer.byteLength(JSON.stringify(request)) + 1 > INPUT_LIMIT) fail("INVALID_INPUT", "Active WebView2 probe request exceeded its bound.");
  return request;
}

/** Validate native evidence independently; fabricated fixtures are not OS proof. */
export function validateActiveWebViewEvidence(value, options) {
  const request = createActiveWebViewRequest(options);
  requireThat(exactKeys(value, resultKeys) && value.schemaVersion === 1 && value.operation === OPERATION
    && typeof value.ok === "boolean" && phases.has(value.phase), "Malformed active WebView2 probe evidence.");
  requireThat(value.minimumVersion === request.minimumVersion && value.cdpProduct === request.cdpProduct,
    "The native probe did not preserve the requested version observations.");
  requireThat(typeof value.rechecked === "boolean", "Missing active WebView2 recheck result.");
  if (!value.ok) {
    requireThat(value.phase !== "complete" && exactKeys(value.error, ["code", "exceptionType", "hresult"])
      && nativeCodes.has(value.error.code) && typeof value.error.exceptionType === "string"
      && /^[A-Za-z0-9_.+`]{1,160}$/.test(value.error.exceptionType) && /^[0-9A-F]{8}$/.test(value.error.hresult),
    "Malformed active WebView2 failure evidence.");
    // Only retain bounded, explicitly shaped observations on failure as well.
    validateObservations(value, request, false);
    fail(value.error.code, `Active WebView2 probe failed during ${value.phase}: ${value.error.code}.`, value);
  }
  requireThat(value.phase === "complete" && value.error === null && value.rechecked === true,
    "Active WebView2 success was not completely rechecked.");
  validateObservations(value, request, true);
  requireThat(compareVersions(versionParts(value.executable.fileVersion), versionParts(request.minimumVersion)) >= 0,
    "The active WebView2 runtime is below the required version.");
  if (request.cdpProduct?.startsWith("Edg/")) {
    requireThat(request.cdpProduct.slice(4) === value.executable.fileVersion, "The Edge CDP product and native executable version disagree.");
  }
  return value;
}

function validateObservations(value, request, complete) {
  if (complete || value.motionIdentity !== null) {
    requireThat(validIdentity(value.motionIdentity, "motion-desktop.exe") && sameIdentity(value.motionIdentity, request.motionIdentity),
      "The Motion process identity does not match the authenticated request.");
  }
  if (complete || value.listener !== null) {
    const listener = value.listener;
    requireThat(exactKeys(listener, ["port", "addresses", "owningProcessId"]) && listener.port === request.debugPort
      && Number.isInteger(listener.owningProcessId) && listener.owningProcessId > 0 && listener.owningProcessId <= 2147483647
      && Array.isArray(listener.addresses) && [1, 2].includes(listener.addresses.length)
      && listener.addresses[0] === "127.0.0.1" && (listener.addresses.length === 1 || listener.addresses[1] === "::1"),
    "The debugging listener is not the exact unique loopback endpoint.");
  }
  if (complete || value.runtimeIdentity !== null) {
    requireThat(validIdentity(value.runtimeIdentity, "msedgewebview2.exe") && value.listener !== null
      && value.runtimeIdentity.processId === value.listener.owningProcessId && value.runtimeIdentity.processId !== request.motionIdentity.processId
      && value.runtimeIdentity.sessionId === request.motionIdentity.sessionId
      && BigInt(value.runtimeIdentity.startTimeFileTimeUtc) >= BigInt(request.motionIdentity.startTimeFileTimeUtc),
    "The selected WebView2 process identity is inconsistent.");
  }
  if (complete || value.parentProcessId !== null) {
    requireThat(value.runtimeIdentity !== null && value.parentProcessId === request.motionIdentity.processId,
      "The runtime is not a direct child of the authenticated Motion process.");
  }
  if (complete || value.executable !== null) {
    const file = value.executable;
    requireThat(exactKeys(file, ["path", "knownLocation", "applicationRoot", "directoryVersion", "moduleVersion", "fileVersion", "productVersion", "byteLength", "sha256"])
      && value.runtimeIdentity !== null && localPath(file.path) && localPath(file.applicationRoot)
      && file.path.toLowerCase() === value.runtimeIdentity.executablePath.toLowerCase()
      && ["ProgramFilesX86", "ProgramFiles", "LocalApplicationData"].includes(file.knownLocation)
      && file.applicationRoot.toLowerCase().endsWith("\\microsoft\\edgewebview\\application")
      && versionParts(file.fileVersion) !== null && file.directoryVersion === file.fileVersion
      && file.moduleVersion === file.fileVersion && file.productVersion === file.fileVersion
      && file.path.toLowerCase() === win32.join(file.applicationRoot, file.fileVersion, "msedgewebview2.exe").toLowerCase()
      && Number.isInteger(file.byteLength) && file.byteLength > 0 && file.byteLength <= 67_108_864
      && typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256),
    "The active runtime path, versions, or executable hash are inconsistent.");
  }
}

/**
 * Inspect an already running, authenticated Motion instance. This is CI-only
 * instrumentation, not a registry fallback or loaded-image security boundary.
 * Rejections expose error.code and bounded error.evidence for real negative
 * controls (wrong port, stale Motion FILETIME, or a deliberately high minimum).
 */
export async function probeActiveWebView(options) {
  const request = createActiveWebViewRequest(options);
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.arch !== "x64") {
    fail("UNSUPPORTED_HOST", "Active WebView2 acceptance requires a disposable Windows x64 CI runner.");
  }
  if (!localPath(process.env.SystemRoot)) fail("UNSUPPORTED_HOST", "A normalized Windows system directory is required.");
  const powershellRoot = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  const native = await runProbe(win32.join(powershellRoot, "powershell.exe"), {
    ...environment, PSModulePath: win32.join(powershellRoot, "Modules")
  }, `${JSON.stringify(request)}\n`);
  let value;
  try {
    requireThat(/^\{[^\r\n]*\}\r?\n$/.test(native.stdout), "Expected one bounded native evidence record.");
    value = JSON.parse(native.stdout);
    requireThat(native.signal === null && native.code === (value.ok === true ? 0 : 1), "Native evidence and process exit disagree.");
  } catch (error) {
    if (error.code === "INVALID_EVIDENCE") throw error;
    fail("INVALID_EVIDENCE", "The native probe did not return valid JSON evidence.");
  }
  return validateActiveWebViewEvidence(value, options);
}

function runProbe(powershell, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Mta", "-File",
      fileURLToPath(new URL("./windows-active-webview-probe.ps1", import.meta.url))], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env
    });
    let stdout = "", outputBytes = 0, failure, cleanupTimer, settled = false;
    const stop = (code, message) => {
      if (failure || settled) return;
      failure = Object.assign(new Error(message), { code });
      try { child.kill("SIGKILL"); } catch { /* The close/error event still determines completion. */ }
      cleanupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        reject(Object.assign(new Error("The active WebView2 probe did not terminate within its cleanup deadline."), { code: "CLEANUP_FAILED" }));
      }, CLEANUP_MS);
    };
    const timer = setTimeout(() => stop("DEADLINE_EXCEEDED", "The active WebView2 probe exceeded its wall-clock deadline."), DEADLINE_MS);
    child.on("error", () => stop("PROBE_PROCESS_FAILED", "The active WebView2 probe process could not run."));
    child.stdin.on("error", () => stop("PROBE_PROCESS_FAILED", "The active WebView2 probe did not consume its request."));
    child.stdout.setEncoding("utf8").on("data", chunk => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > OUTPUT_LIMIT) stop("OUTPUT_LIMIT", "The active WebView2 probe exceeded its output bound.");
      else if (!failure) stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > OUTPUT_LIMIT) stop("OUTPUT_LIMIT", "The active WebView2 probe exceeded its output bound.");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(cleanupTimer);
      if (settled) return;
      settled = true;
      if (failure) reject(failure); else resolve({ stdout, code, signal });
    });
    child.stdin.end(input);
  });
}
