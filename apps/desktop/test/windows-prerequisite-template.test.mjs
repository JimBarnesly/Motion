import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [template, provenanceText, windowsText, pinText, lockText] = await Promise.all([
  read("../src-tauri/windows/installer.nsi"),
  read("../src-tauri/windows/nsis-template-provenance.json"),
  read("../src-tauri/tauri.windows.conf.json"),
  read("../../../scripts/windows-installer-payload-pin.json"),
  read("../../../package-lock.json"),
]);
const provenance = JSON.parse(provenanceText), windows = JSON.parse(windowsText);
const pin = JSON.parse(pinText), lock = JSON.parse(lockText);
const { startMarker, endMarker, originalSection } = provenance.modification;
const start = template.indexOf(startMarker), end = template.indexOf(endMarker) + endMarker.length;
const prerequisite = template.slice(start, end);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const count = (source, expression) => [...source.matchAll(expression)].length;
const functionBody = name => {
  const match = prerequisite.match(new RegExp(`^Function ${name}\\n([\\s\\S]*?)^FunctionEnd$`, "m"));
  assert.ok(match, `missing ${name}`);
  return match[1];
};

test("the custom template reconstructs the exact locked upstream outside its WebView prerequisite", async () => {
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.upstream.commit, "8909f221d1515955fc843808032bdc5d62209c96");
  assert.equal(provenance.upstream.cliVersion, lock.packages["node_modules/@tauri-apps/cli"].version);
  assert.equal(provenance.upstream.bundlerVersion, "2.9.4");
  assert.equal(provenance.upstream.templatePath, "crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi");
  assert.ok(start >= 0 && end > start);
  assert.equal(template.indexOf(startMarker, start + 1), -1);
  assert.equal(template.indexOf(endMarker, end), -1);
  assert.match(originalSection, /^Section WebView2\n[\s\S]*\nSectionEnd$/);
  const reconstructed = template.slice(0, start) + originalSection + template.slice(end);
  assert.equal(provenance.upstream.templateSha256, "20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079");
  assert.equal(sha256(reconstructed), provenance.upstream.templateSha256);
  assert.equal(provenance.upstream.licenceExpression, "Apache-2.0 OR MIT");
  const expected = {
    LICENSE_MIT: "9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d",
    "LICENSE_APACHE-2.0": "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594",
  };
  assert.deepEqual(provenance.upstream.licences.map(item => item.file).sort(), Object.keys(expected).sort());
  for (const licence of provenance.upstream.licences) {
    assert.equal(licence.sha256, expected[licence.file]);
    assert.equal(sha256(await read(`../src-tauri/windows/${licence.file}`)), licence.sha256);
    assert.equal(licence.sourceUrl, `https://raw.githubusercontent.com/tauri-apps/tauri/${provenance.upstream.commit}/${licence.file}`);
  }
});

test("Windows config and compile-time guards bind the offline prerequisite to the contained runtime floor", () => {
  const config = windows.bundle.windows;
  assert.deepEqual(config.webviewInstallMode, { type: "offlineInstaller", silent: true });
  assert.equal(config.nsis.installMode, "currentUser");
  assert.equal(config.nsis.template, "windows/installer.nsi");
  assert.equal(config.minimumWebview2Version, "158.0.4370.33");
  assert.equal(config.minimumWebview2Version, pin.payload.containedRuntimeVersion);
  assert.equal(config.minimumWebview2Version, provenance.modification.distributionFloor);
  assert.match(prerequisite, /!if "\$\{INSTALLWEBVIEW2MODE\}" != "offlineInstaller"\s+!error /);
  assert.match(prerequisite, /!if "\$\{MINIMUMWEBVIEW2VERSION\}" != "158\.0\.4370\.33"\s+!error /);
  assert.match(prerequisite, /!if "\$\{WEBVIEW2INSTALLERARGS\}" != "\/silent"\s+!error /);
  assert.match(prerequisite, /!if "\$\{WEBVIEW2INSTALLERPATH\}" == ""\s+!error /);
});

test("the prerequisite keeps machine-first registration and validates the complete version before comparison", () => {
  const detector = functionBody("MotionHasSuitableWebView2");
  assert.match(detector, /ReadRegStr \$0 HKLM32 "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\\$\{WEBVIEW2APPGUID\}" "pv"\n  \$\{If\} \$0 == ""\n    ClearErrors\n    ReadRegStr \$0 HKCU32 "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\\$\{WEBVIEW2APPGUID\}" "pv"\n  \$\{EndIf\}/);
  assert.equal(count(detector, /^\s*ReadRegStr /gm), 2);
  assert.match(detector, /\$\{If\} \$\{Errors\}\n    StrCpy \$0 ""\n  \$\{EndIf\}\n  Push \$0\n  Call MotionWebViewVersionMeetsMinimum/);
  assert.doesNotMatch(detector, /VersionCompare|SetRegView|Exec|WriteReg|DeleteReg/);
  const validator = functionBody("MotionWebViewVersionMeetsMinimum");
  const allowedDigits = [...validator.matchAll(/StrCmp \$4 "([0-9])" motion_version_digit/g)].map(match => match[1]);
  assert.deepEqual(allowedDigits, Array.from({ length: 10 }, (_, index) => String(index)));
  assert.match(validator, /StrCmp \$4 "9" motion_version_digit\n    Goto motion_version_invalid/);
  assert.match(validator, /\$\{If\} \$2 > 5\n      Goto motion_version_invalid/);
  assert.match(validator, /\$\{If\} \$5 > 65535\n      Goto motion_version_invalid/);
  assert.match(validator, /motion_version_end:\n    \$\{If\} \$2 == 0\n    \$\{OrIf\} \$3 != 3\n      Goto motion_version_invalid\n    \$\{EndIf\}\n    \$\{VersionCompare\} "\$0" "\$\{MINIMUMWEBVIEW2VERSION\}" \$6/);
  assert.equal(count(validator, /\$\{VersionCompare\}/g), 1);
  assert.match(validator, /\$\{If\} \$6 == 0\n    \$\{OrIf\} \$6 == 1\n      StrCpy \$0 1/);
});

test("only the sole embedded wrapper can run, and every unsuccessful prerequisite path aborts before Motion installation", () => {
  const embed = 'File "/oname=$TEMP\\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"';
  assert.equal(count(template, /^\s*File .*WEBVIEW2INSTALLERPATH.*$/gm), 1);
  assert.equal(pin.payload.member, "$TEMP/MicrosoftEdgeWebView2RuntimeInstaller.exe");
  assert.ok(prerequisite.includes(embed));
  assert.equal(count(prerequisite, /^\s*ExecWait /gm), 1);
  assert.ok(prerequisite.includes('ExecWait \'"$TEMP\\MicrosoftEdgeWebView2RuntimeInstaller.exe" /silent /install\' $1'));
  assert.doesNotMatch(prerequisite, /NSISdl::|downloadBootstrapper|embedBootstrapper|EdgeUpdate.*"path"|needsadmin|ExecShell|ABORTRETRYIGNORE|IDIGNORE|WriteReg|DeleteReg|^\s*Delete |\$UpdateMode/m);
  const section = prerequisite.slice(prerequisite.indexOf("Section WebView2\n"));
  assert.equal(count(section, /Call MotionHasSuitableWebView2/g), 2, "availability is re-read after setup");
  assert.match(section, /^Section WebView2\n  Call MotionHasSuitableWebView2\n  Pop \$0\n  \$\{If\} \$0 == 1\n    DetailPrint [^\n]+\n    Goto motion_webview_done\n  \$\{EndIf\}/);
  assert.match(section, /File [^\n]+\n  \$\{If\} \$\{Errors\}\n    SetErrorLevel 1\n    Abort /);
  assert.match(section, /ExecWait [^\n]+\n  \$\{If\} \$\{Errors\}\n    SetErrorLevel 1\n    Abort /);
  assert.match(section, /\$\{If\} \$1 != 0\n    SetErrorLevel 1\n    Abort /);
  assert.match(section, /Call MotionHasSuitableWebView2\n  Pop \$0\n  \$\{If\} \$0 != 1\n    SetErrorLevel 1\n    Abort /);
  assert.equal(count(section, /^\s*Abort /gm), 4);
  assert.ok(template.indexOf("\nSection Install\n") > end, "the prerequisite completes before Motion files are copied");
});
