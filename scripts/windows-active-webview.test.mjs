import assert from "node:assert/strict";
import { test } from "node:test";
import { createActiveWebViewRequest, probeActiveWebView, validateActiveWebViewEvidence } from "./windows-active-webview.mjs";

const options = {
  motionIdentity: { processId: 4120, executablePath: "D:\\Runner temp\\Motion installed acceptance\\motion-desktop.exe",
    startTimeFileTimeUtc: "134400889462788387", sessionId: 2 },
  debugPort: 49211, minimumVersion: "158.0.4370.33", cdpProduct: "Edg/158.0.4370.33"
};

// Protocol fixtures exercise independent evidence validation only. They are not
// a Windows process test; the installed gate must run the real native probe.
function observation() {
  return {
    schemaVersion: 1, operation: "active-webview", ok: true, phase: "complete",
    motionIdentity: structuredClone(options.motionIdentity),
    listener: { port: 49211, addresses: ["127.0.0.1", "::1"], owningProcessId: 5120 },
    runtimeIdentity: { processId: 5120,
      executablePath: "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\158.0.4370.33\\msedgewebview2.exe",
      startTimeFileTimeUtc: "134400889463788387", sessionId: 2 },
    parentProcessId: 4120,
    executable: {
      path: "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\158.0.4370.33\\msedgewebview2.exe",
      knownLocation: "ProgramFilesX86", applicationRoot: "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application",
      directoryVersion: "158.0.4370.33", moduleVersion: "158.0.4370.33", fileVersion: "158.0.4370.33", productVersion: "158.0.4370.33",
      byteLength: 4_000_000, sha256: "0123456789abcdef".repeat(4)
    },
    minimumVersion: options.minimumVersion, cdpProduct: options.cdpProduct, rechecked: true, error: null
  };
}

test("request validation preserves exact FILETIME, spaces, and source data", () => {
  const before = structuredClone(options);
  const request = createActiveWebViewRequest(options);
  assert.deepEqual(options, before);
  assert.notEqual(request.motionIdentity, options.motionIdentity);
  assert.equal(request.motionIdentity.startTimeFileTimeUtc, "134400889462788387");
  assert.equal(request.debugPort, 49211);
  assert.equal(request.operation, "active-webview");
  assert.equal(createActiveWebViewRequest({ ...options, cdpProduct: undefined }).cdpProduct, null);
});

test("requests refuse namespace/coercion/version ambiguity before launching anything", () => {
  const changes = [
    value => { value.extra = true; },
    value => { value.debugPort = "49211"; },
    value => { value.debugPort = 0; },
    value => { value.debugPort = 65536; },
    value => { value.motionIdentity.processId = 4.5; },
    value => { value.motionIdentity.startTimeFileTimeUtc = 134400889462788387; },
    value => { value.motionIdentity.startTimeFileTimeUtc = "9999999999999999999"; },
    value => { value.motionIdentity.executablePath = "\\\\server\\share\\motion-desktop.exe"; },
    value => { value.motionIdentity.executablePath = "\\\\?\\D:\\Motion\\motion-desktop.exe"; },
    value => { value.motionIdentity.executablePath = "D:\\Motion\\..\\motion-desktop.exe"; },
    value => { value.motionIdentity.executablePath = "D:\\Motion.\\motion-desktop.exe"; },
    value => { value.motionIdentity.executablePath = "D:\\Motion\\motion-desktop.exe:stream"; },
    value => { value.motionIdentity.executablePath = "D:\\Motion\\other.exe"; },
    value => { value.minimumVersion = "158.0.4370"; },
    value => { value.minimumVersion = "158.0.4370.33 beta"; },
    value => { value.minimumVersion = "158.0.4370.65536"; },
    value => { value.minimumVersion = "0158.0.4370.33"; },
    value => { value.cdpProduct = "Edg/158.0.4370.33\nignored"; }
  ];
  for (const change of changes) {
    const value = structuredClone(options); change(value);
    assert.throws(() => createActiveWebViewRequest(value), { code: "INVALID_INPUT" });
  }
});

test("complete native evidence requires listener, process generation, parent, and version agreement", () => {
  const value = observation();
  assert.equal(validateActiveWebViewEvidence(value, options), value);
  const changes = [
    proof => { proof.ok = "true"; },
    proof => { proof.rechecked = false; },
    proof => { proof.phase = "version"; },
    proof => { proof.motionIdentity.startTimeFileTimeUtc = "134400889462788388"; },
    proof => { proof.motionIdentity.executablePath = "D:\\Other\\motion-desktop.exe"; },
    proof => { proof.listener.port += 1; },
    proof => { proof.listener.addresses = ["0.0.0.0"]; },
    proof => { proof.listener.addresses = ["::1"]; },
    proof => { proof.listener.addresses = ["127.0.0.1", "127.0.0.1"]; },
    proof => { proof.listener.owningProcessId += 1; },
    proof => { proof.runtimeIdentity.startTimeFileTimeUtc = "134400889462788386"; },
    proof => { proof.runtimeIdentity.sessionId += 1; },
    proof => { proof.parentProcessId += 1; },
    proof => { proof.executable.path = proof.executable.path.replace("msedgewebview2.exe", "msedge.exe"); },
    proof => { proof.executable.moduleVersion = "131.0.2903.48"; },
    proof => { proof.executable.productVersion = "158.0.8127.0"; },
    proof => { proof.executable.directoryVersion = "158.0.4370.34"; },
    proof => { proof.executable.sha256 = "not-a-digest"; },
    proof => { proof.executable.byteLength = 67_108_865; },
    proof => { proof.executable.knownLocation = "RegistryAvailable"; },
    proof => { proof.executable = null; },
    proof => { proof.availableVersion = "158.0.4370.33"; }
  ];
  for (const change of changes) {
    const proof = observation(); change(proof);
    assert.throws(() => validateActiveWebViewEvidence(proof, options), { code: "INVALID_EVIDENCE" });
  }
});

test("numeric minimum comparison cannot confuse Chromium and Edge builds", () => {
  const chromium = { ...options, cdpProduct: "Chrome/158.0.8127.0" };
  const proof = observation(); proof.cdpProduct = chromium.cdpProduct;
  assert.equal(validateActiveWebViewEvidence(proof, chromium).executable.fileVersion, "158.0.4370.33");
  const high = { ...chromium, minimumVersion: "158.0.4370.34" };
  proof.minimumVersion = high.minimumVersion;
  assert.throws(() => validateActiveWebViewEvidence(proof, high), { code: "INVALID_EVIDENCE" });
  // Even a larger Chromium build cannot satisfy the Edge minimum.
  const old = { ...options, minimumVersion: "158.0.4370.9" };
  const current = observation(); current.minimumVersion = old.minimumVersion;
  assert.equal(validateActiveWebViewEvidence(current, old).ok, true);
  const wrongEdge = { ...options, cdpProduct: "Edg/158.0.4370.34" };
  current.minimumVersion = wrongEdge.minimumVersion; current.cdpProduct = wrongEdge.cdpProduct;
  assert.throws(() => validateActiveWebViewEvidence(current, wrongEdge), { code: "INVALID_EVIDENCE" });
});

test("real negative-control codes and bounded observations survive validation as failures", () => {
  for (const [code, phase] of [["PROCESS_IDENTITY_MISMATCH", "motion"], ["LISTENER_NOT_FOUND", "listener"], ["RUNTIME_TOO_OLD", "minimum"]]) {
    const failed = observation();
    failed.ok = false; failed.phase = phase; failed.rechecked = false;
    failed.error = { code, exceptionType: "System.Management.Automation.RuntimeException", hresult: "80131501" };
    if (phase !== "minimum") {
      failed.listener = null; failed.runtimeIdentity = null; failed.parentProcessId = null; failed.executable = null;
      if (phase === "motion") failed.motionIdentity = null;
    }
    assert.throws(() => validateActiveWebViewEvidence(failed, options), error => error.code === code && error.evidence === failed);
  }
  const falseSuccess = observation(); falseSuccess.error = { code: "RUNTIME_TOO_OLD" };
  assert.throws(() => validateActiveWebViewEvidence(falseSuccess, options), { code: "INVALID_EVIDENCE" });
});

test("native execution refuses this host unless it is the explicit Windows x64 CI environment", async () => {
  if (process.platform === "win32" && process.arch === "x64" && process.env.GITHUB_ACTIONS === "true") {
    // This test still asserts rejection before spawn on Windows; actual valid
    // identities belong to the installed application acceptance controller.
    await assert.rejects(probeActiveWebView({ ...options, debugPort: 0 }), { code: "INVALID_INPUT" });
  } else {
    await assert.rejects(probeActiveWebView(options), { code: "UNSUPPORTED_HOST" });
  }
});
