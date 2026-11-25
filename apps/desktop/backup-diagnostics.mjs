import { createHash } from "node:crypto";
import { resolve, win32 } from "node:path";

const nativeCodes = new Set(["ENOENT", "EEXIST", "EACCES", "EBUSY", "INVALID_INPUT",
  "IDENTITY_CHANGED", "INTEGRITY", "SIZE_LIMIT", "MOTION_DATA_ROOT_BUSY", "NATIVE_HELPER_UNAVAILABLE", "STORAGE_FAILURE"]);
const errorTypes = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "MotionAppError"]);
const hash = value => createHash("sha256").update(value).digest("hex");

// Failure-only acceptance instrumentation. It observes the unchanged refusal;
// it never retries an operation, changes a destination, or authorizes a write.
// Both explicit CI gates are required because even path fingerprints belong
// only in the disposable fixture's evidence, not ordinary application logs.
export function recordBackupInspectionFailure(error, destination) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.MOTION_ACCEPTANCE_TRACE_BACKUP !== "1") return;
  try {
    if (typeof destination !== "string" || destination.length > 32767) return;
    const normalized = win32.normalize(destination).toLowerCase();
    const resolvedNativePath = win32.normalize(resolve(destination)).toLowerCase();
    const shape = /^[A-Za-z]:\\/.test(destination) ? "drive"
      : /^\\\\\?\\[A-Za-z]:\\/.test(destination) ? "verbatim-drive"
        : /^\\\\\?\\Volume\{[a-fA-F0-9-]+\}\\/.test(destination) ? "volume-guid"
          : destination.startsWith("\\\\") ? "network-or-device" : "other";
    process.stderr.write(`${JSON.stringify({ schemaVersion: 1, event: "native-backup-inspection-rejected",
      nativeCode: nativeCodes.has(error?.code) ? error.code : "UNCLASSIFIED",
      errorType: errorTypes.has(error?.name) ? error.name : "Unknown",
      destinationShape: shape, destinationLength: destination.length,
      normalizedPathSha256: hash(normalized), normalizedParentSha256: hash(win32.dirname(normalized)),
      resolvedNativePathSha256: hash(resolvedNativePath) })}\n`);
  } catch {
    // Diagnostic preparation cannot replace the original storage refusal.
  }
}
