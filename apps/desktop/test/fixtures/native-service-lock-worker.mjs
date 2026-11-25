import { appendFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { acquireNativeServiceLock } from "../../native-service-lock.mjs";

const [dataRoot, mutationPath] = process.argv.slice(2);
try {
  const ownership = await acquireNativeServiceLock(dataRoot);
  process.stdout.write(`${JSON.stringify({ type: "acquired", ...(process.env.MOTION_TEST_EXPOSE_GUARDIAN_PID === "1" ? { guardianPid: ownership.guardianPid } : {}) })}\n`);
  process.on("SIGTERM", async () => { await ownership.release(); process.exit(0); });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async chunk => {
    for (const command of chunk.trim().split(/\s+/)) {
      if (command === "mutate") {
        await appendFile(mutationPath, "revision\n", { flag: "a", mode: 0o600 });
        process.stdout.write(`${JSON.stringify({ type: "mutated" })}\n`);
      } else if (command === "release") {
        await ownership.release();
        process.stdout.write(`${JSON.stringify({ type: "released" })}\n`);
      } else if (command === "block") {
        // Synchronous notification followed immediately by a blocked event loop
        // reproduces SQLite/spawnSync work that cannot observe guardian exit yet.
        writeSync(1, `${JSON.stringify({ type: "blocked" })}\n`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      }
    }
  });
} catch (error) {
  process.stdout.write(`${JSON.stringify({ type: "rejected", code: error?.code, message: error?.message })}\n`);
  process.exitCode = 73;
}
