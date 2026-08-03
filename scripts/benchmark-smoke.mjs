import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["scripts/benchmark.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, MOTION_BENCH_PAGES: "250", MOTION_BENCH_BLOCKS: "8" },
  encoding: "utf8"
});
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
const report = JSON.parse(result.stdout);
if (report.fixture.pages !== 250 || report.fixture.blocks !== 2000 || !report.integrity || report.hits < 1) {
  throw new Error(`Invalid benchmark smoke report: ${result.stdout}`);
}
await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
await writeFile(new URL("../artifacts/benchmark-smoke.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
