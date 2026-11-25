import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceDocument } from "../../../packages/core/dist/index.js";
import { blockLocations, expandedForBlock, findBlockLocation, numberedSiblingPosition, survivingCollapsedBlockIds, visibleBlockLocations } from "../block-tree.js";
import { confirmBrowserEdit } from "../browser-edit-confirmation.js";
import { splitBlockCommands } from "../editor-structure.js";
import { editorHistoryCommand, editorHistoryUnchanged } from "../editor-history.js";
import { multilinePasteCommands } from "../markdown-paste.js";

const stamp = "2026-11-25T00:00:00.000Z";
const block = (id, type = "paragraph", text = id, children = []) => ({ id, type, text, children });
function fixture(type = "toggle") {
  return { schemaVersion: 2, revision: 3, activePageId: "page", expandedPageIds: [], activeViewIds: {}, collapsedBlockIds: [],
    workspace: { schemaVersion: 2, id: "workspace", name: "Containers", createdAt: stamp, updatedAt: stamp, databases: [], attachments: [], linkIndex: [], pages: [
      { id: "page", title: "Writing", parentId: null, createdAt: stamp, updatedAt: stamp, blocks: [
        block("outer", "toggle", "Outer", [block("header", type, "[[Target]] SELECT [[Target]]", [
          { ...block("kept", "future-widget", "Preserved"), unknownData: { opaque: { values: [true, 3] } } }
        ]), block("sibling")]), block("tail")
      ] }, { id: "target", title: "Target", parentId: null, createdAt: stamp, updatedAt: stamp, blocks: [] }
    ] } };
}
function nativeApply(document, commands) {
  for (const command of commands) {
    if (command.type === "block.update-content") document.updateBlockContent(command.pageId, command.blockId, command.content);
    else if (command.type === "block.create") document.createBlock({ pageId: command.pageId, ...command.position }, command.block);
    else assert.fail(`Unexpected command ${command.type}`);
  }
}

for (const type of ["toggle", "callout"]) {
  test(`${type} Enter creates a first paragraph child in one confirmed batch with native parity`, async () => {
    const initial = fixture(type), header = findBlockLocation(initial.workspace.pages[0].blocks, "header").block;
    header.references = [{ pageId: "target", start: 0, end: 10 }, { pageId: "target", start: 18, end: 28 }];
    const before = structuredClone(initial);
    const split = splitBlockCommands({ pageId: "page", block: header, offset: 11, endOffset: 18,
      parentBlockId: "outer", beforeBlockId: "sibling", createId: () => "new-child" });
    assert.deepEqual(split.commands[1].position, { parentBlockId: "header", beforeBlockId: "kept" });
    const native = new WorkspaceDocument(structuredClone(initial.workspace));
    nativeApply(native, split.commands);
    let writes = 0;
    const actual = await confirmBrowserEdit(initial, { type: "block.batch", payload: { commands: split.commands } }, async () => { writes++; }, () => stamp);
    const result = findBlockLocation(actual.workspace.pages[0].blocks, "header").block;
    assert.equal(result.id, "header");assert.equal(result.type, type);assert.equal(result.text, "[[Target]] ");
    assert.deepEqual(result.references, [{ pageId: "target", start: 0, end: 10 }]);
    assert.deepEqual(result.children[0], { id: "new-child", type: "paragraph", text: "[[Target]]", references: [{ pageId: "target", start: 0, end: 10 }], children: [] });
    assert.deepEqual(result.children[1], before.workspace.pages[0].blocks[0].children[0].children[0]);
    assert.deepEqual(actual.workspace.pages[0].blocks, native.data.pages[0].blocks);
    assert.equal(writes, 1);assert.equal(actual.revision, 4);assert.deepEqual(initial, before);
    await assert.rejects(confirmBrowserEdit(initial, { type: "block.batch", payload: { commands: split.commands } }, async () => { throw new Error("disk failure"); }), /disk failure/);
    assert.deepEqual(initial, before);
  });

  test(`${type} header paste retains its type, old children, selected suffix references and native placement`, async () => {
    const initial = fixture(type), header = findBlockLocation(initial.workspace.pages[0].blocks, "header").block;
    header.references = [{ pageId: "target", start: 0, end: 10 }, { pageId: "target", start: 18, end: 28 }];
    let next = 0;
    const commands = multilinePasteCommands({ pageId: "page", blocks: initial.workspace.pages[0].blocks, activeBlockId: "header",
      prefix: "[[Target]] ", suffix: "[[Target]]", text: "# literal header\n- [x] Child\n---", createId: () => `inserted-${next++}`, resolveReferences: () => [] });
    const native = new WorkspaceDocument(structuredClone(initial.workspace));nativeApply(native, commands);
    const actual = await confirmBrowserEdit(initial, { type: "block.batch", payload: { commands } }, async () => {}, () => stamp);
    const result = findBlockLocation(actual.workspace.pages[0].blocks, "header").block;
    assert.equal(result.type, type);assert.equal(result.text, "[[Target]] # literal header");
    assert.deepEqual(result.children.map(child => [child.id, child.type, child.text]), [["inserted-0", "task", "Child"], ["inserted-1", "divider", ""], ["inserted-2", "paragraph", "[[Target]]"], ["kept", "future-widget", "Preserved"]]);
    assert.deepEqual(result.children[2].references, [{ pageId: "target", start: 0, end: 10 }]);
    assert.deepEqual(actual.workspace.pages[0].blocks, native.data.pages[0].blocks);
    header.unknownData = { extension: true };
    assert.equal(splitBlockCommands({ pageId: "page", block: header, offset: 0, createId: () => "unused" }), null);
    assert.throws(() => multilinePasteCommands({ pageId: "page", blocks: initial.workspace.pages[0].blocks, activeBlockId: "header", text: "One\nTwo", createId: () => "unused" }), /extension data/);
  });
}

test("visible projection, ancestor reveal and numbering use actual sibling trees without modifying content", () => {
  const initial = fixture(), blocks = initial.workspace.pages[0].blocks, before = structuredClone(initial);
  assert.deepEqual(visibleBlockLocations(blocks, ["outer"]).map(item => item.block.id), ["outer", "tail"]);
  assert.deepEqual(visibleBlockLocations(blocks, ["header"]).map(item => item.block.id), ["outer", "header", "sibling", "tail"]);
  assert.deepEqual(expandedForBlock(blocks, "kept", ["outer", "header", "unrelated"]), ["unrelated"]);
  assert.deepEqual(survivingCollapsedBlockIds(initial.workspace, ["outer", "header", "kept", "missing", "header"]), ["outer", "header"]);
  assert.deepEqual(findBlockLocation(blocks, "kept").ancestors.map(item => item.id), ["outer", "header"]);
  assert.deepEqual(initial, before);
  const numbered = [block("one", "numbered-list", "One", [block("nested", "numbered-list")]), block("two", "numbered-list"), block("break"), block("restart", "numbered-list")];
  assert.deepEqual([...blockLocations(numbered)].map(location => [location.block.id, numberedSiblingPosition(location)]), [["one", 1], ["nested", 1], ["two", 2], ["break", null], ["restart", 1]]);
});

test("editor history ignores fold preference only and never carries it into canonical replacement", () => {
  const current = fixture(), prior = structuredClone(current);
  current.collapsedBlockIds = ["outer", "header"];
  assert.equal(editorHistoryUnchanged(current, prior), true);
  prior.workspace.pages[0].blocks[0].text = "Earlier";
  const command = editorHistoryCommand(current, prior);
  assert.deepEqual(Object.keys(command.payload).sort(), ["blocks", "pageId"]);
  assert.equal(current.collapsedBlockIds.length, 2);
  prior.expandedPageIds.push("target");
  assert.throws(() => editorHistoryCommand(current, prior), /only block changes/);
});
