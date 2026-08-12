import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = JSON.parse(await readFile("package.json", "utf8"));
const ci = await readFile(".github/workflows/ci.yml", "utf8");
const lane = await readFile("scripts/m2-packaged-acceptance.mjs", "utf8").catch(() => "");

test("M2 packaged acceptance is a declared, release-gated contract", () => {
  assert.equal(root.scripts?.["test:m2-acceptance-contract"], "node --test scripts/m2-acceptance-contract.test.mjs");
  assert.equal(root.scripts?.["acceptance:m2:packaged"], "node scripts/m2-packaged-acceptance.mjs");
  assert.match(ci, /^\s*run:\s+npm run test:m2-acceptance-contract\s*$/m);
  assert.match(ci, /^\s*run:\s+npm run acceptance:m2:packaged -- apps\/desktop\/src-tauri\/target\/release\/bundle\/appimage\/\*\.AppImage\s*$/m);
});

test("the packaged lane is fail-diagnostic and denies network in its extracted runtime", () => {
  assert.match(lane, /M2_ACCEPTANCE_REPORT/);
  assert.match(lane, /scripts\/deny-network\.cjs/);
  assert.match(lane, /source-test/);
  assert.match(lane, /packaged-local/);
  assert.match(lane, /external-graphical/);
  assert.match(lane, /sourceFailures/);
  assert.match(lane, /diagnostic/);
  assert.match(lane, /\[stderr, stdout\]/);
  assert.match(lane, /AppImage not found/);
  assert.match(lane, /attachment\.ingest-block/);
  assert.match(lane, /page\.backlinks/);
  assert.match(lane, /backup\.restore-new/);
});
