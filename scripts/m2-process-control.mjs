import { spawn } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;

function diagnostic(command, code, stderr, stdout) {
  return `${basename(command)} exited ${code}\n${[stderr, stdout].filter(Boolean).join("\n")}`;
}

export function runWithTimeout(command, args, options = {}) {
  const { timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS, ...spawnOptions } = options;
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${basename(command)} timed out after ${timeoutMs}ms\n${[stderr, stdout].filter(Boolean).join("\n")}`));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) accept({ stdout, stderr });
      else reject(new Error(diagnostic(command, code, stderr, stdout)));
    });
  });
}

export function startJsonLineService(command, args, options = {}) {
  const { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...spawnOptions } = options;
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...spawnOptions });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const waiting = [];
  let stderr = "", exited = false, exitCode = null, terminalError = null;

  function rejectAll(error) {
    while (waiting.length) {
      const pending = waiting.shift();
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  child.stderr.on("data", chunk => { stderr += chunk; });
  lines.on("line", line => {
    const pending = waiting.shift();
    if (!pending) {
      try { JSON.parse(line); }
      catch (error) {
        terminalError = new Error(`packaged service returned invalid JSON: ${error.message}`);
        child.kill("SIGKILL");
      }
      return;
    }
    clearTimeout(pending.timer);
    try { pending.resolve(JSON.parse(line)); }
    catch (error) {
      child.kill("SIGKILL");
      pending.reject(new Error(`packaged service returned invalid JSON: ${error.message}`));
    }
  });
  child.once("error", error => {
    exited = true;
    exitCode = "spawn-error";
    terminalError = error;
    rejectAll(error);
  });
  child.once("exit", code => {
    exited = true;
    exitCode = code;
    rejectAll(new Error(`packaged service exited ${code} before replying${stderr ? `: ${stderr}` : ""}`));
  });

  return {
    async request(lane, payload) {
      if (terminalError) throw terminalError;
      if (exited) throw new Error(`packaged service already exited ${exitCode}${stderr ? `: ${stderr}` : ""}`);
      const reply = await new Promise((resolve, reject) => {
        const pending = { resolve, reject, timer: null };
        pending.timer = setTimeout(() => {
          const index = waiting.indexOf(pending);
          if (index !== -1) waiting.splice(index, 1);
          child.kill("SIGKILL");
          reject(new Error(`packaged service request timed out after ${requestTimeoutMs}ms${stderr ? `: ${stderr}` : ""}`));
        }, requestTimeoutMs);
        waiting.push(pending);
        child.stdin.write(`${JSON.stringify({ lane, payload })}\n`, error => {
          if (!error) return;
          clearTimeout(pending.timer);
          const index = waiting.indexOf(pending);
          if (index !== -1) waiting.splice(index, 1);
          reject(error);
        });
      });
      if (!reply?.ok) throw new Error(`${lane} failed: ${reply?.error?.code ?? "UNKNOWN"}: ${reply?.error?.message ?? "no message"}`);
      return reply.value;
    },
    async close({ timeoutMs = requestTimeoutMs } = {}) {
      if (exited) {
        if (exitCode !== 0) throw new Error(`packaged service shutdown failed: ${stderr}`);
        return;
      }
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`packaged service shutdown timed out after ${timeoutMs}ms${stderr ? `: ${stderr}` : ""}`));
        }, timeoutMs);
        child.once("exit", value => { clearTimeout(timer); resolve(value); });
        child.stdin.end();
      });
      if (code !== 0) throw new Error(`packaged service shutdown failed: ${stderr}`);
    },
    async terminate() {
      if (exited) return;
      child.kill("SIGKILL");
      await new Promise(resolve => {
        const timer = setTimeout(resolve, requestTimeoutMs);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.once("error", () => { clearTimeout(timer); resolve(); });
      });
    }
  };
}
