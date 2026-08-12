import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runWithTimeout, startJsonLineService } from "./m2-process-control.mjs";

const root = JSON.parse(await readFile("package.json", "utf8"));
const ci = await readFile(".github/workflows/ci.yml", "utf8");
const lane = await readFile("scripts/m2-packaged-acceptance.mjs", "utf8").catch(() => "");
const processControl = await readFile("scripts/m2-process-control.mjs", "utf8").catch(() => "");

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
  assert.match(lane, /runWithTimeout/);
  assert.match(lane, /startJsonLineService/);
  assert.match(processControl, /\[stderr, stdout\]/);
  assert.match(processControl, /timed out after/);
  assert.match(lane, /AppImage not found/);
  assert.match(lane, /attachment\.ingest-block/);
  assert.match(lane, /page\.backlinks/);
  assert.match(lane, /backup\.restore-new/);
});

test("packaged acceptance subprocesses fail diagnostically instead of hanging", async () => {
  await assert.rejects(
    runWithTimeout(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 25 }),
    /timed out after 25ms/
  );

  const exited = startJsonLineService(process.execPath, ["-e", "process.stdin.resume(); process.stdin.once('data', () => process.exit(0))"], {
    requestTimeoutMs: 250
  });
  await assert.rejects(exited.request("query", {}), /exited 0 before replying/);

  const stalled = startJsonLineService(process.execPath, ["-e", "process.stdin.resume()"], { requestTimeoutMs: 25 });
  await assert.rejects(stalled.request("query", {}), /request timed out after 25ms/);
  await stalled.terminate();
});

test("timed subprocess cleanup terminates descendant processes", async () => {
  let error;
  try {
    await runWithTimeout(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(` + "`DESCENDANT=${descendant.pid}`" + `);
      setInterval(() => {}, 1000);
    `], { timeoutMs: 100 });
  } catch (caught) { error = caught; }
  assert.match(error?.message ?? "", /timed out after 100ms/);
  const descendantPid = Number(error.message.match(/DESCENDANT=(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(descendantPid));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.throws(() => process.kill(descendantPid, 0), error => error?.code === "ESRCH");
});

test("packaged service cleanup survives spawn errors and unsolicited malformed output", async () => {
  const missing = startJsonLineService("/definitely/missing/motion-node", [], { requestTimeoutMs: 25 });
  await assert.rejects(missing.request("query", {}), /ENOENT/);
  await Promise.race([
    missing.terminate(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("spawn-error cleanup hung")), 100))
  ]);

  const malformed = startJsonLineService(process.execPath, ["-e", "console.log('{bad json'); process.stdin.resume()"], {
    requestTimeoutMs: 250
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  await assert.rejects(malformed.request("query", {}), /invalid JSON|already exited/);
  await malformed.terminate();
});
