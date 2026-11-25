import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { invokeWindowsNativeHelper } from "@motion/storage";

assert.equal(process.platform, "win32", "This acceptance suite requires actual Windows; it must not pass through platform skips");
assert.ok(process.env.MOTION_NATIVE_HELPER && isAbsolute(process.env.MOTION_NATIVE_HELPER),
  "Set MOTION_NATIVE_HELPER to the compiled or installed Motion executable");

export const nodeExecutable = process.env.MOTION_TEST_NODE_BINARY ?? process.execPath;

export async function withRoot(body) {
  const parent = await mkdtemp(join(tmpdir(), "motion-windows-"));
  const root = join(parent, "private");
  try {
    invokeWindowsNativeHelper({ operation: "private.directory", path: root, create: true });
    await body(root);
  }
  finally { await rm(parent, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); }
}

export function start(entry, args = [], environment = {}) {
  const child = spawn(nodeExecutable, [entry, ...args], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, MOTION_SERVICE_START_GATE: "0", ...environment }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {});
  const exited = once(child, "exit");
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  return {
    child, exited, closed,
    send: request => child.stdin.write(`${typeof request === "string" ? request : JSON.stringify(request)}\n`),
    stderr: () => stderr,
    async next(timeout = 15_000) {
      let timer;
      try {
        const value = await Promise.race([
          lines.next(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Windows service reply timed out: ${stderr}`)), timeout); })
        ]);
        assert.equal(value.done, false, `Windows service exited before replying: ${stderr}`);
        return JSON.parse(value.value);
      } finally { clearTimeout(timer); }
    },
    async stop() {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    },
    async finish() {
      child.stdin.end();
      const [code] = await exited;
      assert.equal(code, 0, stderr);
      await closed;
    }
  };
}

export async function waitForProcessExit(pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("The native guardian survived the owner process closing its pipe");
}

export function assertPrivateAcl(path) {
  const script = "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:MOTION_TEST_ACL_PATH; "
    + "$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; "
    + "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
    + "$rules=@($acl.Access | ForEach-Object { @{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; type=$_.AccessControlType.ToString(); inherited=$_.IsInherited} }); "
    + "@{owner=$owner; current=$current; protected=$acl.AreAccessRulesProtected; rules=$rules} | ConvertTo-Json -Depth 5 -Compress";
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, MOTION_TEST_ACL_PATH: path }, timeout: 15_000
  });
  assert.equal(result.status, 0, result.stderr);
  const acl = JSON.parse(result.stdout);
  assert.equal(acl.owner, acl.current, "Private data must be owned by the current user, including under an elevated token");
  assert.equal(acl.protected, true, "Private files and roots must not inherit broad access grants");
  assert.ok(acl.rules.length > 0, "A null/empty DACL is not proof of current-user access");
  const allowed = new Set([acl.current, "S-1-5-18", "S-1-5-32-544"]);
  for (const rule of acl.rules) {
    if (rule.type === "Allow") assert.ok(allowed.has(rule.sid), "An unrelated principal received private Motion data access");
  }
  assert.ok(acl.rules.some(rule => rule.type === "Allow" && rule.sid === acl.owner), "Current owner has no explicit grant");
}
