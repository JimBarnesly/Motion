import { appendFile } from "node:fs/promises";
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
      }
    }
  });
} catch (error) {
  process.stdout.write(`${JSON.stringify({ type: "rejected", code: error?.code, message: error?.message })}\n`);
  process.exitCode = 73;
}
