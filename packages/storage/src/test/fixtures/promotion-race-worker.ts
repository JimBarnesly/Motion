import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2]!;
const bin = fileURLToPath(new URL("./promotion-race-bin", import.meta.url));

if (process.env.MOTION_PROMOTION_RACE_CHILD !== "1") {
  const fakeLn = join(bin, "ln");
  await mkdir(bin, { mode: 0o700 });
  await writeFile(fakeLn, `#!/bin/sh
STAGING_ROOT="$MOTION_FIXTURE_ATTACHMENT_ROOT/.staging"
STAGED_PATH=$(find "$STAGING_ROOT" -maxdepth 1 -type f -name '*.staging' -print -quit)
[ -n "$STAGED_PATH" ] || exit 90
mv "$STAGED_PATH" "$STAGED_PATH.authenticated" || exit 91
printf 'attacker pathname replacement' > "$STAGED_PATH" || exit 92
chmod 600 "$STAGED_PATH" || exit 93
exec /usr/bin/ln "$@"
`, { mode: 0o700 });
  await chmod(fakeLn, 0o700);
  const child = spawnSync(process.execPath, [process.argv[1]!, root], { encoding: "utf8", env: {
    ...process.env,
    MOTION_PROMOTION_RACE_CHILD: "1",
    MOTION_FIXTURE_ATTACHMENT_ROOT: root,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`
  } });
  assert.equal(child.status, 0, `inner race worker failed:\n${child.stdout}\n${child.stderr}`);
  await rm(bin, { recursive: true, force: true });
} else {
  const { ContentAddressedAttachmentStore } = await import("../../index.js");
  const store = new ContentAddressedAttachmentStore(root);
  const trusted = Buffer.from("trusted staged attachment");
  const staged = await store.stage(trusted);

  await assert.rejects(store.promote(staged), /staging changed/i);
  const stagingNames = await readdir(join(root, ".staging"));
  const authenticatedName = stagingNames.find(name => name.endsWith(".authenticated"));
  assert.ok(authenticatedName, "fixture did not replace the pathname during descriptor publication");
  assert.deepEqual(await readFile(join(root, ".staging", authenticatedName)), trusted);
  assert.deepEqual(await readFile(join(root, ".staging", authenticatedName.replace(/\.authenticated$/, ""))), Buffer.from("attacker pathname replacement"));
  try { assert.deepEqual(await readFile(staged.path), trusted, "attacker replacement was published"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
