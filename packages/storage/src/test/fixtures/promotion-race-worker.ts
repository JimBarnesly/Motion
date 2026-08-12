import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { rename, writeFile } from "node:fs/promises";

const root = process.argv[2]!;
let stagedPath = "";
let replacementInstalled = false;

const { ContentAddressedAttachmentStore } = await import("../../index.js");
const store = new ContentAddressedAttachmentStore(root, { beforeAttachmentPublish: async () => {
  replacementInstalled = true;
  await rename(stagedPath, `${stagedPath}.authenticated`);
  await writeFile(stagedPath, Buffer.from("attacker pathname replacement"), { flag: "wx", mode: 0o600 });
} });
const trusted = Buffer.from("trusted staged attachment");
const staged = await store.stage(trusted);
stagedPath = staged.stagingPath;

await assert.rejects(store.promote(staged));
assert.equal(replacementInstalled, true, "fixture did not replace the pathname after descriptor validation");
try { assert.deepEqual(await fsPromises.readFile(staged.path), trusted, "attacker replacement was published"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
assert.deepEqual(await fsPromises.readFile(`${stagedPath}.authenticated`), trusted);
