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

test("canonical renderer classes retain heading, list, and unsupported-block presentation", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8")
  ]);
  const supportedTypes = JSON.parse(source.match(/const BLOCK_TYPES = (\[[^\]]+\]);/)?.[1] ?? "[]");
  const rule = selector => [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(",").map(value => value.trim()).includes(selector))
    .map(([, , declarations]) => declarations).join(";");

  // The renderer uses canonical type names directly; the stylesheet must match
  // those names rather than the legacy aliases accepted during migration.
  assert.match(source, /class="block-input \$\{type\}"/);
  assert.match(source, /BLOCK_TYPES\.includes\(block\.type\)\?block\.type:"unsupported"/);
  for (const [type, size] of [["heading-1", 28], ["heading-2", 23], ["heading-3", 19]]) {
    assert.ok(supportedTypes.includes(type));
    assert.match(rule(`.block-input.${type}`), new RegExp(`font-size:\\s*${size}px`));
    assert.match(rule(`.block-input.${type}`), /font-weight:\s*[67]\d\d/);
  }
  assert.ok(supportedTypes.includes("bulleted-list"));
  assert.ok(supportedTypes.includes("numbered-list"));
  assert.match(rule(".block-input.bulleted-list::before"), /content:\s*"• "/);
  assert.match(rule(".block-input.numbered-list::before"), /content:\s*attr\(data-list-number\)\s*"\. "/);
  // File blocks currently share the unsupported row class, but render supported
  // file content. Warn only when the content renderer itself is unsupported.
  assert.match(rule(".block-row.unsupported:has(> .block-input.unsupported)"), /border:\s*1px dashed/);
  assert.match(rule(".block-row.unsupported:has(> .block-input.unsupported)::before"), /Preserved unsupported block/);
  assert.equal(rule(".block-row.unsupported"), "");
});

test("sibling-derived numbered markers render without empty placeholders hiding list markers", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(styles, /content:attr\(data-list-number\)/);
  assert.doesNotMatch(styles, /counter-increment:\s*motion-list-number/);
  assert.doesNotMatch(styles, /\.block-input\.numbered-list::before\s*\{[^}]*content:\s*"1\. "/);
  assert.doesNotMatch(styles, /\.block-input:empty::before\s*\{/);
  assert.match(styles, /\.block-input:not\(\.bulleted-list\):not\(\.numbered-list\):empty::before\s*\{[^}]*content:attr\(data-placeholder\)/);
});
