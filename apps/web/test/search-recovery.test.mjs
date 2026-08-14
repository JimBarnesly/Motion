import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildBrowserSearchHits,
  normalizeSearchHits,
  resolveSearchTarget,
  searchStatus
} from "../search-recovery.js";

const workspace = {
  id: "workspace-1",
  pages: [
    { id: "page-z", title: "Pump notes", blocks: [{ id: "block-1", text: "Seal pressure", attachmentId: "attachment-2", children: [{ id: "block-2", text: "nested calibration", children: [] }] }] },
    { id: "table-page", title: "Commissioning register", blocks: [] },
    { id: "record-b", parentId: "table-page", collectionId: "database-1", title: "Zulu record", blocks: [], properties: { reading: "Flow stable", files: { attachmentIds: ["attachment-1"] } } },
    { id: "record-a", parentId: "table-page", collectionId: "database-1", title: "Alpha record", blocks: [], properties: { reading: "Flow stable" } }
  ],
  databases: [{ id: "database-1", pageId: "table-page", properties: [{ id: "reading", name: "Reading" }, { id: "files", name: "Proof" }], rows: [{ id: "legacy-row", pageId: "record-b", values: {} }], recordPageIds: ["record-b", "record-a"] }],
  attachments: [{ id: "attachment-1", fileName: "commissioning-proof.pdf" }, { id: "attachment-2", fileName: "pump-photo.jpg" }]
};

test("browser canonical search covers titles, nested blocks, record properties, and attachment filenames", () => {
  assert.deepEqual(buildBrowserSearchHits(workspace, "pump").map(hit => hit.entityId), ["page-z"]);
  assert.deepEqual(buildBrowserSearchHits(workspace, "nested calibration").map(hit => hit.entityId), ["page-z"]);
  assert.deepEqual(buildBrowserSearchHits(workspace, "pump photo").map(hit => hit.entityId), ["page-z"]);
  assert.deepEqual(buildBrowserSearchHits(workspace, "flow stable").map(hit => hit.entityId), ["record-a", "record-b"]);
  const attachment = buildBrowserSearchHits(workspace, "commissioning proof")[0];
  assert.deepEqual({ entityId: attachment?.entityId, ownerEntityId: attachment?.ownerEntityId }, { entityId: "record-b", ownerEntityId: "table-page" });
  assert.match(attachment?.snippet ?? "", /commissioning-proof\.pdf/);
  const withTombstone = structuredClone(workspace);
  withTombstone.databases[0].properties.push({ id: "historic", name: "Historic", deletedAt: "2026-08-14T00:00:00.000Z" });
  withTombstone.pages[2].properties.historic = "secret tombstone value";
  assert.deepEqual(buildBrowserSearchHits(withTombstone, "secret tombstone").map(hit => hit.entityId), []);
});

test("result normalization deduplicates by stable target and orders deterministically", () => {
  const hits = normalizeSearchHits([
    { entityId: "b", entityType: "page", title: "Same", snippet: "second" },
    { entityId: "a", entityType: "page", title: "Same", snippet: "first" },
    { entityId: "a", entityType: "page", title: "Duplicate", snippet: "ignored" }
  ]);
  assert.deepEqual(hits.map(hit => [hit.entityId, hit.snippet]), [["a", "first"], ["b", "second"]]);
});

test("native row and record hits resolve owning context and stable focus without selectors", () => {
  assert.deepEqual(resolveSearchTarget({ entityId: "legacy-row", entityType: "row", ownerEntityId: "table-page" }, workspace),
    { pageId: "table-page", recordId: "record-b" });
  assert.deepEqual(resolveSearchTarget({ entityId: "record-b", entityType: "page", ownerEntityId: "table-page" }, workspace),
    { pageId: "record-b", recordId: "record-b" });
  assert.deepEqual(resolveSearchTarget({ entityId: "block-2", entityType: "block", ownerEntityId: "page-z" }, workspace),
    { pageId: "page-z", blockId: "block-2" });
});

test("native row targets fail closed for missing owners, missing rows, and trashed record pages", () => {
  assert.equal(resolveSearchTarget({ entityId: "legacy-row", entityType: "row" }, workspace), null);
  assert.equal(resolveSearchTarget({ entityId: "missing-row", entityType: "row", ownerEntityId: "table-page" }, workspace), null);
  assert.equal(resolveSearchTarget({ entityId: "legacy-row", entityType: "row", ownerEntityId: "database-1" }, workspace), null);
  const trashed = structuredClone(workspace);
  trashed.pages.find(page => page.id === "record-b").deletedAt = "2026-08-11T00:00:00Z";
  assert.equal(resolveSearchTarget({ entityId: "legacy-row", entityType: "row", ownerEntityId: "table-page" }, trashed), null);
  assert.equal(resolveSearchTarget({ entityId: "record-b", entityType: "page", ownerEntityId: "table-page" }, trashed), null);
  assert.equal(resolveSearchTarget({ entityId: "missing-record", entityType: "page", ownerEntityId: "table-page" }, workspace), null);
});

test("stable row and record-page IDs remain opaque navigation values", () => {
  const stable = structuredClone(workspace);
  stable.pages[2].id = 'record:😀][data-record-id="other"';
  stable.databases[0].recordPageIds[0] = stable.pages[2].id;
  stable.databases[0].rows[0].pageId = stable.pages[2].id;
  assert.deepEqual(resolveSearchTarget({ entityId: "legacy-row", entityType: "row", ownerEntityId: "table-page" }, stable),
    { pageId: "table-page", recordId: stable.pages[2].id });
  assert.deepEqual(resolveSearchTarget({ entityId: stable.pages[2].id, entityType: "page", ownerEntityId: "table-page" }, stable),
    { pageId: stable.pages[2].id, recordId: stable.pages[2].id });
});

test("status copy is honest, preserves the query for retry, and never leaks native diagnostics", () => {
  assert.deepEqual(searchStatus("", "idle"), { kind: "guidance", message: "Search page titles, block text, record properties, and attachment filenames." });
  assert.deepEqual(searchStatus("flow", "loading"), { kind: "loading", message: "Searching for “flow”…" });
  assert.deepEqual(searchStatus("flow", "empty"), { kind: "empty", message: "No results for “flow”." });
  const failed = searchStatus("flow", "error", new Error("/Users/alice/private.db: SQLITE_IOERR"));
  assert.deepEqual(failed, { kind: "error", message: "Search is unavailable right now. Your workspace was not changed.", retryQuery: "flow" });
  assert.doesNotMatch(JSON.stringify(failed), /alice|private|SQLITE|IOERR/);
});

test("web integration renders search with DOM text, retry, and stable focus hooks", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  const searchSource = source.slice(source.indexOf("async function renderSearch"), source.indexOf("function renderSearchStatus"));
  assert.match(source, /buildBrowserSearchHits/);
  assert.match(source, /resolveSearchTarget/);
  assert.match(source, /row\.dataset\.recordId/);
  assert.doesNotMatch(source, /<tr data-record-id=/);
  assert.match(source, /dataset\.searchRetry/);
  assert.match(source, /replaceChildren/);
  assert.doesNotMatch(searchSource, /innerHTML|insertAdjacentHTML/);
  assert.match(build, /search-recovery\.js/);
  assert.match(html, /id="searchResults"[^>]+role="status"[^>]+aria-live="polite"/);
});
