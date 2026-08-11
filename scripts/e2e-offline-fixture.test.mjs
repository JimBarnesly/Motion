import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { e2eSpecsFromTracked, trackedE2eSpecs, validateFixtureBindings, validateNoUnprotectedContexts } from "./e2e-confinement-contract.mjs";

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
  assert.doesNotThrow(
    () => validateFixtureBindings('import { test as protectedTest, expect as protectedExpect } from "./fixtures";\nprotectedTest("safe alias", () => protectedExpect(true));')
  );
  assert.throws(
    () => validateFixtureBindings('import { test, expect } from "./fixtures";\nimport { test as direct } from "@playwright/test";\ntest("bypass", () => expect(direct));'),
    /direct @playwright\/test import/
  );
  assert.throws(
    () => validateFixtureBindings('import { test, expect } from "./fixtures";\nfunction test() {}\ntest("shadowed", () => expect(true));'),
    /shadows the fixture-bound test/
  );
  assert.throws(
    () => validateFixtureBindings('import { test, expect } from "./fixtures";\nconst expect = () => true;\ntest("shadowed", () => expect(true));'),
    /shadows the fixture-bound expect/
  );
  assert.throws(
    () => validateFixtureBindings('import { test, expect } from "./fixtures";\nfunction nested(test) { test(); }\ntest("shadowed parameter", () => expect(true));'),
    /shadows the fixture-bound test/
  );
  assert.throws(
    () => validateFixtureBindings('import { test as protectedTest, type Page } from "./fixtures";\nprotectedTest("missing expect", () => {});'),
    /must bind expect/
  );
  assert.throws(
    () => validateFixtureBindings('import { expect as protectedExpect } from "./fixtures";\nprotectedExpect(true);'),
    /must bind test/
  );
  for (const direct of [
    'import * as direct from "@playwright/test";',
    'const direct = require("@playwright/test");',
    'const direct = await import("@playwright/test");',
    'import { chromium as engine } from "playwright-core";'
  ]) assert.throws(
    () => validateFixtureBindings(`${direct}\nimport { test, expect } from "./fixtures";\ntest("direct", () => expect(true));`),
    /Playwright directly|direct @playwright\/test import/
  );
});

test("every browser acceptance spec binds and uses the suite-wide fixture", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(root.scripts?.["test:e2e-offline-fixture"], "node --test scripts/e2e-offline-fixture.test.mjs");
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /^\s*run:\s+npm run test:e2e-offline-fixture\s*$/m);

  const specs = trackedE2eSpecs();
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    const source = await readFile(spec, "utf8");
    validateFixtureBindings(source, spec);
  }
});

test("tracked Playwright specs cannot hide outside the recursive configured glob", () => {
  assert.deepEqual(e2eSpecsFromTracked(["e2e/root.spec.ts", "e2e/nested/deep.spec.ts"]),
    ["e2e/nested/deep.spec.ts", "e2e/root.spec.ts"]);
  assert.throws(
    () => e2eSpecsFromTracked(["e2e/covered.spec.ts", "browser-tests/hidden.spec.ts"]),
    /must live below e2e/
  );
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
  assert.match(config, /testDir\s*:\s*["']\.\/e2e["']/);
  assert.match(config, /testMatch\s*:\s*["']\*\*\/\*\.spec\.ts["']/);
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
  for (const source of [
    'await browser["newContext"]();',
    "await browser[`newContext`]();",
    "const method = 'newContext'; await browser[method]();",
    "const create = browser.newContext; await create();",
    "await chromium.launch();",
    "await firefox['launchPersistentContext']('/tmp/profile');",
    "await webkit[`launch`]();",
    "const engine = chromium; await engine.launch();",
    "await request.newContext();",
    "await browserType.connectOverCDP(endpoint);"
  ]) assert.throws(
    () => validateNoUnprotectedContexts(source, "bypass.spec.ts"),
    /unprotected BrowserContext|browser launch/
  );
  assert.doesNotThrow(
    () => validateNoUnprotectedContexts("// await browser.newContext();\nawait page.goto('/');")
  );

  const specs = trackedE2eSpecs();
  for (const spec of specs) {
    validateNoUnprotectedContexts(await readFile(spec, "utf8"), spec);
  }
});
