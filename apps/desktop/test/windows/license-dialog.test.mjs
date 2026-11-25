import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Windows PowerShell preserves exact installer identity and bounded licence-page readiness", { timeout: 45_000 }, async () => {
  assert.equal(process.platform, "win32", "This contract requires actual Windows PowerShell and cannot pass through a platform skip");
  assert.ok(process.env.SystemRoot && win32.isAbsolute(process.env.SystemRoot));
  const script = fileURLToPath(new URL("../../../../scripts/windows-installer-license-contract.test.ps1", import.meta.url));
  const source = fileURLToPath(new URL("../../../../scripts/windows-installer-license-dialog.ps1", import.meta.url));
  const shellRoot = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  const result = spawnSync(win32.join(shellRoot, "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 131_072, windowsHide: true,
    env: { ...environment, PSModulePath: win32.join(shellRoot, "Modules") }
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.status, "passed");
  assert.equal(proof.source, source);
  assert.equal(proof.sourceSha256, createHash("sha256").update(await readFile(source)).digest("hex"));
  assert.equal(proof.nativeUiExecuted, false);
  assert.equal(proof.installerStarted, false);
  assert.equal(proof.powerShellMajor, 5);
  assert.equal(proof.powerShellMinor, 1);
  assert.equal(proof.powerShellEdition, "Desktop");
  assert.equal(proof.checks.length, proof.count);
  assert.ok(proof.count >= 25);
  for (const required of ["Exact NSIS licence title includes one trailing ASCII space",
    "Old title is wait-only during the explicit Next transition", "Old title is rejected after the transition",
    "All rejected identity fields retain their expected and actual values", "A ready observation at the exact deadline cannot pass",
    "Changed process startTimeFileTimeUtc remains an identity rejection"]) assert.ok(proof.checks.includes(required), required);
});
