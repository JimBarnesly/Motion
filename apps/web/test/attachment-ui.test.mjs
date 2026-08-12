import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("attachment UI derives restart-safe entries from canonical workspace state", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  assert.match(source, /createAttachmentAccess/);
  assert.match(source, /workspace\(\)\.attachments/);
  assert.match(source, /dataset\.saveAttachment/);
  assert.match(source, /Save a copy of/);
  assert.doesNotMatch(source, /confirmedAttachments|confirmed this session/i);
});

test("attachment controls and failures are keyboard-operable and announced", async () => {
  const source = await readFile(resolve(root, "app.js"), "utf8");
  const html = await readFile(resolve(root, "index.html"), "utf8");
  assert.match(source, /button\.dataset\.saveAttachment/);
  assert.match(source, /attachmentAccess\.save/);
  assert.match(source, /renderAttachmentList/);
  assert.match(html, /id="attachments"[^>]*aria-live="polite"/);
  assert.match(html, /Attach file/);
});

test("production web build packages attachment ingestion, access and shared policy", async () => {
  const build = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
  assert.match(build, /attachment-ingestion\.js/);
  assert.match(build, /attachment-access\.js/);
  assert.match(build, /attachment-policy\.js/);
});
