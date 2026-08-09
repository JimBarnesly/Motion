#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const dependency = spawnSync(process.execPath, ["scripts/dependency-release-gate.mjs", ...process.argv.slice(2)], { encoding: "utf8" });
if (dependency.status !== 0) { process.stderr.write("Release candidate integrity failed: dependency inventory rejected the candidate.\n"); process.exit(1); }
const manifestArgs = process.argv.slice(2).filter((value, index, values) => !["--root", "--report"].includes(values[index - 1]) && !["--root", "--report"].includes(value));
const manifest = spawnSync(process.execPath, ["scripts/verify-release-structure.mjs", ...manifestArgs], { encoding: "utf8" });
if (manifest.status !== 0) { process.stderr.write("Release candidate integrity failed: release manifest rejected the candidate.\n"); process.exit(1); }
process.stdout.write("Release candidate dependency inventory and manifest passed.\n");
