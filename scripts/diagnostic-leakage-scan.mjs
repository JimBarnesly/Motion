#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const canaryIndex = args.indexOf("--canary");
if (canaryIndex < 0 || !args[canaryIndex + 1]) {
  process.stderr.write("Usage: diagnostic-leakage-scan --canary <value> <scoped-artifact>...\n");
  process.exitCode = 2;
} else {
  const canary = args[canaryIndex + 1];
  const files = args.filter((_, index) => index !== canaryIndex && index !== canaryIndex + 1);
  if (files.length === 0) {
    process.stderr.write("Diagnostic leakage scan requires at least one explicitly scoped artifact.\n");
    process.exitCode = 2;
  } else {
    const leaked = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (content.includes(canary)) leaked.push(file);
    }
    if (leaked.length) {
      process.stderr.write(`Diagnostic leakage gate failed: canary found in ${leaked.length} scoped artifact(s).\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Diagnostic leakage gate passed: ${files.length} scoped artifact(s) scanned.\n`);
    }
  }
}
