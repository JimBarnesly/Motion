import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderBlockTypeOption, renderBlockTypeSelect } from "../block-presentation.js";

test("hostile unknown block types cannot break the option value or inject markup", () => {
  const hostileType = 'future"><img src=x onerror=alert(1)>';
  const option = renderBlockTypeOption(hostileType, "Unsupported");

  assert.equal(option, '<option value="future&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">Unsupported</option>');
  assert.doesNotMatch(option, /<img|value="future">/);
});

test("the web renderer and build use the safe block type option boundary", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");

  assert.match(source, /renderBlockTypeSelect\(\{blockId:block\.id,type:block\.type,types:BLOCK_TYPES,labels:BLOCK_LABELS\}\)/);
  assert.match(build, /block-presentation\.js/);
});

test("block type control visibly names its current canonical type", () => {
  const select = renderBlockTypeSelect({
    blockId: "block-1",
    type: "heading-1",
    types: ["paragraph", "heading-1", "task"],
    labels: { paragraph: "Text", "heading-1": "Heading 1", task: "Task" }
  });

  assert.match(select, /^<select class="block-type-select"/);
  assert.match(select, /aria-label="Block type: Heading 1"/);
  assert.match(select, /<option value="heading-1" selected>Heading 1<\/option>/);
  assert.match(select, /<option value="paragraph">Text<\/option>/);
});

test("block type control keeps hostile preserved types inert", () => {
  const select = renderBlockTypeSelect({
    blockId: 'block\"><img src=x>',
    type: 'future\"><img src=x>',
    types: ["paragraph"],
    labels: { paragraph: "Text" }
  });

  assert.doesNotMatch(select, /<img/);
  assert.match(select, /data-block-type="block&quot;&gt;&lt;img src=x&gt;"/);
  assert.match(select, /Block type: Unsupported/);
});

test("block type control is compact, readable, and gains chrome on interaction", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const baseRule = styles.match(/\.block-type-select\s*\{([^}]*)\}/s)?.[1] ?? "";
  const interactiveRule = styles.match(/\.block-type-select:hover,\.block-type-select:focus\s*\{([^}]*)\}/s)?.[1] ?? "";

  assert.match(baseRule, /field-sizing:\s*content/);
  assert.match(baseRule, /min-width:\s*76px/);
  assert.doesNotMatch(baseRule, /min-width:\s*140px/);
  assert.match(baseRule, /min-height:\s*(?:2[5-9]|[3-9]\d)px/);
  assert.match(baseRule, /color:\s*var\(--muted\)/);
  assert.match(interactiveRule, /border-color:\s*var\(--line\)/);
  assert.match(interactiveRule, /background:\s*var\(--surface\)/);
  assert.match(interactiveRule, /color:\s*var\(--text\)/);
  assert.doesNotMatch(styles, /\.block-row select\s*\{[^}]*color:\s*transparent/s);
});
