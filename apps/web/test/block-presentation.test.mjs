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

test("block type control announces its current type from a contextual gutter handle", () => {
  const select = renderBlockTypeSelect({
    blockId: "block-1",
    type: "heading-1",
    types: ["paragraph", "heading-1", "task"],
    labels: { paragraph: "Text", "heading-1": "Heading 1", task: "Task" }
  });

  assert.match(select, /^<label class="block-type-control"/);
  assert.match(select, /data-block-type-label="Heading 1"/);
  assert.match(select, /title="Change Heading 1 block type"/);
  assert.match(select, /<span class="block-type-handle" aria-hidden="true">⋮⋮<\/span>/);
  assert.match(select, /<select class="block-type-select"/);
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

test("block type control stays out of the reading column until its row is active", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const controlRule = styles.match(/\.block-type-control\s*\{([^}]*)\}/s)?.[1] ?? "";
  const selectRule = styles.match(/\.block-type-select\s*\{([^}]*)\}/s)?.[1] ?? "";
  const revealRule = styles.match(/\.block-row:hover \.block-type-control,\.block-row:focus-within \.block-type-control\s*\{([^}]*)\}/s)?.[1] ?? "";
  const focusRule = styles.match(/\.block-type-control:focus-within\s*\{([^}]*)\}/s)?.[1] ?? "";

  assert.match(controlRule, /width:\s*28px/);
  assert.match(controlRule, /height:\s*28px/);
  assert.match(controlRule, /opacity:\s*0/);
  assert.doesNotMatch(controlRule, /min-width:\s*(?:76|140)px/);
  assert.match(selectRule, /position:\s*absolute/);
  assert.match(selectRule, /inset:\s*0/);
  assert.match(selectRule, /opacity:\s*0/);
  assert.match(revealRule, /opacity:\s*1/);
  assert.match(focusRule, /outline:\s*2px solid var\(--accent\)/);
});
