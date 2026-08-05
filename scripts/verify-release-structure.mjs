#!/usr/bin/env node
import { resolve } from "node:path";
import { verifyReleaseStructure } from "./release-structure.mjs";

const readArg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
try {
  const directory = resolve(readArg("--directory") ?? "artifacts/release");
  const result = await verifyReleaseStructure({ directory, expectedVersion: readArg("--version"), expectedCommit: readArg("--commit"), expectedRepository: readArg("--repository") });
  process.stdout.write(`Pre-sign structure verified for ${result.names.length} Motion ${readArg("--version")} artifacts at ${readArg("--commit")}.\n`);
} catch (error) {
  process.stderr.write(`Pre-sign release verification failed: ${error.message}\n`); process.exit(1);
}
