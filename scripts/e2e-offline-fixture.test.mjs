import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("every browser acceptance spec uses the suite-wide offline fixture", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(root.scripts?.["test:e2e-offline-fixture"], "node --test scripts/e2e-offline-fixture.test.mjs");
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /run: npm run test:e2e-offline-fixture/);

  const specs = (await readdir("e2e")).filter(name => name.endsWith(".spec.ts")).sort();
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    const source = await readFile(`e2e/${spec}`, "utf8");
    assert.match(source, /from ["']\.\/fixtures["']/, `${spec} bypasses the offline fixture`);
  }

  const fixture = await readFile("e2e/fixtures.ts", "utf8");
  assert.match(fixture, /context\.route/);
  assert.match(fixture, /externalRequests/);
  assert.match(fixture, /page\.on\(["']websocket["']/);
  assert.match(fixture, /externalSockets/);
  assert.match(fixture, /expect\(externalRequests/);
  assert.match(fixture, /expect\(externalSockets/);
});
