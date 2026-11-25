import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("offline fixture guards reject foreign cleanup and exercise actual bounded child capture", () => {
  assert.equal(process.platform, "win32", "This acceptance test must run on the Windows runner");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const script = fileURLToPath(new URL("../../../../scripts/windows-installer-offline-contract.test.ps1", import.meta.url));
  const shell = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 131_072, windowsHide: true,
    env: { ...environment, PSModulePath: win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") }
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.status, "passed");
  assert.equal(proof.manifestChecks, "passed");
  assert.equal(proof.jobChecks, "passed");
  assert.equal(proof.networkPolicyOrCanaryExecuted, false);
  assert.ok(proof.checks.includes("exact deadline rejects completion"));
  assert.ok(proof.checks.includes("reject foreign-rule before cleanup"));
  assert.ok(proof.checks.includes("reject foreign-task before cleanup"));
  assert.ok(proof.checks.includes("excess-output child is terminated"));
});
