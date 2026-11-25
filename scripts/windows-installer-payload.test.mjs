import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { measureFile, requirePinnedMeasurement, runVerificationTool, validateAuthenticode, validateNsisListing, validatePin } from "./windows-verify-installer-payload.mjs";

const pin = JSON.parse(await readFile(new URL("./windows-installer-payload-pin.json", import.meta.url), "utf8"));
const installerBytes = 323719384;
const digest = value => createHash("sha256").update(value).digest("hex");
const record = (path = pin.payload.member, size = pin.payload.byteLength, extra = "") =>
  `Path = ${path}\nSize = ${size}\nPacked Size = \nModified = \nAttributes = \nMethod = LZMA:23\nSolid = +\nOffset = 96150${extra}`;
const listing = (...records) => `7-Zip 26.06 (x64) : Copyright (c) 1999-2026 Igor Pavlov\n\n--\nPath = C:\\fixture\\Motion-setup.exe\nType = Nsis\nPhysical Size = ${installerBytes}\nMethod = LZMA:23\nSolid = +\n\n----------\n${records.join("\n\n")}\n\n`;
const validate = text => validateNsisListing(text, pin.payload, installerBytes, pin.extractor.version);

test("reviewed payload and official extraction-tool pins preserve the measured identities", () => {
  assert.equal(validatePin(pin), pin);
  assert.equal(pin.payload.sha256, "47bc51387aff95c1275ce38cfbbb5fbab99b43b33214049877bbcdbcc7a970d5");
  assert.equal(pin.payload.byteLength, 294099168);
  assert.equal(pin.payload.signatureIndex, 0);
  assert.equal(pin.payload.signerCertificateSha256, "e0113ed8f5aebc48d48e53f699129d14ddedcfcae489aba7db411ed0838a14c0");
  assert.equal(pin.extractor.runnerImage, "win22/20261116.370");
  assert.equal(pin.extractor.officialAsset.sha256, "9b697f65ecc2d9b0152f5ee96d72dde522a7827690349d9307935dacf40f42ec");
  for (const change of [
    value => { value.payload.officialUrl = "https://unreviewed.example/installer.exe"; },
    value => { value.extractor.files.push({ ...value.extractor.files[0], name: "Codecs/extra.dll" }); },
    value => { value.allowedWindowsSdks[0] = "../../unreviewed"; },
    value => { value.payload.signerCertificateSha256 = "a".repeat(40); },
    value => { value.payload.signatureIndex = 1; },
    value => { value.payload.signatureIndex = -1; },
    value => { delete value.payload.signatureIndex; },
  ]) {
    const invalid = structuredClone(pin); change(invalid);
    assert.throws(() => validatePin(invalid));
  }
});

test("a complete NSIS inventory selects the sole literal payload with either Windows path separator", () => {
  assert.deepEqual(validate(listing(record(), record("motion-desktop.exe", 9164800), record("uninstall.exe", ""))),
    { member: pin.payload.member, memberCount: 3 });
  const windowsName = pin.payload.member.replaceAll("/", "\\");
  assert.equal(validate(listing(record(windowsName))).member, windowsName);
});

test("missing, duplicate, case-colliding, misplaced and linked payloads fail closed", () => {
  for (const invalid of [
    listing(record("motion-desktop.exe", 20)),
    listing(record(), record()),
    listing(record(), record(pin.payload.member.toLowerCase())),
    listing(record(), record(`elsewhere/${pin.payload.member.split("/").at(-1)}`)),
    listing(record("$TEMP/../MicrosoftEdgeWebView2RuntimeInstaller.exe")),
    listing(record("$TEMP/MicrosoftEdgeWebView2RuntimeInstaller.exe.")),
    listing(record("$TEMP/MicrosoftEdgeWebView2RuntimeInstaller.exe:stream")),
    listing(record("$TEMP//MicrosoftEdgeWebView2RuntimeInstaller.exe")),
    listing(record("$TEMP/MicrosoftEdgeWebView2RuntimeInstaller.exe\t")),
    listing(record(undefined, undefined, "\nSymbolic Link = target")),
    listing(record(undefined, undefined, "\nHard Link = target")),
    listing(record(undefined, undefined, "\nFolder = +")),
    listing(record(undefined, undefined, "\nEncrypted = +")),
    listing(record().replace("Attributes = ", "Attributes = D")),
  ]) assert.throws(() => validate(invalid));
});

test("malformed, incomplete and oversized archive evidence cannot authorize extraction", () => {
  for (const invalid of [
    listing(record()).replace("Type = Nsis", "Type = 7z"),
    listing(record()).replace(`Physical Size = ${installerBytes}`, "Physical Size = 1"),
    listing(record()).replace("7-Zip 26.06", "7-Zip 26.05"),
    listing(record(undefined, pin.payload.byteLength + 1)),
    listing(record()).replace("Size = 294099168", "Size = not-a-number"),
    listing(record()).replace("Offset = 96150", "Offset = 9999999999999999999"),
    listing(record()).replace("Modified = \n", ""),
    listing(record(undefined, undefined, `\nPath = ${pin.payload.member}`)),
    listing(record()).replace("\n----------\n", "\n----------\n\n----------\n"),
    listing(record()).replace("Solid = +", "Solid = +\0"),
    listing(record(), ...Array.from({ length: 256 }, (_, index) => record(`extra-${index}.exe`, 1))),
    listing(record(), record("oversized.exe", 1024 * 1024 * 1024)),
    listing(record()) + "x".repeat(256 * 1024),
  ]) assert.throws(() => validate(invalid));
});

test("byte pins reject same-size corruption and truncation, using real files", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-installer-pin-test-"));
  try {
    const path = join(root, "payload.exe"), bytes = Buffer.from("Controlled payload fixture");
    const expected = { byteLength: bytes.length, sha256: digest(bytes) };
    await writeFile(path, bytes);
    requirePinnedMeasurement(await measureFile(path, bytes.length), expected, "Fixture payload");
    const damaged = Buffer.from(bytes); damaged[3] ^= 1;
    await writeFile(path, damaged);
    const changed = await measureFile(path, bytes.length);
    assert.throws(() => requirePinnedMeasurement(changed, expected, "Fixture payload"), /reviewed bytes/);
    await writeFile(path, bytes.subarray(0, -1));
    const truncated = await measureFile(path, bytes.length);
    assert.throws(() => requirePinnedMeasurement(truncated, expected, "Fixture payload"));
    await writeFile(path, Buffer.concat([bytes, Buffer.of(0)]));
    await assert.rejects(measureFile(path, bytes.length), /bounded regular file/);
    await assert.rejects(measureFile(root, bytes.length), /bounded regular file/);
    if (process.platform !== "win32") {
      const linked = join(root, "linked.exe"); await symlink(path, linked);
      await assert.rejects(measureFile(linked, bytes.length + 1), /bounded regular file/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verification-tool errors, warnings, excessive output and deadlines fail instead of producing success", { timeout: 10_000 }, async () => {
  const success = await runVerificationTool(process.execPath, ["-e", "process.stdout.write('controlled verifier fixture')"]);
  assert.equal(success.exitCode, 0);
  assert.equal(success.stdout, "controlled verifier fixture");
  for (const code of [1, 2]) {
    await assert.rejects(runVerificationTool(process.execPath, ["-e", `process.stderr.write('controlled verifier failure');process.exitCode=${code}`]),
      error => error.toolExit === code && error.stderr === "controlled verifier failure");
  }
  await assert.rejects(runVerificationTool(process.execPath, ["-e", "process.stdout.write('x'.repeat(262145))"]), /output limit/);
  await assert.rejects(runVerificationTool(process.execPath, ["-e", "setInterval(()=>{},10000)"], { timeout: 150 }), /timed out/);
});

test("signature evidence requires Windows validity, embedded type, exact DER signer and timestamp", () => {
  // These are validator fixtures, not fabricated Windows trust verdicts. The
  // executable gate obtains both the real SignTool result and the OS probe.
  const valid = { schemaVersion: 1, status: "Valid", signatureType: "Authenticode",
    signer: { subject: "CN=Microsoft Corporation, O=Microsoft Corporation, C=US", derSha256: pin.payload.signerCertificateSha256 },
    timestampSigner: { derSha256: "a".repeat(64) }, fileVersion: pin.payload.wrapperVersion };
  assert.equal(validateAuthenticode(valid, pin.payload), valid);
  for (const change of [
    value => { value.status = "NotTrusted"; },
    value => { value.status = "HashMismatch"; },
    value => { value.status = "NotSigned"; },
    value => { value.signatureType = "Catalog"; },
    value => { value.signer.derSha256 = "b".repeat(64); },
    value => { value.signer.subject = "CN=Microsoft Corporation, O=Unreviewed Publisher"; },
    value => { value.timestampSigner = null; },
    value => { value.fileVersion = "1.3.315.18"; },
  ]) {
    const invalid = structuredClone(valid); change(invalid);
    assert.throws(() => validateAuthenticode(invalid, pin.payload));
  }
  const sdk = { ...valid, originalFilename: "SignTool.exe" };
  assert.equal(validateAuthenticode(sdk, { sdkTool: true }), sdk);
  assert.throws(() => validateAuthenticode({ ...sdk, originalFilename: "different.exe" }, { sdkTool: true }));
});

function assertPayloadGateContract(coordinator, workflow) {
  // This is a source-order contract, not a fabricated PowerShell execution. It
  // binds the verifier's real exit status to the only installer upload gate.
  const source = coordinator.replaceAll("\r\n", "\n");
  const verification = [...source.matchAll(/^node \(Join-Path \$PSScriptRoot 'windows-verify-installer-payload\.mjs'\) --installer \$installer\.FullName --output \$payloadEvidence\nif \(\$LASTEXITCODE -ne 0\) \{ throw '[^'\n]+' \}/gm)];
  assert.equal(verification.length, 1, "verification must immediately throw on every nonzero exit");
  const proof = source.indexOf("if ($payloadProof.schemaVersion -ne 1 -or $payloadProof.status -cne 'passed' -or\n    $payloadProof.commit -cne $env:GITHUB_SHA -or $payloadProof.installer.sha256 -cne $installerHash) {\n    throw ");
  const outputs = [...source.matchAll(/^Add-Content -LiteralPath \$env:GITHUB_OUTPUT -Value 'installer_payload_verified=true' -Encoding utf8$/gm)];
  assert.equal(outputs.length, 1, "only one verified publication flag may be written");
  const firstLaunch = source.search(/^\s*(?:\$\w+\s*=\s*)?Start-Process\b/m);
  assert.ok(verification[0].index < proof && proof < outputs[0].index && outputs[0].index < firstLaunch,
    "verification, current candidate identity, publication flag, and execution must remain ordered");

  const steps = workflow.replaceAll("\r\n", "\n").split(/^      - /m).slice(1);
  const acceptance = steps.filter(step => /\brun: \.\/scripts\/windows-installed-acceptance\.ps1\s*$/m.test(step));
  assert.equal(acceptance.length, 1);
  assert.match(acceptance[0], /^        id: installed_acceptance$/m);
  const installerUploads = steps.filter(step => /uses: actions\/upload-artifact@/.test(step) && /bundle\/nsis\//.test(step));
  assert.equal(installerUploads.length, 1, "the installer has one explicit publication path");
  assert.match(installerUploads[0], /^        if: \$\{\{ always\(\) && steps\.installed_acceptance\.outputs\.installer_payload_verified == 'true' \}\}$/m,
    "installer upload must require the successful verifier output, even when later acceptance fails");
  assert.ok(steps.indexOf(acceptance[0]) < steps.indexOf(installerUploads[0]));
}

test("installer execution and candidate publication remain behind the final-payload verification gate", async () => {
  const [coordinator, workflow] = await Promise.all([
    readFile(new URL("./windows-installed-acceptance.ps1", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/windows.yml", import.meta.url), "utf8"),
  ]);
  assertPayloadGateContract(coordinator, workflow);
  for (const unsafeCoordinator of [
    coordinator.replace("if ($LASTEXITCODE -ne 0) { throw 'The embedded", "if ($LASTEXITCODE -eq 0) { throw 'The embedded"),
    coordinator.replace("if ($LASTEXITCODE -ne 0) { throw 'The embedded", "if ($LASTEXITCODE -ne 0) { Write-Warning 'The embedded"),
    "Start-Process -FilePath $installer.FullName\n" + coordinator,
    "Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value 'installer_payload_verified=true' -Encoding utf8\n" + coordinator,
    coordinator.replace("$payloadProof.installer.sha256 -cne $installerHash", "$false"),
  ]) assert.throws(() => assertPayloadGateContract(unsafeCoordinator, workflow));
  for (const unsafeWorkflow of [
    workflow.replace("id: installed_acceptance", "id: unrelated_acceptance"),
    workflow.replace("always() && steps.installed_acceptance.outputs.installer_payload_verified == 'true'", "always()"),
    workflow.replace("installer_payload_verified == 'true'", "installer_payload_verified != 'false'"),
  ]) assert.throws(() => assertPayloadGateContract(coordinator, unsafeWorkflow));
});
