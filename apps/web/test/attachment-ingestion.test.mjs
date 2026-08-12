import assert from "node:assert/strict";
import test from "node:test";
import { createAttachmentIngestion } from "../attachment-ingestion.js";

const file = { name: "proof.txt", type: "text/plain", async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; } };

function harness() {
  const calls = []; const statuses = [];
  const ingestion = createAttachmentIngestion({
    activePage: () => ({ id: "page-1", blocks: [{ id: "existing" }] }),
    authority: () => ({ workspaceId: "workspace-1", pageId: "page-1", revision: 3 }),
    runCanonical: async (_action, operation) => operation(),
    ingest: async payload => { calls.push(payload); return { workspace: { id: "workspace-1" }, revision: 4 }; },
    digest: async () => "a".repeat(64),
    confirm: result => statuses.push(["confirmed", result.revision]),
    status: message => statuses.push(["status", message])
  });
  return { ingestion, calls, statuses };
}

test("keyboard selection and file drop use the same durable attachment-block ingestion payload", async () => {
  const keyboard = harness(); const dropped = harness();
  await keyboard.ingestion.fromSelection([file]);
  await dropped.ingestion.fromDrop({ preventDefault() {}, dataTransfer: { files: [file] } });
  assert.deepEqual(keyboard.calls, dropped.calls);
  assert.deepEqual(keyboard.calls[0], {
    pageId: "page-1", position: { parentBlockId: null, beforeBlockId: null },
    fileName: "proof.txt", mediaType: "text/plain", sha256: "a".repeat(64), bytes: new Uint8Array([1, 2, 3])
  });
  assert.deepEqual(keyboard.statuses, [["confirmed", 4], ["status", "Attached proof.txt"]]);
});

test("failed ingestion exposes an explicit state and never confirms a canonical snapshot", async () => {
  const statuses = [];
  const ingestion = createAttachmentIngestion({ activePage: () => ({ id: "page-1", blocks: [] }),
    authority: () => ({ workspaceId: "workspace-1", pageId: "page-1", revision: 3 }), runCanonical: async (_action, operation) => operation(), digest: async () => "a".repeat(64),
    ingest: async () => { throw new Error("disk full"); }, confirm: () => assert.fail("failed ingestion must not publish"), status: message => statuses.push(message) });
  await assert.rejects(ingestion.fromSelection([file]), /disk full/);
  assert.deepEqual(statuses, ["Attachment failed: disk full"]);
});

test("missing files are an explicit state and do not invoke ingestion", async () => {
  const statuses = []; let calls = 0;
  const ingestion = createAttachmentIngestion({ activePage: () => ({ id: "page-1", blocks: [] }),
    authority: () => ({ workspaceId: "workspace-1", pageId: "page-1", revision: 3 }), runCanonical: async (_action, operation) => operation(), digest: async () => "unused",
    ingest: async () => { calls += 1; }, confirm() {}, status: message => statuses.push(message) });
  assert.equal(await ingestion.fromSelection([]), false);
  assert.equal(calls, 0);
  assert.deepEqual(statuses, ["No file selected"]);
});

test("canonical lease and authority cover file read, hash, dispatch, and response", async () => {
  const events = []; let current = { workspaceId: "workspace-1", pageId: "page-1", revision: 3 };
  const ingestion = createAttachmentIngestion({
    activePage: () => ({ id: current.pageId }), authority: () => ({ ...current }),
    runCanonical: async (_action, operation) => { events.push("lease-start"); const result = await operation(); events.push("lease-end"); return result; },
    digest: async () => { events.push("hash"); return "a".repeat(64); },
    ingest: async payload => { events.push(`dispatch:${payload.pageId}`); return { workspace: { id: "workspace-1" }, revision: 4 }; },
    confirm() { events.push("confirm"); }, status() {}
  });
  const observedFile = { ...file, async arrayBuffer() { events.push("read"); return file.arrayBuffer(); } };
  await ingestion.fromSelection([observedFile]);
  assert.deepEqual(events, ["lease-start", "read", "hash", "dispatch:page-1", "confirm", "lease-end"]);

  let releaseHash; const hashGate = new Promise(resolve => { releaseHash = resolve; }); let dispatched = false;
  const raced = createAttachmentIngestion({ activePage: () => ({ id: current.pageId }), authority: () => ({ ...current }),
    runCanonical: async (_action, operation) => operation(), digest: async () => { await hashGate; return "a".repeat(64); },
    ingest: async () => { dispatched = true; }, confirm() {}, status() {} });
  const pending = raced.fromSelection([file]); await Promise.resolve(); current = { workspaceId: "workspace-2", pageId: "page-1", revision: 1 }; releaseHash();
  await assert.rejects(pending, /workspace or page changed/i); assert.equal(dispatched, false);
});

test("oversized attachments fail before file allocation or dispatch", async () => {
  let reads = 0; let calls = 0; const statuses = [];
  const ingestion = createAttachmentIngestion({ activePage: () => ({ id: "page-1" }), authority: () => ({ workspaceId: "workspace-1", pageId: "page-1", revision: 1 }),
    runCanonical: async (_action, operation) => operation(), digest: async () => "unused", ingest: async () => { calls += 1; }, confirm() {}, status: value => statuses.push(value) });
  const oversized = { name: "huge.bin", type: "application/octet-stream", size: 3 * 1024 * 1024 + 1, async arrayBuffer() { reads += 1; return new ArrayBuffer(this.size); } };
  await assert.rejects(ingestion.fromSelection([oversized]), /3 MiB/);
  assert.deepEqual({ reads, calls }, { reads: 0, calls: 0 });
  assert.match(statuses[0], /Attachment failed/);
});
