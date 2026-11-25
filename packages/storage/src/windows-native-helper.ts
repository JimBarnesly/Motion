import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

const MAX_WIRE_BYTES = 64 * 1024 * 1024;
const HELPER_OPERATIONS = new Set([
  "private.directory", "private.file",
  "attachment.initialize", "attachment.stage", "attachment.promote",
  "attachment.read", "attachment.discard", "attachment.recover",
  "backup.inspect", "backup.save"
]);

export interface WindowsNativeRequest { operation: string; [key: string]: unknown }
type HelperExecution = { status: number | null; signal?: string | null; error?: Error; stdout?: string | Buffer | null };
type HelperRunner = (executable: string, args: string[], options: {
  encoding: "utf8"; input: string; maxBuffer: number; timeout: number; windowsHide: boolean;
}) => HelperExecution;

const messages: Readonly<Record<string, string>> = Object.freeze({
  ENOENT: "Requested local file does not exist",
  EEXIST: "The local destination already exists",
  EACCES: "The local filesystem security check failed",
  EBUSY: "The local file is already in use",
  INVALID_INPUT: "The native filesystem request is invalid",
  IDENTITY_CHANGED: "Local file or directory identity changed",
  INTEGRITY: "Attachment integrity check failed",
  SIZE_LIMIT: "Attachment storage content exceeds 3 MiB limit",
  MOTION_DATA_ROOT_BUSY: "Motion data is already open in another desktop process"
});

function failure(code = "NATIVE_HELPER_UNAVAILABLE"): NodeJS.ErrnoException {
  const error = new Error(messages[code] ?? "The native filesystem operation could not be completed") as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function helperExecutable(value: string | undefined): string {
  if (!value || value.includes("\0")) throw failure();
  // Only a local Windows executable is accepted. No shell, PATH lookup, network
  // share, script wrapper or renderer-selected executable crosses this boundary.
  const local = value.startsWith("\\\\?\\") ? value.slice(4) : value;
  if (!/^[a-z]:[\\/]/i.test(local) || !win32.isAbsolute(local) || !/\.exe$/i.test(local)
      || win32.normalize(local) !== local.replaceAll("/", "\\")) throw failure();
  return value;
}

/** Injectable process boundary for protocol tests; production uses only the launcher-provided executable. */
export function createWindowsNativeHelperClient(options: {
  executable: () => string | undefined;
  run?: HelperRunner;
}): <T = unknown>(request: WindowsNativeRequest) => T {
  const run: HelperRunner = options.run ?? ((executable, args, spawnOptions) => spawnSync(executable, args, spawnOptions));
  return <T = unknown>(request: WindowsNativeRequest): T => {
    if (!plain(request) || !HELPER_OPERATIONS.has(request.operation)
        || (request.protocol !== undefined && request.protocol !== 1)) throw failure("INVALID_INPUT");
    let input: string;
    try { input = `${JSON.stringify({ ...request, protocol: 1 })}\n`; }
    catch { throw failure("INVALID_INPUT"); }
    if (Buffer.byteLength(input, "utf8") > MAX_WIRE_BYTES) throw failure("INVALID_INPUT");
    const executable = helperExecutable(options.executable());
    let executed: HelperExecution;
    try { executed = run(executable, ["--motion-native-helper"], { encoding: "utf8", input,
      maxBuffer: MAX_WIRE_BYTES, timeout: 30_000, windowsHide: true }); }
    catch { throw failure(); }
    if (executed.error || executed.signal) throw failure();
    const output = typeof executed.stdout === "string" ? executed.stdout : executed.stdout?.toString("utf8");
    if (!output || Buffer.byteLength(output, "utf8") > MAX_WIRE_BYTES) throw failure();
    let response: unknown;
    try { response = JSON.parse(output); } catch { throw failure(); }
    if (!plain(response) || response.protocol !== 1 || typeof response.ok !== "boolean") throw failure();
    if (response.ok === false) {
      if (Object.keys(response).some(key => !["protocol", "ok", "error"].includes(key))
          || !plain(response.error) || Object.keys(response.error).some(key => !["code", "message"].includes(key))
          || typeof response.error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(response.error.code)
          || typeof response.error.message !== "string") throw failure();
      throw failure(response.error.code);
    }
    if (executed.status !== 0 || Object.keys(response).some(key => !["protocol", "ok", "result"].includes(key))
        || !Object.prototype.hasOwnProperty.call(response, "result")) throw failure();
    return response.result as T;
  };
}

/** Synchronous, bounded IPC with the bundled Windows filesystem implementation. */
export const invokeWindowsNativeHelper = createWindowsNativeHelperClient({
  executable: () => process.platform === "win32" ? process.env.MOTION_NATIVE_HELPER : undefined
});
