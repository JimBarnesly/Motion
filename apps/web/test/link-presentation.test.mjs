import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildLinkEntries, linkEntryLabel } from "../link-presentation.js";

const pages = [
  { id: "source", title: "Source", blocks: [] },
  { id: "live", title: "Renamed <Target>", blocks: [] },
  { id: "trashed", title: "Old target", deletedAt: "2026-08-10T00:00:00.000Z", blocks: [] }
];
const links = [
  { sourcePageId: "source", targetPageId: "live", blockId: "block-live" },
  { sourcePageId: "source", targetPageId: "trashed", blockId: "block-trashed" },
  { sourcePageId: "source", targetPageId: "missing", blockId: "block-missing" }
];

test("outgoing links retain stable targets and expose live, trashed, and missing states", () => {
  assert.deepEqual(buildLinkEntries({ pages, links, pageId: "source", direction: "outgoing" }), [
    { pageId: "live", blockId: "block-live", title: "Renamed <Target>", status: "live", preview: { text: "No preview available", blockCount: 0 } },
    { pageId: "trashed", blockId: "block-trashed", title: "Old target", status: "trashed", preview: { text: "No preview available", blockCount: 0 } },
    { pageId: "missing", blockId: "block-missing", title: "Missing page", status: "missing", preview: null }
  ]);
});

test("backlinks preserve source block IDs for deep navigation", () => {
  const entries = buildLinkEntries({ pages, links, pageId: "live", direction: "incoming" });
  assert.deepEqual(entries, [{ pageId: "source", blockId: "block-live", title: "Source", status: "live", preview: { text: "No preview available", blockCount: 0 } }]);
  assert.equal(entries[0].blockId, "block-live");
});

test("link labels expose unavailable states as text rather than unsafe markup", () => {
  const entries = buildLinkEntries({
    pages,
    links: [...links, { sourcePageId: "source", targetPageId: "live", blockId: "b2" }],
    pageId: "source",
    direction: "outgoing"
  });
  assert.equal(entries.length, 3);
  assert.equal(linkEntryLabel(entries[0]), "Renamed <Target>");
  assert.equal(linkEntryLabel(entries[1]), "Old target — In Trash");
  assert.equal(linkEntryLabel(entries[2]), "Missing page — Missing");
  assert.equal(entries[1].status, "trashed");
  assert.equal(entries[2].status, "missing");
});

test("link entries preserve arbitrary stable IDs without treating them as selectors", () => {
  const hostileId = 'target\"] [data-evil="1';
  const entries = buildLinkEntries({
    pages: [{ id: hostileId, title: "Still data", deletedAt: undefined }],
    links: [{ sourcePageId: "source", targetPageId: hostileId, blockId: "block" }],
    pageId: "source",
    direction: "outgoing"
  });
  assert.equal(entries[0].pageId, hostileId);
  assert.equal(entries[0].status, "live");
});

test("link previews resolve canonical target content by stable ID after rename and move", () => {
  const movedAndRenamed = {
    id: "live",
    parentId: "new-parent",
    title: "Renamed after restart",
    blocks: [
      { id: "divider", type: "divider", text: "" },
      { id: "empty", type: "paragraph", text: "   " },
      { id: "summary", type: "paragraph", text: "A safe <summary> from canonical content" },
      { id: "more", type: "paragraph", text: "More" }
    ]
  };
  const [entry] = buildLinkEntries({
    pages: [pages[0], movedAndRenamed],
    links: [{ sourcePageId: "source", targetPageId: "live", blockId: "source-block" }],
    pageId: "source",
    direction: "outgoing"
  });

  assert.equal(entry.title, "Renamed after restart");
  assert.deepEqual(entry.preview, {
    text: "A safe <summary> from canonical content",
    blockCount: 4
  });
});

test("link previews expose empty, trashed, and missing targets without stale content", () => {
  const entries = buildLinkEntries({
    pages: [pages[0], pages[1], { ...pages[2], blocks: [{ id: "secret", type: "paragraph", text: "Archived text" }] }],
    links,
    pageId: "source",
    direction: "outgoing"
  });

  assert.deepEqual(entries[0].preview, { text: "No preview available", blockCount: 0 });
  assert.deepEqual(entries[1].preview, { text: "Archived text", blockCount: 1 });
  assert.equal(entries[2].preview, null);
});

test("the Web application integrates lifecycle rendering and block-level backlink focus", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(source, /import \{ buildLinkEntries, linkEntryLabel \} from "\.\/link-presentation\.js"/);
  assert.match(source, /function renderLinkLifecycle/);
  assert.match(source, /container\.replaceChildren\(\)/);
  assert.match(source, /control\.textContent=linkEntryLabel\(entry\)/);
  assert.match(source, /preview\.textContent=entry\.preview\.text/);
  assert.match(source, /preview\.setAttribute\("aria-label"/);
  assert.doesNotMatch(source, /innerHTML\s*=.*entry\.preview/);
  assert.match(source, /control\.dataset\.revealTrashed=entry\.pageId/);
  assert.match(source, /button\.dataset\.revealTrashed/);
  assert.match(source, /data-restore-page/);
  assert.match(source, /function findByDataValue/);
  assert.match(source, /querySelectorAll\(selector\)/);
  assert.match(source, /element\.dataset\[key\]===value/);
  assert.doesNotMatch(source, /data-block-id=\\"\$\{blockId\}/);
  assert.doesNotMatch(source, /data-restore-page=\\"\$\{button\.dataset\.revealTrashed\}/);
  assert.match(source, /button\.dataset\.focusBlock/);
  assert.match(source, /data-block-id/);
  assert.match(build, /link-presentation\.js/);
  assert.match(html, /id="openContext"[^>]+aria-controls="contextPanel"[^>]+aria-expanded="false"/);
  assert.match(html, /id="closeContext"/);
  assert.match(source, /function setContextOpen/);
  assert.match(source, /event\.key==="Escape"/);
  assert.match(source, /sidebar.*classList\.add\("open"\)/);
  assert.match(styles, /\.context-panel\.open\s*\{\s*display:block/);
  assert.match(styles, /@media \(max-width:1050px\)[\s\S]*\.context-toggle/);
  assert.match(styles, /@media \(max-width:720px\)[\s\S]*\.sidebar\s*\{[^}]*overflow-y:auto/);
});
