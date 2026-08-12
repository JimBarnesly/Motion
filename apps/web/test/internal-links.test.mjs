import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildInternalUrl,
  parseInternalUrl
} from "../internal-links.js";

test("internal URLs encode stable workspace, page, and optional block identities", () => {
  const url = buildInternalUrl({
    workspaceId: "workspace / stable",
    pageId: "page?#stable",
    blockId: "block/😀"
  });

  assert.equal(url, "motion://open/workspace%20%2F%20stable/page%3F%23stable?block=block%2F%F0%9F%98%80");
  assert.deepEqual(parseInternalUrl(url), {
    workspaceId: "workspace / stable",
    pageId: "page?#stable",
    blockId: "block/😀"
  });
});

test("page URLs omit block identity and reject foreign or malformed locations", () => {
  const pageUrl = buildInternalUrl({ workspaceId: "workspace-1", pageId: "page-1" });
  assert.equal(pageUrl, "motion://open/workspace-1/page-1");
  assert.deepEqual(parseInternalUrl(pageUrl), { workspaceId: "workspace-1", pageId: "page-1" });

  for (const value of [
    "https://example.test/workspace-1/page-1",
    "motion://other/workspace-1/page-1",
    "motion://open/only-one-segment",
    "motion://open/workspace-1/page-1?unknown=value",
    "motion://open/workspace-1/page-1?block=",
    "motion://open/workspace-1/page-1#block-1",
    "motion://open/workspace-1/page-1?block=%ZZ",
    "motion://open/workspace-1/page-1?block=%E0%A4%A",
    "motion://open/workspace-1/page-1?block=block-1&&",
    "motion://open/workspace-1/page-1?block=block-1&"
  ]) assert.equal(parseInternalUrl(value), null);
});

test("internal URL construction requires non-empty stable identities", () => {
  assert.throws(() => buildInternalUrl({ workspaceId: "", pageId: "page-1" }), /workspace ID/);
  assert.throws(() => buildInternalUrl({ workspaceId: "workspace-1", pageId: "" }), /page ID/);
  assert.throws(() => buildInternalUrl({ workspaceId: "workspace-1", pageId: "page-1", blockId: "" }), /block ID/);
  assert.throws(() => buildInternalUrl({ workspaceId: ".", pageId: "page-1" }), /workspace ID/);
  assert.throws(() => buildInternalUrl({ workspaceId: "workspace-1", pageId: ".." }), /page ID/);
});

test("page context exposes copyable page and backlink block URLs without HTML sinks", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");

  assert.match(source, /from "\.\/internal-links\.js"/);
  assert.match(source, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(source, /catch\{\$\("#saveState"\)\.textContent="Internal link could not be copied"/);
  assert.match(source, /buildInternalUrl\(\{workspaceId:workspace\(\)\.id,pageId:page\.id\}\)/);
  assert.match(source, /buildInternalUrl\(\{workspaceId:workspace\(\)\.id,pageId:button\.dataset\.openPage,blockId:button\.dataset\.focusBlock\}\)/);
  assert.match(source, /button\.dataset\.copyInternalUrl/);
  assert.doesNotMatch(source, /innerHTML\s*=.*motion:\/\//);
  assert.match(html, /id="copyPageLink"/);
  assert.match(build, /"internal-links\.js"/);
});
