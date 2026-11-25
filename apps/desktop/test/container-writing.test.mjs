import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMotionUiAdapter } from "../../web/app-adapter.js";
import { splitBlockCommands } from "../../web/editor-structure.js";
import { multilinePasteCommands } from "../../web/markdown-paste.js";

async function bounded(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Service deadline exceeded")), 5_000); })]); }
  finally { clearTimeout(timer); }
}
function launch(root) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../service-runner.mjs", import.meta.url)), root],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MOTION_SERVICE_START_GATE: "0" } });
  const exited = once(child, "exit"), lines = createInterface({ input: child.stdout, crlfDelay: Infinity }), replies = lines[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", part => { stderr = (stderr + part).slice(-4_000); });
  child.stdin.on("error", () => {});
  const send = async (lane, payload) => {
    child.stdin.write(JSON.stringify({ lane, payload }) + "\n");
    const next = await bounded(replies.next());assert.equal(next.done, false, stderr);
    const reply = JSON.parse(next.value);
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.value;
  };
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: (command, args) => {
    const wire = JSON.parse(JSON.stringify(args));
    if (command === "app_dispatch") return send(wire.request.lane, wire.request.payload);
    if (command === "motion_ui_load") return send("ui-load", wire.request);
    if (command === "motion_ui_save") return send("ui-save", wire.request);
    throw new Error("Unexpected native command");
  } } } });
  return { adapter, send, async close() {
    child.stdin.end();
    try { const [code] = await bounded(exited);assert.equal(code, 0, stderr); }
    finally { if (child.exitCode === null && child.signalCode === null) { child.kill();await bounded(exited); }lines.close(); }
  } };
}

test("container commands, private fold state and complete backups survive native service restart and restore", { timeout: 30_000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "motion-container-writing-")), root = join(parent, "data");
  let service = launch(root);
  try {
    let adapter = service.adapter;
    const created = await adapter.execute("workspace.create", { name: "Container notebook" });
    const workspaceId = created.workspace.id;
    const page = await adapter.execute("page.create", { title: "Writing" }), pageId = page.workspace.pages[0].id;
    const target = await adapter.execute("page.create", { title: "Target" }), targetId = target.workspace.pages[1].id;
    const initial = { id: "toggle", type: "toggle", text: "Header tail", children: [
      { id: "callout", type: "callout", text: "Details", children: [{ id: "opaque", type: "future-widget", text: "Imported", references: [{ pageId: targetId }],
        unknownData: { payload: { id: "opaque", values: [true, 3] } }, children: [] }] }
    ] };
    await adapter.execute("block.create", { pageId, position: { parentBlockId: null, beforeBlockId: null }, block: initial });
    const bytes = Uint8Array.of(0, 127, 128, 255);
    await adapter.ingestAttachmentBlock({ pageId, position: { parentBlockId: "callout", beforeBlockId: null }, fileName: "nested.bin", mediaType: "application/octet-stream",
      sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
    let loaded = await adapter.load();
    const split = splitBlockCommands({ pageId, block: loaded.workspace.pages[0].blocks[0], offset: 7, createId: () => "first-child" });
    await adapter.execute("block.batch", { commands: split.commands });
    loaded = await adapter.load();
    let next = 0;
    const pasted = multilinePasteCommands({ pageId, blocks: loaded.workspace.pages[0].blocks, activeBlockId: "callout", prefix: "Details ", text: "summary\n- [x] Checked\nMore", createId: () => `pasted-${next++}` });
    await adapter.execute("block.batch", { commands: pasted });
    const confirmed = await service.send("query", { type: "workspace.get", workspaceId });
    const tree = confirmed.workspace.pages[0].blocks;
    assert.equal(tree[0].type, "toggle");assert.equal(tree[0].children[0].type, "paragraph");assert.equal(tree[0].children[0].text, "tail");
    const callout = tree[0].children[1];
    assert.equal(callout.type, "callout");assert.equal(callout.text, "Details summary");
    assert.deepEqual(callout.children.map(block => block.type), ["task", "paragraph", "future-widget", "file"]);
    assert.deepEqual(callout.children[2].unknownData, initial.children[0].children[0].unknownData);
    await adapter.saveUi({ workspaceId, activePageId: null, expandedPageIds: [], activeViewIds: {}, collapsedBlockIds: ["toggle", "callout", "missing"] });
    assert.deepEqual(await service.send("query", { type: "workspace.get", workspaceId }), confirmed, "view changes never rewrite canonical revision, timestamps, or data");
    const stored = JSON.parse(await readFile(join(root, "ui-state.json"), "utf8"));
    assert.equal(stored.schemaVersion, 1);assert.deepEqual(stored.collapsedBlockIds, ["toggle"]);
    for (const collapsedBlockIds of [null, new Array(1), ["toggle\n"], ["toggle", "toggle"], ["bad/id"], Array.from({ length: 257 }, (_, i) => `b-${i}`)]) {
      await assert.rejects(adapter.saveUi({ workspaceId, activePageId: null, collapsedBlockIds }), /Invalid UI state/);
      await assert.rejects(service.send("ui-save", { schemaVersion: 2, document: { workspaceId, collapsedBlockIds } }), error => error.code === "INVALID_INPUT");
    }
    assert.deepEqual(JSON.parse(await readFile(join(root, "ui-state.json"), "utf8")), stored);
    const exported = await adapter.exportWorkspace();
    assert.deepEqual(JSON.parse(exported.files["workspace.json"]).pages[0].blocks, tree);
    const bundle = await adapter.createBackup();assert.deepEqual(await adapter.verifyBackup(bundle), { valid: true, errors: [] });
    await service.close();service = launch(root);adapter = service.adapter;
    loaded = await adapter.load();
    assert.equal(loaded.activePageId, null);assert.deepEqual(loaded.collapsedBlockIds, ["toggle"]);
    assert.deepEqual({ workspace: loaded.workspace, revision: loaded.revision }, confirmed);
    const restored = await adapter.restoreBackup(bundle), restoredLoad = await adapter.load();
    assert.notEqual(restored.workspace.id, workspaceId);assert.deepEqual(restoredLoad.collapsedBlockIds, []);
    const restoredTree = restored.workspace.pages[0].blocks, restoredCallout = restoredTree[0].children[1];
    assert.equal(restoredTree[0].type, "toggle");assert.equal(restoredCallout.type, "callout");
    assert.deepEqual(restoredCallout.children[2].unknownData, callout.children[2].unknownData);
    assert.equal(restoredCallout.children[2].references[0].pageId, restored.workspace.pages[1].id);
    assert.equal(restoredCallout.children[3].attachmentId, restored.workspace.attachments[0].id);
    assert.deepEqual((await adapter.readAttachment(restoredCallout.children[3].attachmentId)).bytes, bytes);
    assert.deepEqual(await service.send("query", { type: "workspace.get", workspaceId }), confirmed);
    // Optional-field compatibility: an older valid UI-state document opens all
    // containers and still preserves an explicit workspace-home selection.
    await service.close();service = null;
    delete stored.collapsedBlockIds;await writeFile(join(root, "ui-state.json"), JSON.stringify(stored));
    service = launch(root);loaded = await service.adapter.load();
    assert.equal(loaded.activePageId, null);assert.deepEqual(loaded.collapsedBlockIds, []);
    assert.deepEqual({ workspace: loaded.workspace, revision: loaded.revision }, confirmed);
  } finally { if (service) await service.close();await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
