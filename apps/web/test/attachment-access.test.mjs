import assert from "node:assert/strict";
import test from "node:test";
import { createAttachmentAccess } from "../attachment-access.js";

const metadata = { id: "attachment-1", fileName: "portable-proof.txt", mediaType: "text/plain", byteLength: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" };

function harness(overrides = {}) {
  const statuses = []; const downloads = [];
  const access = createAttachmentAccess({
    read: async id => ({ attachment: metadata, bytes: new TextEncoder().encode("hello") }),
    digest: async () => metadata.sha256,
    download: value => downloads.push(value),
    status: message => statuses.push(message),
    ...overrides
  });
  return { access, statuses, downloads };
}

test("saving a canonical attachment verifies identity, size and hash before download", async () => {
  const { access, statuses, downloads } = harness();
  assert.equal(await access.save(metadata), true);
  assert.deepEqual(downloads, [{ fileName: "portable-proof.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("hello") }]);
  assert.deepEqual(statuses, ["Saved a copy of portable-proof.txt"]);
});

test("missing or corrupt canonical bytes remain visible as an explicit failure and never download", async () => {
  for (const [name, overrides, expected] of [
    ["missing", { read: async () => { throw new Error("ENOENT /private/path"); } }, /could not be read/i],
    ["wrong identity", { read: async () => ({ attachment: { ...metadata, id: "other" }, bytes: new TextEncoder().encode("hello") }) }, /metadata did not match/i],
    ["wrong size", { read: async () => ({ attachment: metadata, bytes: new TextEncoder().encode("shorter") }) }, /size did not match/i],
    ["wrong hash", { digest: async () => "0".repeat(64) }, /integrity check failed/i]
  ]) {
    const { access, statuses, downloads } = harness(overrides);
    await assert.rejects(access.save(metadata), expected, name);
    assert.equal(downloads.length, 0, name);
    assert.match(statuses.at(-1), /^Attachment portable-proof\.txt could not be saved:/, name);
    assert.doesNotMatch(statuses.at(-1), /private\/path|ENOENT/, name);
  }
});

test("an attachment action is single-flight and reports the stable canonical filename", async () => {
  let release; let reads = 0;
  const pendingRead = new Promise(resolve => { release = resolve; });
  const { access, statuses, downloads } = harness({ read: async () => { reads += 1; await pendingRead; return { attachment: metadata, bytes: new TextEncoder().encode("hello") }; } });
  const first = access.save(metadata);
  assert.equal(await access.save(metadata), false);
  assert.equal(reads, 1);
  assert.equal(statuses.at(-1), "Already saving portable-proof.txt");
  release();
  assert.equal(await first, true);
  assert.equal(downloads.length, 1);
});
