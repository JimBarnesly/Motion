import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EXTERNAL_ASSETS, WEB_ASSETS } from "../scripts/build-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("every relative runtime module import is present in the production asset manifest", async () => {
  const assets = new Set([...WEB_ASSETS, ...EXTERNAL_ASSETS]);
  for (const file of WEB_ASSETS.filter(name => name.endsWith(".js"))) {
    const source = await readFile(resolve(root, file), "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.\/[^"']+)["']/g)) {
      const dependency = match[1].slice(2);
      assert.ok(assets.has(dependency), `${file} imports ${dependency}, which is absent from the production manifest`);
      await access(resolve(root, dependency));
    }
  }
  assert.ok(assets.has("slash-entry.js"));
});
