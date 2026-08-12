import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Linux bundles declare and preflight the lock runtime dependencies", async () => {
  const config = JSON.parse(await readFile(new URL("apps/desktop/src-tauri/tauri.conf.json", root), "utf8"));
  assert.ok(config.bundle.targets.includes("deb"));
  assert.ok(config.bundle.targets.includes("appimage"));
  assert.ok(config.bundle.linux.deb.depends.includes("util-linux"), "deb must provision /usr/bin/flock through util-linux");
  const lockSource = await readFile(new URL("apps/desktop/native-service-lock.mjs", root), "utf8");
  assert.match(lockSource, /const FLOCK_PATH = "\/usr\/bin\/flock"/);
  assert.match(lockSource, /accessSync\(FLOCK_PATH, constants\.X_OK\)/);
  assert.match(lockSource, /statSync\("\/proc\/self\/fd"\).*isDirectory/);
});