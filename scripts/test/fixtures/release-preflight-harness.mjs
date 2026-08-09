import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGateChain } from "../../release-security-preflight.mjs";

const names = ["secret", "unsafe-default", "diagnostic-leakage", "runtime-confinement", "backup-integrity", "release-manifest"];
const tampered = process.argv[2]; const canary = process.argv[3] ?? "PRIVATE_CANARY_SHOULD_NOT_ESCAPE"; const worker = new URL("./release-preflight-gate.mjs", import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), "motion-preflight-harness-"));
try {
  const gates = names.map(name => ({ name, command: process.execPath, args: [worker, name === tampered ? "leak" : "pass", canary], env: { npm_config_offline: "true" } }));
  const result = await executeGateChain(gates, join(root, "evidence.json"));
  process.exitCode = result.verdict === "PASS" ? 0 : 1;
} finally { await rm(root, { recursive: true, force: true }); }
