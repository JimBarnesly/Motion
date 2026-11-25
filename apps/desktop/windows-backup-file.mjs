import { resolve } from "node:path";
import { invokeWindowsNativeHelper } from "@motion/storage";

export function inspectWindowsPrivateFile(destination, invoke = invokeWindowsNativeHelper) {
  const result = invoke({ operation: "backup.inspect", path: resolve(destination) });
  if (result?.exists === false && Object.keys(result).length === 1) return result;
  if (result?.exists !== true || typeof result.contents !== "string"
      || typeof result.identity !== "string" || !/^[a-f0-9]{64}$/.test(result.identity)
      || Object.keys(result).some(key => !["exists", "contents", "identity"].includes(key))) {
    throw new Error("Windows backup inspection could not be authenticated");
  }
  return result;
}

export function writeWindowsPrivateFile(destination, contents, expectedIdentity, invoke = invokeWindowsNativeHelper) {
  if (typeof contents !== "string" || (expectedIdentity !== undefined
      && (typeof expectedIdentity !== "string" || !/^[a-f0-9]{64}$/.test(expectedIdentity)))) {
    throw new Error("Invalid private Windows file publication");
  }
  const byteLength = Buffer.byteLength(contents, "utf8");
  const result = invoke({ operation: "backup.save", path: resolve(destination), contents,
    ...(expectedIdentity === undefined ? {} : { expectedIdentity }) });
  if (result?.byteLength !== byteLength || Object.keys(result).some(key => key !== "byteLength")) {
    throw new Error("Windows file publication could not be authenticated");
  }
  return { path: destination, byteLength };
}

function authenticateContents(result, verify) {
  if (!result.exists || !verify(Buffer.from(result.contents, "utf8")).valid) {
    throw new Error("Existing backup is not valid and will not be replaced");
  }
}

export function inspectWindowsBackupDestination(destination, verify) {
  const result = inspectWindowsPrivateFile(destination);
  if (!result.exists) return { exists: false, replacement: false };
  authenticateContents(result, verify);
  // This token stays on the native dialog/service channel. The host retains it
  // across confirmation so a later save cannot approve a different snapshot.
  return { exists: true, replacement: true, replacementIdentity: result.identity };
}

export function readAndVerifyWindowsBackupFile(destination, verify) {
  try {
    const result = inspectWindowsPrivateFile(destination);
    return result.exists ? verify(Buffer.from(result.contents, "utf8"))
      : { valid: false, errors: ["Backup could not be authenticated"] };
  } catch { return { valid: false, errors: ["Backup could not be authenticated"] }; }
}

export async function createWindowsBackupFile(destination, bytes, verify, options) {
  // POSIX filesystem-injection hooks cannot replace native handle operations.
  // Reject them explicitly so a test or caller cannot silently bypass a check.
  if (Object.keys(options).some(key => !["confirmReplace", "verify", "expectedIdentity"].includes(key))) {
    throw new Error("Unsupported Windows backup writer option");
  }
  const hasConfirmedIdentity = Object.hasOwn(options, "expectedIdentity");
  if (hasConfirmedIdentity && (typeof options.expectedIdentity !== "string"
      || !/^[a-f0-9]{64}$/.test(options.expectedIdentity))) {
    throw new Error("Invalid confirmed Windows backup identity");
  }
  const existing = inspectWindowsPrivateFile(destination);
  if (hasConfirmedIdentity && (!existing.exists || existing.identity !== options.expectedIdentity)) {
    throw new Error("Existing backup changed after native confirmation");
  }
  if (existing.exists) {
    if (typeof options.confirmReplace !== "function") throw new Error("Backup destination already exists");
    authenticateContents(existing, verify);
    if (await options.confirmReplace({ path: destination }) !== true) return { cancelled: true, path: destination };
  }
  if (options.verify && !(await options.verify(bytes)).valid) throw new Error("Backup failed canonical verification");
  // serializeBackup has verified the canonical bundle before entering here.
  // The helper owns every file handle, flushes, and compares the persisted bytes
  // with this exact payload before publishing. It never trusts rendered HTML.
  const expectedIdentity = hasConfirmedIdentity ? options.expectedIdentity : existing.exists ? existing.identity : undefined;
  return writeWindowsPrivateFile(destination, bytes.toString("utf8"), expectedIdentity);
}
