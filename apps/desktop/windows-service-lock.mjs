import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve, win32 } from "node:path";

const ACQUIRE_TIMEOUT_MS = 10_000;
const RELEASE_TIMEOUT_MS = 1_000;
const MAX_REPLY_BYTES = 8_192;

function helperExecutable() {
  const executable = process.env.MOTION_NATIVE_HELPER;
  if (typeof executable !== "string" || !isAbsolute(executable) || !/\.exe$/i.test(executable)
      || executable.includes("\0")) throw new Error("Windows native ownership helper is unavailable");
  const local = executable.startsWith("\\\\?\\") ? executable.slice(4) : executable;
  if (!/^[a-z]:[\\/]/i.test(local) || win32.normalize(local) !== local.replaceAll("/", "\\")) {
    throw new Error("Windows native ownership helper must be a local executable");
  }
  const metadata = lstatSync(executable);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Windows native ownership helper is unavailable");
  return executable;
}

async function stopGuardian(guardian) {
  if (!guardian.pid) return;
  if (guardian.exitCode !== null || guardian.signalCode !== null) return;
  const exited = new Promise(resolve => guardian.once("exit", resolve));
  guardian.stdin.end();
  let timer;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), RELEASE_TIMEOUT_MS); })
  ]);
  clearTimeout(timer);
  if (!graceful && guardian.exitCode === null && guardian.signalCode === null) {
    guardian.kill("SIGKILL");
    await exited;
  }
}

// The native process pins every directory component and duplicates the exact
// writer/storage handles into its authenticated Node parent. Guardian death
// cannot release them while synchronous Node work is still running. Normal pipe
// EOF closes the duplicates; Node termination releases its own handle table.
// A pathname or a PID file is never used as the Windows ownership authority.
export async function acquireWindowsServiceLock(dataRoot) {
  if (process.platform !== "win32") throw new Error("Windows ownership is unavailable on this platform");
  const guardian = spawn(helperExecutable(), ["--motion-root-guard", resolve(dataRoot)], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false
  });
  let stopping = false;
  let ready = false;
  const died = () => { if (!stopping && ready) process.exit(74); };
  guardian.once("exit", died);
  guardian.once("error", died);
  // Keep stderr drained without copying native diagnostics or local paths into
  // the renderer-facing error response.
  guardian.stderr.resume();
  guardian.stdin.on("error", died);
  try {
    const result = await new Promise((resolveReady, rejectReady) => {
      let bytes = Buffer.alloc(0);
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        guardian.removeListener("error", onError);
        guardian.removeListener("exit", onExit);
        if (error) rejectReady(error); else resolveReady(value);
      };
      const onError = () => finish(new Error("Windows ownership helper could not start"));
      const onExit = () => finish(new Error("Motion data is already open or its ownership could not be authenticated"));
      const timer = setTimeout(() => finish(new Error("Windows ownership helper did not become ready")), ACQUIRE_TIMEOUT_MS);
      guardian.once("error", onError);
      guardian.once("exit", onExit);
      guardian.stdout.on("data", chunk => {
        if (settled) { if (ready && chunk.byteLength) died(); return; }
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.byteLength > MAX_REPLY_BYTES) { finish(new Error("Invalid Windows ownership response")); return; }
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        try {
          if (newline !== bytes.byteLength - 1) throw new Error("Multiple ownership responses");
          const reply = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
          const value = reply?.result;
          if (reply?.protocol !== 1 || reply?.ok !== true || !value
              || typeof value.root !== "string" || !isAbsolute(value.root) || value.root.includes("\0")
              || value.guardianPid !== guardian.pid
              || Object.keys(reply).some(key => !["protocol", "ok", "result"].includes(key))
              || Object.keys(value).some(key => !["root", "guardianPid"].includes(key))) throw new Error("Invalid ownership response");
          ready = true;
          finish(null, value);
        } catch { finish(new Error("Windows ownership could not be authenticated")); }
      });
    });
    if (guardian.exitCode !== null || guardian.signalCode !== null) throw new Error("Windows ownership helper exited");
    return {
      guardianPid: guardian.pid,
      mutableRoot: result.root,
      async release() {
        if (stopping) return;
        stopping = true;
        await stopGuardian(guardian);
      }
    };
  } catch (error) {
    stopping = true;
    await stopGuardian(guardian).catch(() => {});
    throw error;
  }
}
