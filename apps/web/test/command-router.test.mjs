import assert from "node:assert/strict";
import test from "node:test";

import { createNativeCommandController } from "../command-router.js";

test("confirmed native edits replace the local snapshot only from the typed command response", async () => {
  const original = { id: "workspace-1", pages: [{ id: "page-1", title: "Before", blocks: [] }], databases: [] };
  const confirmed = { id: "workspace-1", pages: [{ id: "page-1", title: "After", blocks: [] }], databases: [] };
  const calls = [];
  let local = original;
  const controller = createNativeCommandController({
    execute: async (type, payload) => { calls.push({ type, payload }); return { workspace: confirmed, revision: 8, saved: true }; },
    confirm: (workspace, revision) => { local = workspace; assert.equal(revision, 8); },
    currentRevision: () => 7
  });

  await controller.execute("page.rename", { pageId: "page-1", title: "After", workspaceId: "caller-workspace", expectedRevision: 999 });

  assert.deepEqual(calls, [{ type: "page.rename", payload: { pageId: "page-1", title: "After" } }]);
  assert.equal(local, confirmed);
});

test("failed native edits preserve the last confirmed snapshot", async () => {
  const original = { id: "workspace-1", pages: [], databases: [] };
  let local = original;
  const controller = createNativeCommandController({
    execute: async () => { throw new Error("revision conflict"); },
    confirm: workspace => { local = workspace; },
    currentRevision: () => 2
  });

  await assert.rejects(controller.execute("block.update-content", { pageId: "page-1", blockId: "block-1", content: { text: "pending" } }), /revision conflict/);
  assert.equal(local, original);
});

test("normal command router fails closed for import and caller snapshots", async () => {
  const controller = createNativeCommandController({ execute: async () => assert.fail("must not dispatch"), confirm: () => assert.fail("must not confirm"), currentRevision: () => 1 });
  await assert.rejects(controller.execute("workspace.import-web-v1", { document: { schemaVersion: 1, pages: [] } }), /not a normal edit/);
  await assert.rejects(controller.execute("page.rename", { pageId: "page-1", title: "x", document: { schemaVersion: 1, pages: [] } }), /caller snapshot/);
});

test("an out-of-order native response cannot overwrite a newer confirmed snapshot", async () => {
  let revision = 9;
  let local = { id: "workspace-1", marker: "newer" };
  const controller = createNativeCommandController({
    execute: async () => ({ workspace: { id: "workspace-1", marker: "stale" }, revision: 8, saved: true }),
    currentRevision: () => revision,
    confirm: (workspace, confirmedRevision) => { local = workspace; revision = confirmedRevision; }
  });
  await controller.execute("page.rename", { pageId: "page-1", title: "stale" });
  assert.deepEqual(local, { id: "workspace-1", marker: "newer" });
  assert.equal(revision, 9);
});