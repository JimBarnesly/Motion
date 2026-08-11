import assert from "node:assert/strict";
import test from "node:test";

import { isValidUiState } from "../ui-state-validation.mjs";

test("runner UI state accepts only bounded ephemeral fields and rejects embedded canonical snapshots", () => {
  assert.equal(isValidUiState({ workspaceId: "workspace-1", activePageId: null, expandedPageIds: ["page-1"] }), true);
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
    { workspaceId: "workspace-1", activePageId: "bad/id" },
  ]) assert.equal(isValidUiState(invalid), false);
});
