import { readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const JavaScriptExtensions = /\.(?:cjs|js|mjs)$/;
const jsonFiles = tracked.filter(file => file.endsWith(".json") && !file.endsWith("package-lock.json"));
const scriptFiles = tracked.filter(file => JavaScriptExtensions.test(file));
const failures = [];

for (const file of scriptFiles) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) failures.push(`${file}:\n${check.stderr.trim()}`);
}

for (const file of jsonFiles) {
  try { JSON.parse(await readFile(file, "utf8")); }
  catch (error) { failures.push(`${file}: ${(error).message}`); }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Lint passed: ${scriptFiles.length} JavaScript files parse and ${jsonFiles.length} JSON files are valid.`);
