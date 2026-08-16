import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src-tauri/src/lib.rs", import.meta.url);

test("packaged startup authenticates and hardens the data root before spawning the service", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const helper = source.match(/fn prepare_native_data_root[\s\S]*?\n}\n\nfn start_service/)?.[0] ?? "";
  const start = source.match(/fn start_service[\s\S]*?\n}/)?.[0] ?? "";

  assert.match(helper, /symlink_metadata\(data_root\)/);
  assert.match(helper, /O_NOFOLLOW/);
  assert.match(helper, /uid\(\) != effective_uid/);
  assert.match(helper, /matches!\(path_mode, 0o700 \| 0o755 \| 0o775\)/);
  assert.match(helper, /dev\(\).*ino\(\)/s);
  assert.match(helper, /set_permissions\(Permissions::from_mode\(0o700\)\)/);
  assert.match(source, /fn data_root_security_error[\s\S]*?"STORAGE_FAILURE"/);
  assert.match(source, /set its permissions to 700/);
  assert.ok(
    start.indexOf("prepare_native_data_root(data_root)?") < start.indexOf("Command::new(node)"),
    "the authenticated permission repair must precede service spawn",
  );
});
