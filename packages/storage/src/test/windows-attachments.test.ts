import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { StagedAttachment } from "../index.js";
import { WindowsAttachmentStore } from "../windows-attachments.js";
import type { WindowsNativeRequest } from "../windows-native-helper.js";

const rootIdentity = "1".repeat(64), stagingIdentity = "2".repeat(64), fileIdentity = "3".repeat(64);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function harness(override?: (request: WindowsNativeRequest) => unknown) {
  const calls: WindowsNativeRequest[] = [];
  const invoke = <T = unknown>(request: WindowsNativeRequest): T => {
    calls.push(request);
    if (request.operation === "attachment.initialize") return { rootIdentity, stagingIdentity } as T;
    assert.equal(request.expectedRootIdentity, rootIdentity);
    assert.equal(request.expectedStagingIdentity, stagingIdentity);
    if (override) return override(request) as T;
    if (request.operation === "attachment.stage") return { stagingName: request.stagingName,
      sha256: request.sha256, byteLength: (request.bytes as number[]).length, fileIdentity } as T;
    if (request.operation === "attachment.promote") {
      const receipt = request.receipt as { sha256: string; byteLength: number };
      return { sha256: receipt.sha256, byteLength: receipt.byteLength, newlyCreated: true } as T;
    }
    if (request.operation === "attachment.discard") return { removed: true } as T;
    throw new Error("Unexpected test helper operation");
  };
  return { calls, invoke };
}

test("Windows attachment capabilities hide native receipts and are single-use and store-bound", async () => {
  const native = harness(), first = new WindowsAttachmentStore("test-root", native.invoke), second = new WindowsAttachmentStore("test-root", native.invoke);
  const capability = await first.stage(Buffer.from("trusted bytes"));
  assert.equal(Object.isFrozen(capability), true);
  assert.deepEqual(Object.keys(capability).sort(), ["byteLength", "path", "sha256"]);
  await assert.rejects(second.promote(capability), /not issued/i);
  await assert.rejects(first.promote({ ...capability } as StagedAttachment), /not issued/i);
  const stored = await first.promote(capability);
  assert.equal(stored.sha256, capability.sha256);
  await assert.rejects(first.promote(capability), /not issued/i);
  await assert.rejects(first.discard(capability), /not issued/i);
  assert.equal(native.calls.filter(call => call.operation === "attachment.promote").length, 1);
});

test("Windows attachment staging rejects oversized bytes before native side effects", async () => {
  const native = harness(), store = new WindowsAttachmentStore("test-root", native.invoke);
  await assert.rejects(store.stage(new Uint8Array(3 * 1024 * 1024 + 1)), /3 MiB/);
  assert.equal(native.calls.length, 1);
});

test("Windows attachment initialization rejects malformed native identity digests", () => {
  for (const identity of ["12345678:0000000000000001", "a".repeat(63), "a".repeat(65), "A".repeat(64), "../../external"]) {
    const invoke = <T = unknown>(): T => ({ rootIdentity: identity, stagingIdentity }) as T;
    assert.throws(() => new WindowsAttachmentStore("test-root", invoke), /invalid data/i);
  }
});

test("Windows attachment receipt validation rejects native hash, length and identity changes", async () => {
  for (const changed of [{ sha256: "f".repeat(64) }, { byteLength: 0 }, { fileIdentity: "../../external" },
    { fileIdentity: "12345678:0000000000000003" }, { stagingName: "external" }]) {
    const native = harness(request => ({ stagingName: request.stagingName, sha256: request.sha256,
      byteLength: (request.bytes as number[]).length, fileIdentity, ...changed }));
    const store = new WindowsAttachmentStore("test-root", native.invoke);
    await assert.rejects(store.stage(Buffer.from("payload")), /invalid data/i);
  }
});

test("Windows attachment reads verify returned bytes, size and digest again in the application process", async () => {
  const bytes = Buffer.from("bounded attachment"), sha256 = digest(bytes);
  const native = harness(() => ({ bytes: [...bytes] })), store = new WindowsAttachmentStore("test-root", native.invoke);
  assert.deepEqual(Buffer.from(await store.get(sha256)), bytes);
  await assert.rejects(store.get("../../outside"), /64 lowercase hexadecimal/);
  await assert.rejects(store.get("f".repeat(64)), /integrity check failed/i);
  for (const returned of [[256], [-1], [0.5], new Array(3 * 1024 * 1024 + 1).fill(0)]) {
    const corrupt = new WindowsAttachmentStore("test-root", harness(() => ({ bytes: returned })).invoke);
    await assert.rejects(corrupt.get(sha256), /invalid data/i);
  }
});

test("Windows attachment recovery validates hashes before invoking native recovery and checks bounded report fields", async () => {
  const sha256 = "a".repeat(64), report = { promoted: [], removedStaging: [], missingReferenced: [sha256],
    unreferencedBlobs: [], oversizedBlobs: [], corruptBlobs: [] };
  const native = harness(() => report), store = new WindowsAttachmentStore("test-root", native.invoke);
  await assert.rejects(store.recover(["../outside"]), /64 lowercase hexadecimal/);
  assert.equal(native.calls.length, 1);
  assert.deepEqual(await store.recover([sha256, sha256]), report);
  assert.deepEqual(native.calls[1]?.referencedHashes, [sha256]);
  const corrupt = new WindowsAttachmentStore("test-root", harness(() => ({ ...report, removedStaging: ["../../outside"] })).invoke);
  await assert.rejects(corrupt.recover([]), /invalid data/i);
});
