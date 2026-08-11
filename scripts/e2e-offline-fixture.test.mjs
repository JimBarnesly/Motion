import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function validateFixtureBindings(source, spec = "spec") {
  const uncommented = withoutComments(source);
  const fixtureImport = uncommented.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/fixtures["']\s*;/);
  assert.ok(fixtureImport, `${spec} must use a named import from ./fixtures`);

  const bindings = fixtureImport[1].split(",").map(binding => binding.trim());
  assert.ok(bindings.includes("test"), `${spec} must bind test from ./fixtures`);
  assert.ok(bindings.includes("expect"), `${spec} must bind expect from ./fixtures`);

  const body = uncommented.replace(fixtureImport[0], "");
  assert.match(body, /\btest\s*(?:\(|\.)/, `${spec} must use the fixture-bound test`);
  assert.match(body, /\bexpect\s*(?:\(|\.)/, `${spec} must use the fixture-bound expect`);
}

function validateNoUnprotectedContexts(source, spec = "spec") {
  const uncommented = withoutComments(source);
  assert.doesNotMatch(uncommented, /\bnewContext\s*\(/, `${spec} creates an unprotected BrowserContext`);
  assert.doesNotMatch(uncommented, /\blaunchPersistentContext\s*\(/, `${spec} creates an unprotected persistent context`);
  assert.doesNotMatch(uncommented, /\bbrowser\s*\.\s*newPage\s*\(/, `${spec} creates an implicit unprotected BrowserContext`);
}

test("fixture import contract rejects comments and unused imports", () => {
  assert.throws(
    () => validateFixtureBindings('const bypass = true; // import { test, expect } from "./fixtures";\ntest("bypass", () => {}); expect(true);'),
    /named import/
  );
  assert.throws(
    () => validateFixtureBindings('import { test, expect } from "./fixtures";\nconst value = true;'),
    /must use the fixture-bound test/
  );
  assert.throws(
    () => validateFixtureBindings('import { test, expect } from "./fixtures";\ntest("missing assertion", () => {});'),
    /must use the fixture-bound expect/
  );
  assert.doesNotThrow(
    () => validateFixtureBindings('import { test, expect } from "./fixtures";\ntest("safe", () => expect(true));')
  );
});

test("every browser acceptance spec binds and uses the suite-wide fixture", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(root.scripts?.["test:e2e-offline-fixture"], "node --test scripts/e2e-offline-fixture.test.mjs");
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /^\s*run:\s+npm run test:e2e-offline-fixture\s*$/m);

  const specs = (await readdir("e2e")).filter(name => name.endsWith(".spec.ts")).sort();
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    const source = await readFile(`e2e/${spec}`, "utf8");
    validateFixtureBindings(source, spec);
  }
});

test("suite-wide BrowserContext policy protects the initial page and every popup", async () => {
  const fixture = await readFile("e2e/fixtures.ts", "utf8");
  assert.match(fixture, /context\.route\(/, "HTTP denial must be installed on the BrowserContext");
  assert.match(fixture, /context\.routeWebSocket\(/, "WebSockets must be routed before transfer on the BrowserContext");
  assert.doesNotMatch(fixture, /async\s*\(\s*\{[^}]*\bpage\b/, "the auto fixture must install routes before creating a Page");
  assert.doesNotMatch(fixture, /page\.on\(["']websocket["']/, "observing only the initial Page is not fail-closed");
  assert.match(fixture, /socket\.connectToServer\(\)/, "only explicitly local WebSockets may connect");
  assert.match(fixture, /socket\.close\(/, "external WebSockets must be closed without server transfer");
  assert.match(fixture, /expect\(externalRequests/);
  assert.match(fixture, /expect\(externalSockets/);
});

test("service workers are blocked so BrowserContext routing cannot be bypassed", async () => {
  const config = await readFile("playwright.config.ts", "utf8");
  assert.match(config, /serviceWorkers\s*:\s*["']block["']/);
});

test("WebSocket locality normalizes schemes and requires the configured host and port", async () => {
  const policy = await import("../e2e/network-policy.mjs");
  assert.equal(policy.isLocalWebSocketUrl("ws://127.0.0.1:4187/socket", "http://127.0.0.1:4187"), true);
  assert.equal(policy.isLocalWebSocketUrl("wss://127.0.0.1:4187/socket", "http://127.0.0.1:4187"), true);
  assert.equal(policy.isLocalWebSocketUrl("ws://127.0.0.1:4188/socket", "http://127.0.0.1:4187"), false);
  assert.equal(policy.isLocalWebSocketUrl("ws://localhost:4187/socket", "http://127.0.0.1:4187"), false);
  assert.equal(policy.isLocalWebSocketUrl("ws://example.test:4187/socket", "http://127.0.0.1:4187"), false);
  assert.equal(policy.isLocalWebSocketUrl("ws://example.test/socket", "http://example.test"), true);
  assert.equal(policy.isLocalWebSocketUrl("wss://example.test/socket", "https://example.test"), true);
  assert.equal(policy.isLocalWebSocketUrl("wss://example.test/socket", "http://example.test"), false);
  assert.equal(policy.isLocalWebSocketUrl("not a URL", "http://127.0.0.1:4187"), false);
});

test("specs cannot create BrowserContexts outside the protected fixture", async () => {
  assert.throws(
    () => validateNoUnprotectedContexts("await browser.newContext();", "bypass.spec.ts"),
    /unprotected BrowserContext/
  );
  assert.throws(
    () => validateNoUnprotectedContexts("await browser.newPage();", "bypass.spec.ts"),
    /implicit unprotected BrowserContext/
  );
  assert.doesNotThrow(
    () => validateNoUnprotectedContexts("// await browser.newContext();\nawait page.goto('/');")
  );

  const specs = (await readdir("e2e")).filter(name => name.endsWith(".spec.ts")).sort();
  for (const spec of specs) {
    validateNoUnprotectedContexts(await readFile(`e2e/${spec}`, "utf8"), spec);
  }
});
