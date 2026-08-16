import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the document canvas is not permanently narrowed by an empty context rail", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const shellRule = styles.match(/\.app-shell\s*\{([^}]*)\}/s)?.[1] ?? "";
  const contextRule = styles.match(/\.context-panel\s*\{([^}]*)\}/s)?.[1] ?? "";
  const openRule = styles.match(/\.context-panel\.open\s*\{([^}]*)\}/s)?.[1] ?? "";
  const toggleRule = styles.match(/\.context-toggle,\.context-close\s*\{([^}]*)\}/s)?.[1] ?? "";

  assert.match(shellRule, /grid-template-columns:\s*240px minmax\(0,1fr\)/);
  assert.doesNotMatch(shellRule, /248px/);
  assert.match(contextRule, /display:\s*none/);
  assert.match(contextRule, /position:\s*fixed/);
  assert.match(openRule, /display:\s*block/);
  assert.match(toggleRule, /display:\s*inline-grid/);
});

test("page content uses a calm reading width and the context action names its content", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const pageRule = styles.match(/\.page\s*\{([^}]*)\}/s)?.[1] ?? "";

  assert.match(pageRule, /max-width:\s*760px/);
  assert.match(html, /id="openContext"[^>]*>Links &amp; files<\/button>/);
});

test("backup and restore utilities are disclosed on demand instead of dominating navigation", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const toolsRule = styles.match(/\.workspace-tools\s*\{([^}]*)\}/s)?.[1] ?? "";

  assert.match(html, /<details class="workspace-tools">/);
  assert.match(html, /<summary>Workspace tools<\/summary>/);
  assert.match(html, /<div class="backup-actions">/);
  assert.match(toolsRule, /position:\s*relative/);
});
