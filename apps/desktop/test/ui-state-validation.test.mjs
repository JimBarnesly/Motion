import assert from "node:assert/strict";
import test from "node:test";

import { isValidUiState, survivingCollapsedBlockIds } from "../ui-state-validation.mjs";

test("runner UI state accepts only bounded ephemeral fields and rejects embedded canonical snapshots", () => {
  assert.equal(isValidUiState({ workspaceId: "workspace-1", activePageId: null, expandedPageIds: ["page-1"], activeViewIds: { "database-1": "view-1" } }), true);
  for (const invalid of [
    { workspace: { schemaVersion: 2, pages: [], databases: [] }, workspaceId: "workspace-1", activePageId: null, expandedPageIds: [] },
    { pages: [] },
    { databases: [] },
    { attachments: [] },
    { linkIndex: [] },
    { blocks: [] },
    { document: { schemaVersion: 2 } },
    { workspaceId: "workspace-1", expandedPageIds: ["page-1", "page-1"] },
    { workspaceId: "workspace-1", expandedPageIds: Array.from({ length: 257 }, (_, index) => `page-${index}`) },
    { workspaceId: "workspace-1", activeViewIds: { "bad/id": "view-1" } },
    { workspaceId: "workspace-1", activeViewIds: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`database-${index}`, `view-${index}`])) },
    { workspaceId: "workspace-1", activePageId: "bad/id" },
  ]) assert.equal(isValidUiState(invalid), false);
});

test("folded IDs are optional bounded UI preferences, filtered against actual toggles", () => {
  assert.equal(isValidUiState({ collapsedBlockIds: ["outer", "nested"] }), true);
  for (const value of [null, "outer", [null], new Array(1), ["outer\n"], ["outer\u2028"], ["bad/id"], ["outer", "outer"], Array.from({ length: 257 }, (_, i) => `b-${i}`)]) {
    assert.equal(isValidUiState({ collapsedBlockIds: value }), false);
  }
  const workspace = { pages: [{ blocks: [{ id: "outer", type: "toggle", children: [{ id: "nested", type: "toggle", children: [] }, { id: "note", type: "callout", children: [] }] }] }] };
  assert.deepEqual(survivingCollapsedBlockIds(workspace, ["outer", "missing", "nested", "note"]), ["outer", "nested"]);
  assert.deepEqual(survivingCollapsedBlockIds(workspace), []);
  assert.throws(() => survivingCollapsedBlockIds(workspace, ["outer", "outer"]), /Invalid/);
});
