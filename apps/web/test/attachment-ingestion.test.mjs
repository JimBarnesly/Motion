import assert from "node:assert/strict";
import test from "node:test";
import { createAttachmentIngestion } from "../attachment-ingestion.js";

const file = { name: "proof.txt", type: "text/plain", async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; } };

function harness() {
  const calls = []; const statuses = [];
  const ingestion = createAttachmentIngestion({
    activePage: () => ({ id: "page-1", blocks: [{ id: "existing" }] }),
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
  const ingestion = createAttachmentIngestion({ activePage: () => ({ id: "page-1", blocks: [] }), digest: async () => "a".repeat(64),
    ingest: async () => { throw new Error("disk full"); }, confirm: () => assert.fail("failed ingestion must not publish"), status: message => statuses.push(message) });
  await assert.rejects(ingestion.fromSelection([file]), /disk full/);
  assert.deepEqual(statuses, ["Attachment failed: disk full"]);
});

test("missing files are an explicit state and do not invoke ingestion", async () => {
  const statuses = []; let calls = 0;
  const ingestion = createAttachmentIngestion({ activePage: () => ({ id: "page-1", blocks: [] }), digest: async () => "unused",
    ingest: async () => { calls += 1; }, confirm() {}, status: message => statuses.push(message) });
  assert.equal(await ingestion.fromSelection([]), false);
  assert.equal(calls, 0);
  assert.deepEqual(statuses, ["No file selected"]);
});
