import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryWorkspaceStore,
  WorkspaceDocument,
  assertWorkspace,
  createWorkspace,
  exportWorkspaceJson,
  migrateWorkspace
} from "@motion/core";

function random(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function fixture(seed) {
  const next = random(seed);
  const workspace = createWorkspace(`Fixture ${seed}`);
  const document = new WorkspaceDocument(workspace);
  const pages = [];
  for (let index = 0; index < 30; index += 1) {
    const candidates = [null, ...pages.map(page => page.id)];
    const parentId = candidates[Math.floor(next() * candidates.length)];
    const page = document.addPage(`Page ${index}`, parentId);
    document.addBlock(page.id, {
      type: index % 7 === 0 ? `future-block-${index}` : "paragraph",
      text: `seed=${seed} value=${Math.floor(next() * 10_000)}`,
      unknownData: index % 7 === 0 ? { preserved: true, seed } : undefined
    });
    pages.push(page);
  }
  return workspace;
}

test("deterministic randomized workspaces survive canonical JSON round trips", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const original = fixture(seed);
    const encoded = exportWorkspaceJson(original);
    const decoded = migrateWorkspace(JSON.parse(encoded));
    assertWorkspace(decoded);
    assert.equal(exportWorkspaceJson(decoded), encoded, `seed ${seed}`);
    assert.deepEqual(decoded.pages.map(page => page.id), original.pages.map(page => page.id));
  }
});

test("random hierarchy moves either preserve a tree or reject a cycle", () => {
  for (let seed = 100; seed < 120; seed += 1) {
    const workspace = fixture(seed);
    const document = new WorkspaceDocument(workspace);
    const next = random(seed);
    for (let operation = 0; operation < 50; operation += 1) {
      const page = workspace.pages[Math.floor(next() * workspace.pages.length)];
      const parent = next() < 0.15 ? null : workspace.pages[Math.floor(next() * workspace.pages.length)].id;
      try {
        document.movePage(page.id, parent);
        assertWorkspace(workspace);
      } catch (error) {
        assert.match(String(error), /cycles/);
      }
    }
  }
});

test("storage isolation and repeated save/load are lossless", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = fixture(4242);
  const expected = exportWorkspaceJson(workspace);
  for (let pass = 0; pass < 10; pass += 1) {
    await store.save(workspace);
    const loaded = await store.load(workspace.id);
    assert.ok(loaded);
    assert.equal(exportWorkspaceJson(loaded), expected);
    loaded.name = "must not leak into store";
  }
});
