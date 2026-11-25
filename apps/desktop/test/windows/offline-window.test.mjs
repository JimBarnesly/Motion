import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("offline fixture guards reject foreign cleanup and exercise actual bounded child capture", async () => {
  assert.equal(process.platform, "win32", "This acceptance test must run on the Windows runner");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const script = fileURLToPath(new URL("../../../../scripts/windows-installer-offline-contract.test.ps1", import.meta.url));
  const shell = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const entries = Object.entries(process.env);
  const environment = Object.fromEntries(entries.filter(([key]) => !["PSMODULEPATH", "PATH"].includes(key.toUpperCase())));
  const inheritedPath = entries.find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const fixture = await mkdtemp(win32.join(tmpdir(), "motion-offline-node-path-"));
  let result;
  try {
    const first = win32.join(fixture, "first"), second = win32.join(fixture, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    // These are deliberately non-executable sentinels, never child runtimes.
    // The previous Get-Command discovery joined all PATH matches and failed;
    // the actual process executable must work despite both shadow entries.
    await Promise.all([first, second].map(directory => writeFile(win32.join(directory, "node.exe"),
      "PATH discovery must not execute this fixture.\n", { flag: "wx" })));
    result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script,
      "-NodeExecutable", process.execPath], {
      encoding: "utf8", timeout: 60_000, maxBuffer: 131_072, windowsHide: true,
      env: { ...environment, PATH: [first, second, inheritedPath].join(win32.delimiter),
        PSModulePath: win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") }
    });
  } finally { await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.status, "passed");
  assert.equal(proof.nodeExecutable, process.execPath);
  assert.equal(proof.manifestChecks, "passed");
  assert.equal(proof.jobChecks, "passed");
  assert.equal(proof.networkPolicyOrCanaryExecuted, false);
  assert.ok(proof.checks.includes("exact deadline rejects completion"));
  assert.ok(proof.checks.includes("reject foreign-rule before cleanup"));
  assert.ok(proof.checks.includes("reject foreign-task before cleanup"));
  assert.ok(proof.checks.includes("excess-output child is terminated"));
});
