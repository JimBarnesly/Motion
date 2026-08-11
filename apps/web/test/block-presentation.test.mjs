import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderBlockTypeOption } from "../block-presentation.js";

test("hostile unknown block types cannot break the option value or inject markup", () => {
  const hostileType = 'future"><img src=x onerror=alert(1)>';
  const option = renderBlockTypeOption(hostileType, "Unsupported");

  assert.equal(option, '<option value="future&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">Unsupported</option>');
  assert.doesNotMatch(option, /<img|value="future">/);
});

test("the web renderer and build use the safe block type option boundary", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");

  assert.match(source, /renderBlockTypeOption\(block\.type,BLOCK_LABELS\[block\.type\]\?\?"Unsupported"\)/);
  assert.match(build, /block-presentation\.js/);
});
