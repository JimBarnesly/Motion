import assert from "node:assert/strict";
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
