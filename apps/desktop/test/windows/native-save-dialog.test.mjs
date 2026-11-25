import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Windows PowerShell compiles the actual Save As driver and verifies its pure input and identity contracts", { timeout: 60_000 }, async () => {
  assert.equal(process.platform, "win32", "This contract must execute on Windows; it cannot pass through a platform skip");
  assert.ok(process.env.SystemRoot && win32.isAbsolute(process.env.SystemRoot));
  const script = fileURLToPath(new URL("../../../../scripts/windows-native-save-dialog-contract.test.ps1", import.meta.url));
  const driver = fileURLToPath(new URL("../../../../scripts/windows-native-save-dialog.ps1", import.meta.url));
  const powershellRoot = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  const result = spawnSync(win32.join(powershellRoot, "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8", timeout: 45_000, maxBuffer: 131_072, windowsHide: true,
    env: { ...environment, PSModulePath: win32.join(powershellRoot, "Modules") }
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.status, "passed");
  assert.equal(proof.source, driver);
  assert.equal(proof.sourceSha256, createHash("sha256").update(await readFile(driver)).digest("hex"));
  assert.equal(proof.nativeInputExecuted, false);
  assert.equal(proof.powerShellMajor, 5);
  assert.equal(proof.powerShellMinor, 1);
  assert.equal(proof.powerShellEdition, "Desktop");
  assert.equal(proof.count, 23);
  assert.equal(proof.checks.length, proof.count);
  assert.ok(proof.checks.includes("x64 INPUT, union offset, KEYBDINPUT, MOUSEINPUT, HARDWAREINPUT and GUITHREADINFO ABI sizes"));
  assert.ok(proof.checks.includes("Non-ASCII and surrogate-pair code units are preserved without normalization"));
  assert.ok(proof.checks.includes("Empty, null, oversized and control-character text is rejected before native input"));
  assert.ok(proof.checks.includes("Every partial-prefix case releases only a pending key; completed batch emits no cleanup"));
  assert.ok(proof.checks.includes("Every retained PID, HWND, runtime ID and exact title change rejects even while disabled"));
  assert.ok(proof.checks.includes("Every found PID, HWND, runtime ID and exact title change rejects without reselection"));
  assert.ok(proof.checks.includes("The 3000ms readiness deadline rejects pending and newly ready observations at or after expiry"));
  assert.ok(proof.checks.includes("Diagnostics retain every rejected field separately for retained and found observations"));
  assert.ok(proof.checks.includes("No ValuePattern.SetValue remains and exactly one Save Invoke remains"));
});
