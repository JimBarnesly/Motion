import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMotionUiAdapter, decodeBinary } from "../../web/app-adapter.js";
import { readAndVerifyBackupFile } from "../backup-file.mjs";

async function bounded(operation, description) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

// Tauri 2.11.5's process-ipc-message-fn.js serializes nested Uint8Array values
// as plain JSON arrays. The adapter must explicitly preserve Motion's byte
// envelopes before crossing that boundary. Verification and restore replies
// come from the actual service.
function tauriJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, child) =>
    child instanceof Uint8Array ? Array.from(child) : child));
}

async function withService(body) {
  const parent = await mkdtemp(join(tmpdir(), "motion-backup-adapter-"));
  const root = join(parent, "data");
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../service-runner.mjs", import.meta.url)), root
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MOTION_SERVICE_START_GATE: "0" }
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-4_000); });
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = lines[Symbol.asyncIterator]();
  const request = async (lane, payload) => {
    child.stdin.write(JSON.stringify({ lane, payload }) + "\n");
    const next = await bounded(replies.next(), "Service reply timed out: " + stderr);
    assert.equal(next.done, false, "Service exited before replying: " + stderr);
    const reply = JSON.parse(next.value);
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.value;
  };
  try { await body({ root, request }); }
  finally {
    child.stdin.end();
    try {
      const [code] = await bounded(exited, "Service shutdown timed out");
      assert.equal(code, 0, stderr);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await bounded(exited, "Service did not stop after test cleanup");
      }
      lines.close();
      await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }
}

test("native backup bytes survive the adapter, Tauri JSON, actual service, file save, and restore", { timeout: 30_000 }, () => withService(async ({ root, request }) => {
  const destination = join(root, "adapter-roundtrip.json");
  let savedWire;
  const adapter = createMotionUiAdapter({ __TAURI__: { core: { invoke: async (command, args) => {
    const wire = tauriJson(args);
    if (command === "app_dispatch") {
      assert.equal(wire.request.protocolVersion, 1);
      return request(wire.request.lane, wire.request.payload);
    }
    if (command === "motion_backup_save") {
      savedWire = wire;
      assert.deepEqual(Object.keys(wire.request).sort(), ["bundle", "schemaVersion"]);
      assert.equal(wire.request.schemaVersion, 1);
      // Native dialog interaction is outside this test. Publish the exact
      // renderer request through the real service at a fixed fixture destination.
      const saved = await request("native-backup-save", {
        destination, replaceConfirmed: false, bundle: wire.request.bundle
      });
      return { saved: true, cancelled: false, replaced: false, byteLength: saved.byteLength };
    }
    throw new Error("Unexpected adapter command: " + command);
  } } } });
  const created = await adapter.execute("workspace.create", { name: "Backup transport" });
  const page = await adapter.execute("page.create", { title: "Restorable page" });
  const pageId = page.workspace.pages[0].id;
  await adapter.execute("block.create", {
    pageId, position: { parentBlockId: null, beforeBlockId: null },
    block: { id: "roundtrip-paragraph", type: "paragraph", text: "Restorable local content", children: [] }
  });
  const bytes = Uint8Array.of(0, 1, 127, 128, 254, 255);
  const originalBytes = bytes.slice();
  await adapter.ingestAttachmentBlock({
    pageId, position: { parentBlockId: null, beforeBlockId: null },
    fileName: "proof.bin", mediaType: "application/octet-stream",
    sha256: createHash("sha256").update(bytes).digest("hex"), bytes
  });
  const original = await request("query", { type: "workspace.get", workspaceId: created.workspace.id });
  const bundle = await adapter.createBackup();
  const before = structuredClone(bundle);
  assert.equal(bundle.manifest.files.length, 2);
  assert.ok(Object.values(bundle.files).every(value => value instanceof Uint8Array && value.byteLength > 0));
  assert.deepEqual(await adapter.verifyBackup(bundle), { valid: true, errors: [] });
  const preview = await adapter.previewBackup(bundle);
  assert.equal(preview.valid, true);
  assert.equal(preview.workspaceName, "Backup transport");
  assert.equal(preview.pages, 1);
  assert.equal(preview.attachments, 1);

  const saved = await adapter.saveBackup(bundle);
  assert.equal(saved.saved, true);
  assert.ok(saved.byteLength > 0);
  for (const [path, payload] of Object.entries(savedWire.request.bundle.files)) {
    assert.deepEqual(Object.keys(payload), ["$motionBytes"]);
    assert.deepEqual(payload.$motionBytes, Array.from(bundle.files[path]));
  }
  assert.deepEqual(await readAndVerifyBackupFile(destination), { valid: true, errors: [] });
  const reopened = decodeBinary(JSON.parse(await readFile(destination, "utf8")));
  assert.deepEqual(reopened, bundle);

  const damaged = structuredClone(bundle);
  damaged.files["workspace.json"][0] ^= 1;
  assert.equal((await adapter.verifyBackup(damaged)).valid, false);
  await assert.rejects(adapter.restoreBackup(damaged), error => error.code === "VALIDATION_FAILED");
  assert.equal((await request("query", { type: "workspace.list" })).length, 1);
  assert.deepEqual(await request("query", { type: "workspace.get", workspaceId: original.workspace.id }), original);

  const restored = await adapter.restoreBackup(reopened);
  assert.notEqual(restored.workspace.id, original.workspace.id);
  assert.equal((await request("query", { type: "workspace.list" })).length, 2);
  assert.deepEqual(await request("query", { type: "workspace.get", workspaceId: original.workspace.id }), original);
  const restoredPage = restored.workspace.pages[0];
  assert.notEqual(restoredPage.id, pageId);
  assert.equal(restoredPage.title, "Restorable page");
  assert.equal(restoredPage.blocks[0].text, "Restorable local content");
  const restoredAttachment = restored.workspace.attachments[0];
  assert.notEqual(restoredAttachment.id, original.workspace.attachments[0].id);
  assert.equal(restoredPage.blocks[1].attachmentId, restoredAttachment.id);
  assert.deepEqual((await adapter.readAttachment(restoredAttachment.id)).bytes, bytes);
  assert.ok((await adapter.search("Restorable")).some(hit => hit.ownerEntityId === restoredPage.id || hit.entityId === restoredPage.id));
  assert.deepEqual(bundle, before, "Backup operations must not mutate the source bundle");
  assert.deepEqual(bytes, originalBytes, "Backup operations must not mutate source attachment bytes");
}));
