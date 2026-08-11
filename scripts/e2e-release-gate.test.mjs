import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const ciWorkflow = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
const nonReleaseDocument = new URL("docs/NON_RELEASE_E2E.md", root);

function trackedE2eSpecs() {
  return execFileSync("git", ["ls-files", "e2e/*.spec.ts"], {
    cwd: root,
    encoding: "utf8"
  }).trim().split("\n").filter(Boolean);
}

function specsSelectedBy(command, trackedSpecs) {
  const explicitSpecs = trackedSpecs.filter(spec => command.includes(spec));
  const selectsAllConfiguredTests = /^playwright test(?:\s+--[^\s]+)*\s*$/.test(command.trim());
  return selectsAllConfiguredTests ? trackedSpecs : explicitSpecs;
}

test("the release-gated test:e2e command covers every tracked browser spec", () => {
  const command = packageJson.scripts?.["test:e2e"];
  assert.equal(typeof command, "string", "package.json must define a root test:e2e script");
  assert.match(
    ciWorkflow,
    /^\s*run:\s+npm run test:e2e\s*(?:#.*)?$/m,
    "CI must release-gate the root test:e2e script"
  );

  const trackedSpecs = trackedE2eSpecs();
  const selectedSpecs = new Set(specsSelectedBy(command, trackedSpecs));
  const documentedNonReleaseSpecs = existsSync(nonReleaseDocument)
    ? readFileSync(nonReleaseDocument, "utf8")
    : "";
  const uncoveredSpecs = trackedSpecs.filter(spec =>
    !selectedSpecs.has(spec) && !documentedNonReleaseSpecs.includes(`\`${spec}\``)
  );

  assert.deepEqual(
    uncoveredSpecs,
    [],
    `test:e2e omits tracked specs that are not documented as non-release:\n${uncoveredSpecs.join("\n")}`
  );
});
