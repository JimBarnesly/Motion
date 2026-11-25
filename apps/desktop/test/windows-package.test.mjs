import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const load = async name => JSON.parse(await readFile(new URL(`../src-tauri/${name}`, import.meta.url), "utf8"));

test("Windows packaging bundles local prerequisites and a per-user installer without changing Linux targets", async () => {
  const base = await load("tauri.conf.json"), windows = await load("tauri.windows.conf.json"), linux = await load("tauri.linux.conf.json");
  assert.deepEqual(windows.bundle.targets, ["nsis"]);
  assert.equal(windows.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(windows.bundle.windows.webviewInstallMode.type, "offlineInstaller");
  assert.equal(windows.bundle.windows.allowDowngrades, false);
  const winResources = { ...base.bundle.resources, ...windows.bundle.resources };
  assert.equal(winResources["../dist/service-bundle.mjs"], "service-bundle.mjs");
  assert.equal(winResources["../dist/node-runtime.exe"], "node-runtime.exe");
  assert.equal(winResources["../dist/node-runtime-LICENSE"], "node-runtime-LICENSE");
  assert.equal(Object.hasOwn(winResources, "../dist/node-runtime"), false);
  assert.deepEqual(base.bundle.targets, ["deb", "appimage"]);
  assert.equal(linux.bundle.resources["../dist/node-runtime"], "node-runtime");
  assert.match(base.app.security.csp, /connect-src 'none'/);
  assert.equal(windows.app, undefined, "platform packaging must not replace the app security configuration");
});

test("Windows icon is a real multi-size ICO derivative", async () => {
  const bytes = await readFile(new URL("../src-tauri/icons/icon.ico", import.meta.url));
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  assert.ok(bytes.readUInt16LE(4) > 1);
  const count = bytes.readUInt16LE(4);
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const size = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
    assert.ok(offset >= 6 + count * 16 && size > 0 && offset + size <= bytes.length);
  }
});

test("Windows distribution keeps the reviewed vendor notices exact and available offline", async () => {
  const windows = await load("tauri.windows.conf.json");
  assert.equal(windows.bundle.licenseFile, "../licenses/windows/INSTALLER-LICENSE.txt");
  assert.equal(windows.bundle.resources["../licenses/windows/"], "licenses/windows/");
  const root = new URL("../../../", import.meta.url);
  const record = JSON.parse(await readFile(new URL("docs/WINDOWS_VENDOR_RUNTIME.json", root), "utf8"));
  const pin = JSON.parse(await readFile(new URL("scripts/windows-installer-payload-pin.json", root), "utf8"));
  assert.equal(record.classification.sha256, pin.payload.sha256);
  assert.equal(record.classification.runtimePayloadVersion, pin.payload.containedRuntimeVersion);
  assert.equal(record.includedOfflineResources.length, 8);
  for (const resource of record.includedOfflineResources) {
    assert.match(resource.relativePath, /^apps\/desktop\/licenses\/windows\/[A-Za-z0-9./_-]+$/);
    assert.ok(!resource.relativePath.includes(".."));
    const bytes = await readFile(new URL(resource.relativePath, root));
    assert.equal(bytes.length, resource.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), resource.sha256, resource.relativePath);
  }
  const terms = await readFile(new URL("apps/desktop/licenses/windows/INSTALLER-LICENSE.txt", root), "utf8");
  const motionLicence = await readFile(new URL("LICENSE", root), "utf8");
  assert.ok(terms.replaceAll("\r\n", "\n").includes(motionLicence.replaceAll("\r\n", "\n").trim()),
    "The original Motion licence remains complete across platform checkout line endings");
  const template = await readFile(new URL("apps/desktop/src-tauri/windows/installer.nsi", root), "utf8");
  const licencePage = template.indexOf('!insertmacro MUI_PAGE_LICENSE "${LICENSE}"');
  assert.ok(licencePage > 0 && licencePage < template.indexOf("Section WebView2"));
  const attributes = await readFile(new URL(".gitattributes", root), "utf8");
  assert.match(attributes, /^apps\/desktop\/licenses\/windows\/\*\* -text$/m);
  assert.match(attributes, /^apps\/desktop\/src-tauri\/windows\/\*\* -text$/m);
});
