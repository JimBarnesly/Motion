import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertSafeCanonicalWorkspaceIds, escapeAttribute } from "../canonical-security.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/canonical-schema-v2-hostile-ids.json", import.meta.url), "utf8"));

function attackedWorkspace(attack) {
  const workspace = structuredClone(fixture.workspace);
  let target = workspace;
  for (const segment of attack.path) target = target[segment];
  if (attack.key !== undefined) {
    target[attack.value] = target[attack.key];
    delete target[attack.key];
  } else {
    let parent = workspace;
    for (const segment of attack.path.slice(0, -1)) parent = parent[segment];
    parent[attack.path.at(-1)] = attack.value;
  }
  return workspace;
}

test("canonical schema-v2 accepts UUID/colon IDs and preserves unknown block data", () => {
  const workspace = structuredClone(fixture.workspace);
  workspace.id = "550e8400-e29b-41d4-a716-446655440000:restored.v2";
  assert.doesNotThrow(() => assertSafeCanonicalWorkspaceIds(workspace));
  assert.equal(workspace.pages[0].blocks[0].type, "future-plugin-widget");
  assert.equal(workspace.pages[0].blocks[0].unknownData.markup, "<opaque>");
});

test("every canonical schema-v2 ID class and reference rejects attribute/delegated-action payloads without echoing them", () => {
  for (const attack of fixture.attacks) {
    let error;
    try { assertSafeCanonicalWorkspaceIds(attackedWorkspace(attack)); }
    catch (caught) { error = caught; }
    assert.ok(error instanceof Error, `${attack.label} was accepted`);
    assert.match(error.message, /unsafe canonical ID/);
    assert.doesNotMatch(error.message, new RegExp(attack.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${attack.label} leaked hostile content`);
  }
});

test("attribute escaping is a separate renderer boundary for canonical IDs", () => {
  const hostile = 'page" data-trash-page="page:root"><button data-open-page="page:root';
  const escaped = escapeAttribute(hostile);
  assert.equal(escaped, "page&quot; data-trash-page=&quot;page:root&quot;&gt;&lt;button data-open-page=&quot;page:root");
  assert.doesNotMatch(escaped, /[<>"']/);
});
