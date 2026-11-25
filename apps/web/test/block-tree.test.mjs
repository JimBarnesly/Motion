import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceDocument, assertWorkspaceValue } from "../../../packages/core/dist/index.js";
import { cloneBlockSubtree, findBlockLocation } from "../block-tree.js";
import { applyLocalEdit, confirmBrowserEdit } from "../browser-edit-confirmation.js";
import { multilinePasteCommands } from "../markdown-paste.js";

const stamp = "2026-11-25T00:00:00.000Z";
const paragraph = (id, text = id, children = []) => ({ id, type: "paragraph", text, children });
const page = (id, title, blocks = []) => ({ id, title, parentId: null, blocks, createdAt: stamp, updatedAt: stamp });

function fixture() {
  const workspace = {
    schemaVersion: 2, id: "workspace", name: "Tree fixture", createdAt: stamp, updatedAt: stamp,
    pages: [page("page", "Writing", [
      paragraph("outer", "Outer", [
        { id: "source", type: "toggle", text: "[[Target]]", references: [{ pageId: "target-page", start: 0, end: 10 }],
          unknownData: { extension: { sourceId: "source", flags: [true, false] } }, children: [
            { id: "file-child", type: "file", text: "Evidence", attachmentId: "asset", children: [] },
            { id: "branch", type: "callout", text: "Details", children: [
              { id: "opaque-child", type: "future-widget", text: "Opaque", children: [],
                pageId: "target-page", viewId: "view", language: "extension-language",
                references: [{ pageId: "target-page" }], unknownData: { payload: { id: "file-child", values: [1, 2] } } }
            ] }
          ] },
        paragraph("following", "Following")
      ]),
      paragraph("root-tail", "Root tail")
    ]), page("target-page", "Target", [paragraph("elsewhere", "Another page's block")]), page("database-page", "Data")],
    attachments: [{ id: "asset", fileName: "evidence.bin", mediaType: "application/octet-stream", byteLength: 3,
      sha256: "a".repeat(64), path: "a".repeat(64), createdAt: stamp }],
    databases: [{ id: "database", pageId: "database-page", name: "Data", properties: [
      { id: "title-property", name: "Name", type: "title" },
      { id: "status-property", name: "Status", type: "select", options: [{ id: "option", name: "Open" }] }
    ], rows: [{ id: "legacy-row", values: { "title-property": "Legacy", "status-property": "option" }, createdAt: stamp, updatedAt: stamp }],
    views: [{ id: "view", name: "All", type: "table", visiblePropertyIds: ["title-property", "status-property"] }] }],
    linkIndex: []
  };
  return new WorkspaceDocument(workspace).data;
}

function stateFor(workspace = fixture()) {
  return { schemaVersion: 2, revision: 7, activePageId: "page", expandedPageIds: [], activeViewIds: {}, workspace };
}

const duplicate = newBlockId => ({ type: "block.duplicate", payload: { pageId: "page", blockId: "source", newBlockId } });
const blocksFor = workspace => workspace.pages.find(item => item.id === "page").blocks;

test("shared lookup returns the real parent and sibling array without flattening or changing the tree", () => {
  const workspace = fixture(), blocks = blocksFor(workspace), before = structuredClone(workspace);
  const source = findBlockLocation(blocks, "source");
  assert.equal(source.parent, blocks[0]);
  assert.equal(source.blocks, blocks[0].children);
  assert.equal(source.index, 0);
  const nested = findBlockLocation(blocks, "opaque-child");
  assert.equal(nested.parent, source.block.children[1]);
  assert.equal(nested.blocks, source.block.children[1].children);
  assert.equal(findBlockLocation(blocks, "root-tail").parent, null);
  assert.equal(findBlockLocation(blocks, "missing"), null);
  assert.equal(findBlockLocation(undefined, "missing"), null);
  assert.deepEqual(workspace, before);
});

test("subtree cloning matches native deterministic IDs and preserves payloads and external targets", () => {
  const workspace = fixture(), before = structuredClone(workspace);
  const source = findBlockLocation(blocksFor(workspace), "source").block;
  const expected = new WorkspaceDocument(structuredClone(workspace)).duplicateBlock("page", "source", "copy");
  const copy = cloneBlockSubtree(workspace, source, "copy");
  assert.deepEqual(copy, expected);
  assert.deepEqual(copy.children.map(block => block.id), ["copy:0", "copy:1"]);
  assert.equal(copy.children[1].children[0].id, "copy:1.0");
  assert.equal(copy.children[0].attachmentId, "asset");
  assert.equal(copy.children[1].children[0].pageId, "target-page");
  assert.equal(copy.children[1].children[0].viewId, "view");
  assert.deepEqual(copy.references, source.references);
  assert.deepEqual(copy.unknownData, source.unknownData);
  copy.children[1].children[0].unknownData.payload.values.push(3);
  assert.deepEqual(workspace, before, "even later edits to a copy cannot mutate its source");
});

test("standalone and batched browser duplication insert the same complete sibling tree as native commands", async () => {
  for (const batched of [false, true]) {
    const initial = stateFor(), original = structuredClone(initial);
    const expected = new WorkspaceDocument(structuredClone(initial.workspace));
    expected.duplicateBlock("page", "source", "copy");
    const candidate = batched
      ? { type: "block.batch", payload: { commands: [{ type: "block.duplicate", ...duplicate("copy").payload }] } }
      : duplicate("copy");
    const writes = [];
    const actual = await confirmBrowserEdit(initial, candidate, async value => { writes.push(value); }, () => stamp);
    assert.deepEqual(blocksFor(actual.workspace), blocksFor(expected.data));
    assert.deepEqual(blocksFor(actual.workspace)[0].children.map(block => block.id), ["source", "copy", "following"]);
    assert.equal(writes.length, 1);
    assert.equal(actual.revision, initial.revision + 1);
    assert.deepEqual(writes[0], actual);
    assert.deepEqual(initial, original);
    assertWorkspaceValue(actual.workspace);
  }
});

test("duplication rejects collisions with every native stable-identity category before mutation or save", async () => {
  for (const id of ["workspace", "asset", "page", "source", "opaque-child", "elsewhere", "database", "title-property", "option", "legacy-row", "view"]) {
    const initial = stateFor(), before = structuredClone(initial);
    const native = new WorkspaceDocument(structuredClone(initial.workspace)), nativeBefore = structuredClone(native.data);
    assert.throws(() => native.duplicateBlock("page", "source", id), /duplicate ID/);
    assert.deepEqual(native.data, nativeBefore);
    let saves = 0;
    await assert.rejects(confirmBrowserEdit(initial, duplicate(id), async () => { saves += 1; }), /duplicate ID/);
    assert.equal(saves, 0, id);
    assert.deepEqual(initial, before, id);
    assert.throws(() => applyLocalEdit(initial, duplicate(id), stamp), /duplicate ID/);
    assert.deepEqual(initial, before, "the direct reducer must also reject before insertion");
  }
  const initial = stateFor();
  blocksFor(initial.workspace)[1].id = "copy:1.0";
  const before = structuredClone(initial), native = new WorkspaceDocument(structuredClone(initial.workspace));
  assert.throws(() => native.duplicateBlock("page", "source", "copy"), /duplicate ID copy:1\.0/);
  await assert.rejects(confirmBrowserEdit(initial, duplicate("copy"), async () => assert.fail("collision must not be saved")), /duplicate ID copy:1\.0/);
  assert.deepEqual(initial, before);
});

test("root and generated descendant IDs enforce the same 160-character native limit", async () => {
  for (const length of [156, 157, 161]) {
    const initial = stateFor(), native = new WorkspaceDocument(structuredClone(initial.workspace));
    const rootId = "x".repeat(length), before = structuredClone(initial);
    if (length === 156) {
      native.duplicateBlock("page", "source", rootId);
      const actual = await confirmBrowserEdit(initial, duplicate(rootId), async () => {}, () => stamp);
      assert.deepEqual(blocksFor(actual.workspace), blocksFor(native.data));
      assert.equal(findBlockLocation(blocksFor(actual.workspace), `${rootId}:1.0`).block.id.length, 160);
    } else {
      const nativeBefore = structuredClone(native.data);
      assert.throws(() => native.duplicateBlock("page", "source", rootId), /safe canonical ID/);
      assert.deepEqual(native.data, nativeBefore);
      await assert.rejects(confirmBrowserEdit(initial, duplicate(rootId), async () => assert.fail("invalid identity must not be saved")), /safe canonical ID/);
    }
    assert.deepEqual(initial, before);
  }
});

test("all native leaf types reject child-bearing conversion before changing payloads in either browser route", async () => {
  for (const type of ["divider", "image", "file", "bookmark", "child-page", "page-mention", "date-mention", "simple-table", "collection-view"]) {
    const initial = stateFor(), before = structuredClone(initial);
    const native = new WorkspaceDocument(structuredClone(initial.workspace)), nativeBefore = structuredClone(native.data);
    assert.throws(() => native.transformBlock("page", "source", { type }), /cannot contain children/);
    assert.deepEqual(native.data, nativeBefore);
    const command = { type: "block.transform", pageId: "page", blockId: "source", transform: { type } };
    const candidates = [
      { type: command.type, payload: { pageId: command.pageId, blockId: command.blockId, transform: command.transform } },
      { type: "block.batch", payload: { commands: [command] } }
    ];
    for (const candidate of candidates) {
      await assert.rejects(confirmBrowserEdit(initial, candidate, async () => assert.fail("leaf conversion must not be saved")), /cannot contain children/);
      assert.throws(() => applyLocalEdit(initial, candidate, stamp), /cannot contain children/);
      assert.deepEqual(initial, before);
    }
  }
});

test("a legal empty-leaf conversion still matches native content and payload preservation", async () => {
  const initial = stateFor(), native = new WorkspaceDocument(structuredClone(initial.workspace));
  native.transformBlock("page", "root-tail", { type: "divider" });
  const actual = await confirmBrowserEdit(initial, {
    type: "block.transform", payload: { pageId: "page", blockId: "root-tail", transform: { type: "divider" } }
  }, async () => {}, () => stamp);
  assert.deepEqual(blocksFor(actual.workspace), blocksFor(native.data));
});

test("a later guarded failure rolls back the whole browser batch without saving its earlier text change", async () => {
  for (const failure of [
    { type: "block.transform", pageId: "page", blockId: "source", transform: { type: "divider" } },
    { type: "block.duplicate", pageId: "page", blockId: "source", newBlockId: "asset" }
  ]) {
    const initial = stateFor(), before = structuredClone(initial);
    const candidate = { type: "block.batch", payload: { commands: [
      { type: "block.update-content", pageId: "page", blockId: "root-tail", content: { text: "Must not persist", references: [] } },
      failure
    ] } };
    await assert.rejects(confirmBrowserEdit(initial, candidate, async () => assert.fail("failed batch must not be saved")), /cannot contain children|duplicate ID/);
    assert.deepEqual(initial, before);
  }
});

test("a rejected duplicate save leaves the confirmed tree intact and a retry creates exactly one copy", async () => {
  const initial = stateFor(), before = structuredClone(initial);
  await assert.rejects(confirmBrowserEdit(initial, duplicate("copy"), async () => { throw new Error("Controlled write failure"); }), /Controlled write failure/);
  assert.deepEqual(initial, before);
  const actual = await confirmBrowserEdit(initial, duplicate("copy"), async () => {}, () => stamp);
  const native = new WorkspaceDocument(structuredClone(initial.workspace));
  native.duplicateBlock("page", "source", "copy");
  assert.deepEqual(blocksFor(actual.workspace), blocksFor(native.data));
});

function applyNativePaste(document, commands) {
  for (const command of commands) {
    if (command.type === "block.transform") document.transformBlock(command.pageId, command.blockId, command.transform);
    else if (command.type === "block.update-content") document.updateBlockContent(command.pageId, command.blockId, command.content);
    else if (command.type === "block.create") document.createBlock({ pageId: command.pageId, ...command.position }, command.block);
    else assert.fail(`Unexpected paste command ${command.type}`);
  }
}

for (const following of [false, true]) for (const leadingDivider of [false, true]) {
  test(`nested ${leadingDivider ? "leading-divider" : "Markdown"} paste ${following ? "precedes its real sibling" : "appends to its real parent"} with native parity`, async () => {
    const initial = stateFor();
    const active = paragraph("active", "[[Target]] SELECT suffix", [paragraph("preserved-child", "Preserved")]);
    active.references = [{ pageId: "target-page", start: 0, end: 10 }];
    active.unknownData = { imported: { retain: ["all", "fields"] } };
    initial.workspace.pages[0].blocks = [paragraph("outside", "Outside", [
      paragraph("parent", "Parent", [active, ...(following ? [paragraph("following-paste", "Following")] : [])]),
      paragraph("outer-sibling", "Outer sibling")
    ]), paragraph("root-sibling", "Root sibling")];
    initial.workspace.linkIndex = [];
    const before = structuredClone(initial), native = new WorkspaceDocument(structuredClone(initial.workspace));
    let next = 0;
    const commands = multilinePasteCommands({ pageId: "page", blocks: blocksFor(initial.workspace), activeBlockId: "active",
      text: leadingDivider ? "---\n- [x] Tail" : "# Inserted\n- [x] Tail", prefix: "[[Target]] ", suffix: " suffix",
      createId: () => `pasted-${next++}`, resolveReferences: () => [] });
    for (const command of commands.filter(item => item.type === "block.create")) {
      assert.deepEqual(command.position, { parentBlockId: "parent", beforeBlockId: following ? "following-paste" : null });
    }
    applyNativePaste(native, commands);
    const writes = [];
    const actual = await confirmBrowserEdit(initial, { type: "block.batch", payload: { commands } }, async value => { writes.push(value); }, () => stamp);
    assert.equal(writes.length, 1);
    assert.deepEqual(blocksFor(actual.workspace), blocksFor(native.data));
    const parent = findBlockLocation(blocksFor(actual.workspace), "parent").block;
    assert.deepEqual(parent.children.map(block => block.id), ["active", ...(leadingDivider ? ["pasted-0"] : []), "pasted-1", ...(following ? ["following-paste"] : [])]);
    assert.deepEqual(parent.children[0].children, active.children);
    assert.deepEqual(parent.children[0].unknownData, active.unknownData);
    assert.deepEqual(parent.children[0].references, [{ pageId: "target-page" }]);
    assert.equal(findBlockLocation(blocksFor(actual.workspace), "pasted-1").block.text, "Tail suffix");
    assert.deepEqual(blocksFor(actual.workspace).map(block => block.id), ["outside", "root-sibling"]);
    assert.deepEqual(initial, before);
    assertWorkspaceValue(actual.workspace);
  });
}
