import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const checks = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["generic assigned secret", /(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*["'][^"'\n]{12,}["']/i]
];
const findings = [];
for (const file of files) {
  if (/^(?:package-lock\.json|fixtures\/)/.test(file)) continue;
  let source;
  try { source = await readFile(file, "utf8"); } catch { continue; }
  for (const [name, pattern] of checks) if (pattern.test(source)) findings.push(`${file}: possible ${name}`);
}
if (findings.length) {
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log(`Secret scan passed across ${files.length} tracked files.`);
