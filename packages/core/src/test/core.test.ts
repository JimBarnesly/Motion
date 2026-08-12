import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CANONICAL_MAX_ID_LENGTH, DEFAULT_VALIDATION_LIMITS, MemoryWorkspaceStore, WorkspaceDocument, assertWorkspaceValue, createWorkspace, exportDatabaseCsv, exportFullWorkspace, exportPageMarkdown, exportWorkspaceJson, migrateWebWorkspaceV1, migrateWorkspace, stableId, type Block, type Page, type Workspace } from "../index.js";

test("hierarchy, links, backlinks and search", async () => {
  const ws = createWorkspace("Private notes");
  const doc = new WorkspaceDocument(ws);
  const root = doc.addPage("Home");
  const child = doc.addPage("Project", root.id);
  doc.addBlock(root.id, { type: "paragraph", text: `See [[${child.id}]] for rocket plans` });
  assert.deepEqual(doc.children(root.id).map(p => p.id), [child.id]);
  assert.equal(doc.backlinks(child.id)[0]?.sourcePageId, root.id);
  assert.equal(doc.search("rocket")[0]?.page.id, root.id);
  assert.throws(() => doc.movePage(root.id, child.id), /cycles/);
  const store = new MemoryWorkspaceStore(); await store.save(ws);
  const loaded = await store.load(ws.id); loaded!.name = "mutated";
  assert.equal((await store.load(ws.id))!.name, "Private notes");
});


test("canonical block placement recursively creates and moves blocks across pages", () => {
  const doc = new WorkspaceDocument(createWorkspace("Blocks"));
  const source = doc.addPage("Source"); const target = doc.addPage("Target");
  doc.createBlock({ pageId: source.id, parentBlockId: null, beforeBlockId: null }, { id: "parent", type: "toggle", text: "Parent", children: [] });
  doc.createBlock({ pageId: source.id, parentBlockId: "parent", beforeBlockId: null }, { id: "child", type: "paragraph", text: "Child", children: [] });
  doc.createBlock({ pageId: target.id, parentBlockId: null, beforeBlockId: null }, { id: "anchor", type: "paragraph", text: "Anchor", children: [] });
  doc.moveBlock(source.id, "child", { pageId: target.id, parentBlockId: null, beforeBlockId: "anchor" });
  assert.deepEqual(source.blocks[0]?.children, []);
  assert.deepEqual(target.blocks.map(block => block.id), ["child", "anchor"]);
});

test("block mutations reject duplicate IDs, missing positions, cycles and invalid nesting without mutation", () => {
  const doc = new WorkspaceDocument(createWorkspace("Block validation")); const page = doc.addPage("Page");
  doc.createBlock({ pageId: page.id, parentBlockId: null, beforeBlockId: null }, { id: "parent", type: "toggle", text: "Parent", children: [{ id: "child", type: "paragraph", text: "Child", children: [] }] });
  const before = structuredClone(doc.data);
  assert.throws(() => doc.createBlock({ pageId: page.id, parentBlockId: null, beforeBlockId: null }, { id: "child", type: "paragraph", text: "Duplicate", children: [] }), /duplicate ID/);
  assert.throws(() => doc.moveBlock(page.id, "parent", { pageId: page.id, parentBlockId: "child", beforeBlockId: null }), /cycles/);
  assert.throws(() => doc.moveBlock(page.id, "parent", { pageId: page.id, parentBlockId: null, beforeBlockId: "missing" }), /not found/);
  assert.throws(() => doc.transformBlock(page.id, "parent", { type: "divider" }), /cannot contain children/);
  assert.deepEqual(doc.data, before);
});

test("block mutation traversal handles wide valid trees and rejects over-limit widths atomically", () => {
  const doc = new WorkspaceDocument(createWorkspace("Wide blocks")); const page = doc.addPage("Page");
  const wideChildren: Block[] = Array.from({ length: 120_000 }, (_, index) => ({ id: `wide-${index}`, type: "paragraph", text: "", children: [] }));
  doc.createBlock({ pageId: page.id, parentBlockId: null, beforeBlockId: null }, { id: "wide-root", type: "toggle", text: "", children: wideChildren });
  assert.equal(page.blocks[0]?.children.length, wideChildren.length);

  const before = structuredClone(doc.data);
  const overLimit = { id: "over-limit", type: "toggle", text: "", children: new Array(DEFAULT_VALIDATION_LIMITS.maxBlocks) } as Block;
  assert.throws(() => doc.createBlock({ pageId: page.id, parentBlockId: null, beforeBlockId: null }, overLimit), /Block subtree exceeds limits/);
  assert.deepEqual(doc.data, before);
});

test("same-sibling block moves are correct in both directions", () => {
  const doc = new WorkspaceDocument(createWorkspace("Moves")); const page = doc.addPage("Page");
  for (const blockId of ["a", "b", "c", "d"]) doc.addBlock(page.id, { id: blockId, type: "paragraph", text: blockId });
  doc.moveBlock(page.id, "a", { pageId: page.id, parentBlockId: null, beforeBlockId: "d" });
  assert.deepEqual(page.blocks.map(block => block.id), ["b", "c", "a", "d"]);
  doc.moveBlock(page.id, "d", { pageId: page.id, parentBlockId: null, beforeBlockId: "b" });
  assert.deepEqual(page.blocks.map(block => block.id), ["d", "b", "c", "a"]);
});

test("duplicateBlock assigns deterministic path IDs and rejects workspace-wide collisions atomically", () => {
  const workspace = createWorkspace("Duplicate"); const doc = new WorkspaceDocument(workspace); const page = doc.addPage("Page");
  doc.createBlock({ pageId: page.id, parentBlockId: null, beforeBlockId: null }, { id: "source", type: "toggle", text: "", children: [
    { id: "child-a", type: "paragraph", text: "", children: [] },
    { id: "child-b", type: "toggle", text: "", children: [{ id: "grandchild", type: "paragraph", text: "", children: [] }] }
  ] });
  const copy = doc.duplicateBlock(page.id, "source", "copy");
  assert.deepEqual(copy.children.map(block => block.id), ["copy:0", "copy:1"]);
  assert.equal(copy.children[1]?.children[0]?.id, "copy:1.0");
  doc.addBlock(page.id, { id: "clash:0", type: "paragraph", text: "existing generated-path collision" });
  const before = structuredClone(doc.data);
  assert.throws(() => doc.duplicateBlock(page.id, "source", "clash"), /duplicate ID clash:0/);
  assert.throws(() => doc.duplicateBlock(page.id, "source", page.id), /duplicate ID/);
  assert.deepEqual(doc.data, before);
});

test("WorkspaceDocument rejects invalid typed block mutations without changing data", () => {
  const doc = new WorkspaceDocument(createWorkspace("Typed")); const page = doc.addPage("Page");
  doc.addBlock(page.id, { id: "task", type: "task", text: "Do it", checked: false });
  const before = structuredClone(doc.data);
  assert.throws(() => doc.createBlock({ pageId: page.id, parentBlockId: null, beforeBlockId: null }, { id: "bad", type: "image", text: "", children: [] }), /attachmentId/);
  assert.throws(() => doc.transformBlock(page.id, "task", { type: "heading-1", headingLevel: 2 }), /headingLevel/);
  assert.throws(() => doc.updateBlockContent(page.id, "task", { text: "x", references: [{ pageId: "bad id with spaces" }] }), /pageId/);
  assert.deepEqual(doc.data, before);
});

test("portable full export contains JSON, Markdown, CSV and attachment manifest", () => {
  const ws = createWorkspace("Export"); const doc = new WorkspaceDocument(ws); const page = doc.addPage("Tasks");
  doc.addBlock(page.id, { type: "task", text: "Ship", checked: false });
  const db = doc.addDatabase({ pageId: page.id, name: "Work", properties: [{ id: "name", name: "Name", type: "text" }], rows: [{ id: "r1", values: { name: "A, B" }, createdAt: ws.createdAt, updatedAt: ws.updatedAt }], views: [] });
  ws.attachments.push({ id: "a1", fileName: "photo.jpg", mediaType: "image/jpeg", byteLength: 3, sha256: "abc", path: "objects/abc", createdAt: ws.createdAt });
  assert.match(exportDatabaseCsv(db), /"A, B"/);
  const bundle = exportFullWorkspace(ws);
  assert.ok(Object.keys(bundle.files).some(name => name.endsWith(".md")));
  assert.ok(Object.keys(bundle.files).some(name => name.endsWith(".csv")));
  assert.equal(bundle.attachments[0]?.sourcePath, "objects/abc");
});

test("Markdown export preserves heading levels and task state", () => {
  const page: Page = { id: "p", parentId: null, title: "Export", createdAt: "2026-08-04T00:00:00Z", updatedAt: "2026-08-04T00:00:00Z", blocks: [
    { id: "h", type: "heading-1", text: "Heading", children: [] },
    { id: "t", type: "task", text: "Complete", checked: true, children: [] }
  ] };
  const markdown = exportPageMarkdown(page);
  assert.match(markdown, /# Heading/);
  assert.match(markdown, /- \[x\] Complete/);
});

test("ranged canonical wiki reference indexes only its selected duplicate-title target", () => {
  const doc = new WorkspaceDocument(createWorkspace("Duplicate titles"));
  const source = doc.addPage("Source");
  const first = doc.addPage("Project");
  const selected = doc.addPage("Project");
  doc.addBlock(source.id, { id: "selected-link", type: "paragraph", text: "See [[Project]]", references: [{ pageId: selected.id, start: 4, end: 15 }] });

  assert.deepEqual(doc.outgoingLinks(source.id), [{ sourcePageId: source.id, targetPageId: selected.id, blockId: "selected-link" }]);
  assert.deepEqual(doc.backlinks(first.id), []);
  assert.equal(doc.backlinks(selected.id).length, 1);
});

test("legacy title-only wiki links resolve only when the normalized title is unambiguous", () => {
  const doc = new WorkspaceDocument(createWorkspace("Legacy links"));
  const source = doc.addPage("Source");
  const unique = doc.addPage("Unique");
  doc.addPage("DUP"); doc.addPage(" dup ");
  doc.addBlock(source.id, { id: "legacy-links", type: "paragraph", text: "[[Unique]] [[DUP]]" });

  assert.deepEqual(doc.outgoingLinks(source.id), [{ sourcePageId: source.id, targetPageId: unique.id, blockId: "legacy-links" }]);
});

test("legacy title normalization is deterministic across child-process locales and NFC-equivalent input", () => {
  const moduleUrl = new URL("../index.js", import.meta.url).href;
  const script = `import { createWorkspace, migrateWebWorkspaceV1, WorkspaceDocument } from ${JSON.stringify(moduleUrl)};
    const doc = new WorkspaceDocument(createWorkspace("Locale"));
    const source = doc.addPage("Source");
    const dotted = doc.addPage("İ");
    const composed = doc.addPage("Café");
    doc.addBlock(source.id, { id: "links", type: "paragraph", text: "[[i]] [[Cafe\\u0301]]" });
    const migrated = migrateWebWorkspaceV1({ schemaVersion: 1, pages: [
      { id: "migration-source", title: "Source", blocks: [{ id: "migration-links", type: "paragraph", text: "[[i]] [[Cafe\\u0301]]" }] },
      { id: "migration-dotted", title: "İ", blocks: [] }, { id: "migration-composed", title: "Café", blocks: [] }
    ] });
    process.stdout.write(JSON.stringify({ runtime: doc.outgoingLinks(source.id).map(link => link.targetPageId === dotted.id ? "dotted" : link.targetPageId === composed.id ? "composed" : "other"),
      migration: migrated.workspace.linkIndex.map(link => link.targetPageId) }));`;
  const run = (locale: string) => spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8", env: { ...process.env, LANG: locale, LC_ALL: locale }
  });
  const english = run("en_US.UTF-8"); const turkish = run("tr_TR.UTF-8");
  assert.equal(english.status, 0, english.stderr); assert.equal(turkish.status, 0, turkish.stderr);
  assert.equal(english.stdout, turkish.stdout);
  assert.deepEqual(JSON.parse(english.stdout), { runtime: ["composed"], migration: ["migration-composed"] });
});

test("stale ranged references fail closed for title fallback without losing canonical explicit targets", () => {
  const scenarios = [
    { label: "edit before", text: "x[[Alpha]] [[ALPHA]]", references: [{ pageId: "beta", start: 0, end: 9 }] },
    { label: "edit inside", text: "[[AlXpha]]", references: [{ pageId: "beta", start: 0, end: 9 }] },
    { label: "edit after", text: "[[Alpha]]x", references: [{ pageId: "beta", start: 0, end: 9 }] },
    { label: "duplicate tokens", text: "x[[Alpha]] [[Alpha]]", references: [{ pageId: "beta", start: 10, end: 19 }] },
    { label: "duplicate exact token identity", text: "[[Alpha]] [[Alpha]]", references: [{ pageId: "beta", start: 0, end: 9 }] },
    { label: "overlapping duplicate references", text: "x[[Alpha]]", references: [{ pageId: "beta", start: 0, end: 9 }, { pageId: "gamma", start: 0, end: 9 }] }
  ] as const;
  for (const scenario of scenarios) {
    const workspace = createWorkspace(scenario.label); const timestamp = workspace.createdAt;
    workspace.pages = [
      { id: "source", parentId: null, title: "Source", createdAt: timestamp, updatedAt: timestamp,
        blocks: [{ id: "stale", type: "paragraph", text: scenario.text, children: [], references: structuredClone(scenario.references) as unknown as Block["references"] }] },
      { id: "alpha", parentId: null, title: "Alpha", createdAt: timestamp, updatedAt: timestamp, blocks: [] },
      { id: "beta", parentId: null, title: "Beta", createdAt: timestamp, updatedAt: timestamp, blocks: [] },
      { id: "gamma", parentId: null, title: "Gamma", createdAt: timestamp, updatedAt: timestamp, blocks: [] }
    ];
    const links = new WorkspaceDocument(workspace).outgoingLinks("source").map(link => link.targetPageId);
    assert.equal(links.includes("alpha"), false, scenario.label);
    assert.equal(links.includes("beta"), true, scenario.label);
    if (scenario.label === "overlapping duplicate references") assert.equal(links.includes("gamma"), true);
  }
});

test("link rebuild reports deterministic work statistics", () => {
  const doc = new WorkspaceDocument(createWorkspace("Measured links"));
  const source = doc.addPage("Source"); const target = doc.addPage("Target");
  doc.addBlock(source.id, { id: "measured", type: "paragraph", text: `[[Target]] [[${target.id}]]`, references: [{ pageId: target.id }] });
  const stats = { pagesVisited: 0, blocksVisited: 0, referencesVisited: 0, wikiTokensVisited: 0, idLookups: 0, titleLookups: 0, linkFilterChecks: 0, linksEmitted: 0 };

  doc.rebuildLinkIndex(stats);

  assert.deepEqual(stats, { pagesVisited: 4, blocksVisited: 1, referencesVisited: 1, wikiTokensVisited: 2, idLookups: 2,
    titleLookups: 1, linkFilterChecks: 0, linksEmitted: 1 });
});

test("link rebuild uses bounded canonical-ID passes without comparison sorting", () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const pages: Page[] = [{ id: "source", parentId: null, title: "Source", favourite: false, createdAt: timestamp, updatedAt: timestamp,
    blocks: Array.from({ length: 1_000 }, (_, index) => ({ id: `block-${index}`, type: "paragraph", text: "", references: [{ pageId: "target" }], children: [] })) },
  { id: "target", parentId: null, title: "Target", favourite: false, createdAt: timestamp, updatedAt: timestamp, blocks: [] }];
  const doc = new WorkspaceDocument({ schemaVersion: 2, id: "no-comparison-sort", name: "No comparison sort", pages, databases: [], attachments: [], linkIndex: [], createdAt: timestamp, updatedAt: timestamp });
  let comparisons = 0; const originalSort = Array.prototype.sort;
  Array.prototype.sort = function(this: unknown[], compareFn?: (left: unknown, right: unknown) => number) {
    if (compareFn) { const counted = (left: unknown, right: unknown) => { comparisons++; return compareFn(left, right); }; return originalSort.call(this, counted); }
    return originalSort.call(this);
  } as typeof Array.prototype.sort;
  try { doc.rebuildLinkIndex(); } finally { Array.prototype.sort = originalSort; }

  assert.equal(comparisons, 0);
  assert.deepEqual(doc.links().map(link => link.blockId).slice(0, 3), ["block-0", "block-1", "block-10"]);
});

test("link rebuild stays linear for one hundred thousand links", () => {
  const timestamp = "2026-01-01T00:00:00.000Z"; const linkCount = 100_000;
  const target: Page = { id: "target", parentId: null, title: "Target", favourite: false, createdAt: timestamp, updatedAt: timestamp, blocks: [] };
  const source: Page = { id: "source", parentId: null, title: "Source", favourite: false, createdAt: timestamp, updatedAt: timestamp,
    blocks: [{ id: "many-links", type: "paragraph", text: "", references: Array.from({ length: linkCount }, (_, index) => ({ pageId: `missing-${index}` })), children: [] }] };
  const workspace: Workspace = { schemaVersion: 2, id: "linear-links", name: "Linear links", pages: [source, target], databases: [], attachments: [], linkIndex: [], createdAt: timestamp, updatedAt: timestamp };
  const doc = new WorkspaceDocument(workspace); const started = performance.now(); doc.rebuildLinkIndex(); const elapsedMs = performance.now() - started;

  assert.equal(doc.links().length, linkCount);
  assert.ok(elapsedMs < 2_000, `100k-link rebuild took ${elapsedMs.toFixed(1)}ms`);
});

test("link rebuild stays linear for ten thousand pages", () => {
  const timestamp = "2026-01-01T00:00:00.000Z"; const pageCount = 10_000;
  const pages: Page[] = Array.from({ length: pageCount }, (_, index) => ({ id: `page-${index}`, parentId: null, title: `Title ${index}`, favourite: false,
    createdAt: timestamp, updatedAt: timestamp, blocks: [{ id: `block-${index}`, type: "paragraph", text: `[[Title ${(index + 1) % pageCount}]]`,
      references: [{ pageId: `page-${(index + 2) % pageCount}` }], children: [] }] }));
  const workspace: Workspace = { schemaVersion: 2, id: "linear-links", name: "Linear links", pages, databases: [], attachments: [], linkIndex: [], createdAt: timestamp, updatedAt: timestamp };
  const doc = new WorkspaceDocument(workspace);
  const stats = { pagesVisited: 0, blocksVisited: 0, referencesVisited: 0, wikiTokensVisited: 0, idLookups: 0, titleLookups: 0, linkFilterChecks: 0, linksEmitted: 0 };
  const started = performance.now(); doc.rebuildLinkIndex(stats); const elapsedMs = performance.now() - started;

  assert.deepEqual(stats, { pagesVisited: pageCount * 2, blocksVisited: pageCount, referencesVisited: pageCount, wikiTokensVisited: pageCount,
    idLookups: pageCount, titleLookups: pageCount, linkFilterChecks: 0, linksEmitted: pageCount * 2 });
  assert.equal(doc.links().length, pageCount * 2);
  assert.ok(elapsedMs < 2_000, `10k-page rebuild took ${elapsedMs.toFixed(1)}ms`);
});

test("explicit page mention and child-page IDs remain canonical link sources", () => {
  const doc = new WorkspaceDocument(createWorkspace("Typed links"));
  const source = doc.addPage("Source"); const mention = doc.addPage("Same"); const child = doc.addPage("Same");
  doc.addBlock(source.id, { id: "mention", type: "page-mention", text: "Same", pageId: mention.id });
  doc.addBlock(source.id, { id: "child", type: "child-page", text: "Same", pageId: child.id });
  assert.deepEqual(doc.outgoingLinks(source.id).map(link => [link.blockId, link.targetPageId]), [["child", child.id], ["mention", mention.id]]);
});

test("materialized stable-ID links update without scans at read time", () => {
  const doc = new WorkspaceDocument(createWorkspace("Links"));
  const source = doc.addPage("Source"); const target = doc.addPage("Target");
  const block = doc.addBlock(source.id, { type: "page-mention", text: "renamable label", pageId: target.id, references: [{ pageId: target.id }] });
  assert.equal(doc.backlinks(target.id)[0]?.blockId, block.id);
  target.title = "Renamed";
  assert.equal(doc.backlinks(target.id).length, 1);
  doc.updateBlock(source.id, block.id, { references: [], pageId: undefined, type: "paragraph" });
  assert.equal(doc.backlinks(target.id).length, 0);
});

test("records are pages; typed filters and stable multi-sort operate on properties", () => {
  const doc = new WorkspaceDocument(createWorkspace("Collections")); const home = doc.addPage("Tasks");
  const db = doc.addDatabase({ id: "db", pageId: home.id, name: "Tasks", properties: [
    { id: "title", name: "Title", type: "title" }, { id: "status", name: "Status", type: "status" }, { id: "priority", name: "Priority", type: "number" }
  ], rows: [], views: [{ id: "table", collectionId: "db", name: "All", type: "table", visiblePropertyIds: ["title", "status"], filters: { kind: "condition", propertyId: "status", operator: "equals", value: "open" }, sorts: [{ propertyId: "priority", direction: "desc" }] }] });
  const low = doc.addRecord(db.id, "Low", { status: "open", priority: 1 });
  const high = doc.addRecord(db.id, "High", { status: "open", priority: 5 });
  doc.addRecord(db.id, "Closed", { status: "closed", priority: 10 });
  assert.equal(low.collectionId, db.id);
  assert.deepEqual(doc.queryRecords(db.id, { kind: "and", children: [{ kind: "condition", propertyId: "status", operator: "equals", value: "open" }] }, [{ propertyId: "priority", direction: "desc" }]).map(p => p.id), [high.id, low.id]);
});

test("record mutations only accept properties declared by their collection", () => {
  const doc = new WorkspaceDocument(createWorkspace("Scoped properties"));
  const firstPage = doc.addPage("First"); const secondPage = doc.addPage("Second");
  const first = doc.addDatabase({ id: "first-db", pageId: firstPage.id, name: "First", properties: [{ id: "first-value", name: "First value", type: "number" }], rows: [], views: [] });
  doc.addDatabase({ id: "second-db", pageId: secondPage.id, name: "Second", properties: [{ id: "second-value", name: "Second value", type: "number" }], rows: [], views: [] });

  const beforeCreate = structuredClone(doc.data);
  assert.throws(() => doc.addRecord(first.id, "Injected", { "second-value": 2 }), /property.*second-value/i);
  assert.deepEqual(doc.data, beforeCreate);

  const record = doc.addRecord(first.id, "Valid", { "first-value": 1 });
  doc.updateRecord(record.id, undefined, { "first-value": 3 });
  assert.equal(record.properties?.["first-value"], 3);
  const beforeInvalidType = structuredClone(doc.data);
  assert.throws(() => doc.updateRecord(record.id, "Must stay unchanged", { "first-value": "wrong-runtime-type" as any }), /property|number/i);
  assert.deepEqual(doc.data, beforeInvalidType);

  const beforeUpdate = structuredClone(doc.data);
  assert.throws(() => doc.updateRecord(record.id, "Must roll back", { "second-value": 4 }), /property.*second-value/i);
  assert.deepEqual(doc.data, beforeUpdate);
});

test("addPage rejects direct record construction atomically", () => {
  const doc = new WorkspaceDocument(createWorkspace("Direct record construction"));
  const collectionPage = doc.addPage("Collection");
  doc.addDatabase({ id: "db", pageId: collectionPage.id, name: "Data", properties: [], rows: [], views: [] });
  const before = structuredClone(doc.data);

  assert.throws(() => doc.addPage("Unindexed", collectionPage.id, { collectionId: "db", properties: {} }), /addRecord|record page/i);
  assert.deepEqual(doc.data, before);
  assert.doesNotThrow(() => assertWorkspaceValue(doc.data));
});

test("addDatabase only accepts complete matching record page membership and rejects atomically", () => {
  const rejected = new WorkspaceDocument(createWorkspace("Rejected database membership"));
  const databasePage = rejected.addPage("Database"); const ordinary = rejected.addPage("Ordinary");
  const before = structuredClone(rejected.data);
  const base = { id: "db", pageId: databasePage.id, name: "Data", properties: [], rows: [], views: [] };
  for (const recordPageIds of [["missing"], [ordinary.id], [ordinary.id, ordinary.id]]) {
    assert.throws(() => rejected.addDatabase({ ...base, recordPageIds }), /record|collection|missing|duplicate/i);
    assert.deepEqual(rejected.data, before);
  }

  const wrongCollection = new WorkspaceDocument(createWorkspace("Wrong collection membership"));
  const firstDatabasePage = wrongCollection.addPage("First database"); const secondDatabasePage = wrongCollection.addPage("Second database");
  const firstDatabase = wrongCollection.addDatabase({ ...base, id: "first-db", pageId: firstDatabasePage.id });
  const firstRecord = wrongCollection.addRecord(firstDatabase.id, "First record"); const beforeWrongCollection = structuredClone(wrongCollection.data);
  assert.throws(() => wrongCollection.addDatabase({ ...base, id: "second-db", pageId: secondDatabasePage.id, recordPageIds: [firstRecord.id] }), /another collection|collection|duplicate.*membership/i);
  assert.deepEqual(wrongCollection.data, beforeWrongCollection);

  const incomplete = new WorkspaceDocument(createWorkspace("Incomplete database membership"));
  const incompleteDatabasePage = incomplete.addPage("Database"); const included = incomplete.addPage("Included"); const omitted = incomplete.addPage("Omitted");
  included.collectionId = "db"; omitted.collectionId = "db"; const beforeIncomplete = structuredClone(incomplete.data);
  assert.throws(() => incomplete.addDatabase({ ...base, pageId: incompleteDatabasePage.id, recordPageIds: [included.id] }), /not indexed|membership/i);
  assert.deepEqual(incomplete.data, beforeIncomplete);

  const accepted = new WorkspaceDocument(createWorkspace("Accepted database membership"));
  const acceptedDatabasePage = accepted.addPage("Database"); const first = accepted.addPage("First"); const second = accepted.addPage("Second");
  first.collectionId = "db"; second.collectionId = "db";
  const database = accepted.addDatabase({ ...base, pageId: acceptedDatabasePage.id, recordPageIds: [first.id, second.id] });
  assert.deepEqual(database.recordPageIds, [first.id, second.id]);
  assert.deepEqual(accepted.records(database.id).map(page => page.id), [first.id, second.id]);
  assert.doesNotThrow(() => assertWorkspaceValue(accepted.data));

  const normalized = new WorkspaceDocument(createWorkspace("Normalized database membership"));
  const normalizedDatabasePage = normalized.addPage("Database"); const tagged = normalized.addPage("Tagged"); tagged.collectionId = "db";
  const normalizedDatabase = normalized.addDatabase({ ...base, pageId: normalizedDatabasePage.id });
  assert.deepEqual(normalizedDatabase.recordPageIds, [tagged.id]);
  assert.doesNotThrow(() => assertWorkspaceValue(normalized.data));
});

test("addRecord registers membership atomically and rejected values leave all state unchanged", () => {
  const doc = new WorkspaceDocument(createWorkspace("Atomic records")); const collectionPage = doc.addPage("Collection");
  const database = doc.addDatabase({ id: "db", pageId: collectionPage.id, name: "Data", properties: [{ id: "score", name: "Score", type: "number" }], rows: [], views: [] });
  const before = structuredClone(doc.data);
  assert.throws(() => doc.addRecord(database.id, "Invalid", { score: "not-a-number" }), /number/i);
  assert.deepEqual(doc.data, before);

  const record = doc.addRecord(database.id, "Valid", { score: 1 });
  assert.equal(record.collectionId, database.id);
  assert.deepEqual(database.recordPageIds, [record.id]);
  assert.deepEqual(doc.records(database.id).map(page => page.id), [record.id]);
  assert.doesNotThrow(() => assertWorkspaceValue(doc.data));
});

test("property mutations retain record membership and clean soft-deleted records", () => {
  const doc = new WorkspaceDocument(createWorkspace("Soft-deleted records")); const collectionPage = doc.addPage("Collection");
  const database = doc.addDatabase({ id: "db", pageId: collectionPage.id, name: "Data", properties: [
    { id: "keep", name: "Keep", type: "number" }, { id: "remove", name: "Remove", type: "number" }
  ], rows: [], views: [] });
  const record = doc.addRecord(database.id, "Deleted", { keep: 1, remove: 2 }); record.deletedAt = doc.data.updatedAt;

  doc.updateProperty(database.id, "keep", { type: "plain-text" });
  assert.equal(record.properties?.keep, undefined);
  doc.deleteProperty(database.id, "remove");
  assert.equal(record.properties?.remove, undefined);
  assert.deepEqual(database.recordPageIds, [record.id]);
  assert.deepEqual(doc.records(database.id), []);
  assert.doesNotThrow(() => assertWorkspaceValue(doc.data));
});

test("workspace validation rejects record values from another collection", () => {
  const doc = new WorkspaceDocument(createWorkspace("Scoped validation"));
  const firstPage = doc.addPage("First"); const secondPage = doc.addPage("Second");
  const first = doc.addDatabase({ id: "first-db", pageId: firstPage.id, name: "First", properties: [{ id: "first-value", name: "First value", type: "number" }], rows: [], views: [] });
  doc.addDatabase({ id: "second-db", pageId: secondPage.id, name: "Second", properties: [{ id: "second-value", name: "Second value", type: "number" }], rows: [], views: [] });
  const record = doc.addRecord(first.id, "Valid", { "first-value": 1 });
  const candidate = structuredClone(doc.data);
  candidate.pages.find(page => page.id === record.id)!.properties = { "second-value": 2 };
  assert.throws(() => assertWorkspaceValue(candidate), /another collection|unknown property/i);
  assert.doesNotThrow(() => assertWorkspaceValue(doc.data));
});

test("workspace validation enforces bidirectional record page membership", () => {
  const doc = new WorkspaceDocument(createWorkspace("Record membership"));
  const firstPage = doc.addPage("First"); const secondPage = doc.addPage("Second");
  const first = doc.addDatabase({ id: "first-db", pageId: firstPage.id, name: "First", properties: [], rows: [], views: [] });
  const second = doc.addDatabase({ id: "second-db", pageId: secondPage.id, name: "Second", properties: [], rows: [], views: [] });
  const record = doc.addRecord(first.id, "Record");
  const ordinary = doc.addPage("Ordinary");
  assert.doesNotThrow(() => assertWorkspaceValue(doc.data));

  const reject = (mutate: (workspace: any) => void, pattern: RegExp) => {
    const candidate = structuredClone(doc.data); mutate(candidate);
    assert.throws(() => assertWorkspaceValue(candidate), pattern);
  };
  reject(workspace => { workspace.databases[0].recordPageIds = []; }, /record page.*not indexed|membership/i);
  reject(workspace => { workspace.databases[0].recordPageIds = [ordinary.id]; }, /not a record|collection/i);
  reject(workspace => { workspace.databases[0].recordPageIds = [record.id, record.id]; }, /duplicate.*record|multiple.*database/i);
  reject(workspace => { workspace.databases[0].recordPageIds = []; workspace.databases[1].recordPageIds = [record.id]; }, /another collection|collection.*mismatch/i);
  reject(workspace => { workspace.databases[1].recordPageIds = [record.id]; }, /multiple.*database|duplicate.*record/i);
  assert.equal(second.recordPageIds?.length, 0);
});

test("record updates require indexed membership and leave unindexed pages unchanged", () => {
  const doc = new WorkspaceDocument(createWorkspace("Record update membership"));
  const collectionPage = doc.addPage("Collection");
  const database = doc.addDatabase({ id: "db", pageId: collectionPage.id, name: "Data", properties: [{ id: "score", name: "Score", type: "number" }], rows: [], views: [] });
  const record = doc.addRecord(database.id, "Visible", { score: 1 });
  assert.deepEqual(doc.records(database.id).map(page => page.id), [record.id]);
  doc.updateRecord(record.id, "Updated", { score: 2 });
  assert.equal(record.properties?.score, 2);

  database.recordPageIds = [];
  const before = structuredClone(doc.data);
  assert.throws(() => doc.updateRecord(record.id, "Invisible update", { score: 3 }), /indexed.*record|record.*membership/i);
  assert.deepEqual(doc.data, before);
});

test("schema-v1 migration restores record list membership on record pages", () => {
  const workspace: any = createWorkspace("Legacy records");
  const doc = new WorkspaceDocument(workspace); const collectionPage = doc.addPage("Collection"); const recordPage = doc.addPage("Legacy record");
  doc.addDatabase({ id: "legacy-db", pageId: collectionPage.id, name: "Legacy", properties: [], rows: [{ id: "legacy-row", pageId: recordPage.id, values: {}, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt }], views: [] });
  workspace.schemaVersion = 1; delete workspace.linkIndex; delete workspace.databases[0].recordPageIds;
  const malformed = structuredClone(workspace); malformed.databases[0].recordPageIds = {};
  assert.throws(() => migrateWorkspace(malformed), /recordPageIds.*array/i);
  const migrated = migrateWorkspace(workspace);
  assert.equal(migrated.pages.find(page => page.id === recordPage.id)?.collectionId, "legacy-db");
  assert.deepEqual(migrated.databases[0]?.recordPageIds, [recordPage.id]);
  assert.doesNotThrow(() => assertWorkspaceValue(migrated));
});

test("unknown blocks survive deterministic serialization and v1 migrates", () => {
  const ws = createWorkspace("Future"); const doc = new WorkspaceDocument(ws); const page = doc.addPage("Page");
  doc.addBlock(page.id, { type: "future-plugin-widget", text: "", unknownData: { z: 1, a: { y: true } } });
  const first = exportWorkspaceJson(ws); const second = exportWorkspaceJson(structuredClone(ws));
  assert.equal(first, second); assert.match(first, /future-plugin-widget/); assert.ok(first.indexOf('"a"') < first.indexOf('"z"'));
  const old: any = structuredClone(ws); old.schemaVersion = 1; delete old.linkIndex; old.pages[0].blocks[0].type = "todo"; old.pages[0].blocks[0].checked = false;
  const migrated = migrateWorkspace(old); assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.pages[0].blocks[0].type, "task");
});

test("broken stable references remain indexed and null placement is direction-independent", () => {
  const doc = new WorkspaceDocument(createWorkspace("Integrity"));
  const root = doc.addPage("Root");
  doc.addBlock(root.id, { type: "page-mention", text: "Missing", pageId: "deleted-page" });
  assert.equal(doc.brokenLinks(root.id)[0]?.targetPageId, "deleted-page");

  const collectionPage = doc.addPage("Collection");
  const database = doc.addDatabase({ pageId: collectionPage.id, name: "Items", properties: [{ id: "score", name: "Score", type: "number" }], rows: [], views: [] });
  const missing = doc.addRecord(database.id, "Missing", {});
  const present = doc.addRecord(database.id, "Present", { score: 5 });
  assert.deepEqual(doc.queryRecords(database.id, undefined, [{ propertyId: "score", direction: "desc", nulls: "last" }]).map(page => page.id), [present.id, missing.id]);
});

test("validation rejects hostile structure, duplicates, cycles, references, hashes and timestamps", () => {
  const base = createWorkspace("Validation");
  assertWorkspaceValue(base);
  const duplicate: any = structuredClone(base);
  duplicate.pages = [
    { id: "same", parentId: null, title: "A", blocks: [], createdAt: base.createdAt, updatedAt: base.updatedAt },
    { id: "same", parentId: null, title: "B", blocks: [], createdAt: base.createdAt, updatedAt: base.updatedAt }
  ];
  assert.throws(() => assertWorkspaceValue(duplicate), /duplicate ID/);
  const cycle: any = structuredClone(base);
  cycle.pages = [
    { id: "a", parentId: "b", title: "A", blocks: [], createdAt: base.createdAt, updatedAt: base.updatedAt },
    { id: "b", parentId: "a", title: "B", blocks: [], createdAt: base.createdAt, updatedAt: base.updatedAt }
  ];
  assert.throws(() => assertWorkspaceValue(cycle), /cycle/);
  const badAttachment: any = structuredClone(base);
  badAttachment.attachments = [{ id: "att", fileName: "x", mediaType: "text/plain", byteLength: 1, sha256: "abc", path: "objects/x", createdAt: base.createdAt }];
  assert.throws(() => assertWorkspaceValue(badAttachment), /SHA-256/);
  const missingAttachment: any = structuredClone(base);
  missingAttachment.pages = [{ id: "p", parentId: null, title: "P", createdAt: base.createdAt, updatedAt: base.updatedAt, blocks: [{ id: "b", type: "file", text: "", children: [], attachmentId: "missing" }] }];
  assert.throws(() => assertWorkspaceValue(missingAttachment), /missing attachment/);
  const badTime: any = structuredClone(base); badTime.updatedAt = "yesterday";
  assert.throws(() => assertWorkspaceValue(badTime), /UTC ISO timestamp/);
  const oversized: any = structuredClone(base); oversized.pages = [{ id: "p", parentId: null, title: "P", createdAt: base.createdAt, updatedAt: base.updatedAt, blocks: [] }];
  assert.throws(() => assertWorkspaceValue(oversized, { maxPages: 0 }), /pages must be an array within limits/);
  const polluted = Object.create({ inherited: true }); Object.assign(polluted, base);
  assert.throws(() => assertWorkspaceValue(polluted), /plain object/);
  const poisoned: any = structuredClone(base); poisoned.pages = [{ id: "p", parentId: null, title: "P", createdAt: base.createdAt, updatedAt: base.updatedAt, blocks: [], properties: JSON.parse('{"__proto__":{"admin":true}}') }];
  assert.throws(() => assertWorkspaceValue(poisoned), /forbidden key/);
});

test("validation strictly checks collection properties, rows, views and globally unique IDs", () => {
  const base: any = createWorkspace("Collections");
  base.pages.push({ id: "page", parentId: null, title: "Data", blocks: [], createdAt: base.createdAt, updatedAt: base.updatedAt });
  base.databases.push({ id: "db", pageId: "page", name: "Data", properties: [
    { id: "title", name: "Title", type: "title" },
    { id: "done", name: "Done", type: "checkbox" },
    { id: "status", name: "Status", type: "select", options: [{ id: "open", name: "Open" }] }
  ], rows: [{ id: "row", values: { title: "Item", done: false, status: "open" }, createdAt: base.createdAt, updatedAt: base.updatedAt }], views: [{ id: "view", collectionId: "db", name: "All", type: "table", visiblePropertyIds: ["title", "done"], filters: { kind: "condition", propertyId: "done", operator: "equals", value: true }, sorts: [{ propertyId: "title", direction: "asc" }] }] });
  assertWorkspaceValue(base);
  const reject = (mutate: (workspace: any) => void, pattern: RegExp) => { const candidate = structuredClone(base); mutate(candidate); assert.throws(() => assertWorkspaceValue(candidate), pattern); };
  reject(w => { w.databases[0].views = [null]; }, /views\[0\].*plain object/);
  reject(w => { w.databases[0].properties[0].type = "javascript"; }, /unsupported value/);
  reject(w => { w.databases[0].properties.push({ id: "rel", name: "Relation", type: "relation", relation: { targetCollectionId: "missing", maxItems: 0 } }); }, /positive safe integer/);
  reject(w => { w.databases[0].rows[0].values.missing = "x"; }, /unknown property/);
  reject(w => { w.databases[0].rows[0].values.done = "yes"; }, /boolean/);
  reject(w => { w.databases[0].views[0].type = "spreadsheet"; }, /unsupported value/);
  reject(w => { w.databases[0].views[0].filters = { kind: "condition", propertyId: "missing", operator: "equals" }; }, /unknown property/);
  reject(w => { w.databases[0].views[0].sorts = [{ propertyId: "title", direction: "sideways" }]; }, /unsupported value/);
  reject(w => { w.databases[0].views[0].id = "row"; }, /duplicate ID row/);
  reject(w => { w.databases[0].properties[1].id = "title"; }, /duplicate ID title/);
  reject(w => { w.databases[0].properties[2].options[0].id = "row"; }, /duplicate ID row/);
});

test("workspace validation enforces the known block payload matrix and preserves future payloads", () => {
  const base: any = createWorkspace("Block matrix");
  base.attachments.push({ id: "attachment", fileName: "x", mediaType: "image/png", byteLength: 0, sha256: "0".repeat(64), path: "objects/0", createdAt: base.createdAt });
  base.pages.push({ id: "page", parentId: null, title: "Page", createdAt: base.createdAt, updatedAt: base.updatedAt, blocks: [
    { id: "task", type: "task", text: "", children: [], checked: false },
    { id: "code", type: "code", text: "", children: [], language: "" },
    { id: "heading", type: "heading-2", text: "", children: [], headingLevel: 2 },
    { id: "image", type: "image", text: "", children: [], attachmentId: "attachment" },
    { id: "mention", type: "page-mention", text: "", children: [], pageId: "page" },
    { id: "date", type: "date-mention", text: "", children: [], date: base.createdAt },
    { id: "bookmark", type: "bookmark", text: "", children: [], url: "https://example.test/path" },
    { id: "future", type: "future-widget", text: "", children: [], checked: true, unknownData: { opaque: { value: 1 } } }
  ] });
  assertWorkspaceValue(base);
  const reject = (mutate: (workspace: any) => void, pattern: RegExp) => { const candidate = structuredClone(base); mutate(candidate); assert.throws(() => assertWorkspaceValue(candidate), pattern); };
  reject(w => { delete w.pages[0].blocks[0].checked; }, /checked/);
  reject(w => { w.pages[0].blocks[1].attachmentId = "attachment"; }, /irrelevant/);
  reject(w => { w.pages[0].blocks[2].headingLevel = 1; }, /headingLevel/);
  reject(w => { w.pages[0].blocks[6].url = "javascript:alert(1)"; }, /safe URL/);
  assert.deepEqual(base.pages[0].blocks[7].unknownData, { opaque: { value: 1 } });
});

test("canonical schema-v2 rejects every hostile ID class and reference without leaking content", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../apps/web/test/fixtures/canonical-schema-v2-hostile-ids.json", import.meta.url), "utf8"));
  const valid: any = structuredClone(fixture.workspace);
  valid.id = "550e8400-e29b-41d4-a716-446655440000:restored.v2";
  assertWorkspaceValue(valid);
  assert.equal(valid.pages[0].blocks[0].type, "future-plugin-widget");
  assert.equal(valid.pages[0].blocks[0].unknownData?.markup, "<opaque>");
  for (const attack of fixture.attacks) {
    const candidate: any = structuredClone(fixture.workspace);
    let target: any = candidate;
    for (const segment of attack.path) target = target[segment];
    if (attack.key !== undefined) {
      target[attack.value] = target[attack.key];
      delete target[attack.key];
    } else {
      let parent: any = candidate;
      for (const segment of attack.path.slice(0, -1)) parent = parent[segment];
      parent[attack.path.at(-1)] = attack.value;
    }
    let error: unknown;
    try { assertWorkspaceValue(candidate); } catch (caught) { error = caught; }
    assert.ok(error instanceof Error, `${attack.label} was accepted`);
    assert.match(error.message, /safe canonical ID/);
    assert.equal(error.message.includes(attack.value), false, `${attack.label} leaked hostile content`);
    if (attack.label.startsWith("workspace ID")) assert.throws(() => migrateWorkspace(candidate), /safe canonical ID/);
  }
});

test("canonical ID length is centralized at 160 for entities and typed block references", () => {
  const maximum = "a".repeat(CANONICAL_MAX_ID_LENGTH);
  assert.equal(CANONICAL_MAX_ID_LENGTH, 160);
  assert.equal(stableId(maximum), maximum);
  assert.throws(() => stableId(`${maximum}a`), /safe canonical ID/);

  const workspace: any = createWorkspace("Canonical boundary");
  workspace.id = maximum;
  workspace.pages.push({ id: "page", parentId: null, title: "Page", createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, blocks: [
    { id: "future", type: "future-widget", text: "", children: [], pageId: maximum, unknownData: { preserved: true } }
  ] });
  assertWorkspaceValue(workspace);
  assert.deepEqual(workspace.pages[0].blocks[0].unknownData, { preserved: true });
  workspace.pages[0].blocks[0].pageId = `${maximum}a`;
  assert.throws(() => assertWorkspaceValue(workspace), /safe canonical ID/);
});

test("web v1 migration orders stable links without comparison sorting", () => {
  const input = { schemaVersion: 1, pages: [
    { id: "z", title: "Z", blocks: [{ id: "z-block", type: "paragraph", text: "", links: [{ pageId: "a" }] }] },
    { id: "a", title: "A", blocks: [{ id: "a-block", type: "paragraph", text: "", links: [{ pageId: "z" }] }] }
  ] };
  let comparisons = 0; const originalSort = Array.prototype.sort;
  Array.prototype.sort = function(this: unknown[], compareFn?: (left: unknown, right: unknown) => number) {
    if (compareFn) return originalSort.call(this, (left, right) => { comparisons++; return compareFn(left, right); });
    return originalSort.call(this);
  } as typeof Array.prototype.sort;
  let migrated: ReturnType<typeof migrateWebWorkspaceV1>;
  try { migrated = migrateWebWorkspaceV1(input); } finally { Array.prototype.sort = originalSort; }

  assert.equal(comparisons, 0);
  assert.deepEqual(migrated.workspace.linkIndex.map(link => link.sourcePageId), ["a", "z"]);
});

test("web v1 migration deduplicates repeated explicit references in one source block", () => {
  const migrated = migrateWebWorkspaceV1({ schemaVersion: 1, pages: [
    { id: "source", title: "Source", blocks: [{ id: "repeated", type: "paragraph", text: "", links: [
      { pageId: "target" }, { pageId: "target" }, { pageId: "other" }, { pageId: "target" }, { pageId: "other" }
    ] }] },
    { id: "target", title: "Target", blocks: [] }, { id: "other", title: "Other", blocks: [] }
  ] });

  assert.deepEqual(migrated.workspace.pages[0]?.blocks[0]?.references, [{ pageId: "target" }, { pageId: "other" }]);
  assert.deepEqual(migrated.workspace.linkIndex, [
    { sourcePageId: "source", targetPageId: "other", blockId: "repeated" },
    { sourcePageId: "source", targetPageId: "target", blockId: "repeated" }
  ]);
});

test("web v1 migration leaves normalized duplicate titles unresolved", () => {
  const migrated = migrateWebWorkspaceV1({ schemaVersion: 1, pages: [
    { id: "source", title: "Source", blocks: [{ id: "ambiguous", type: "paragraph", text: "[[DUP]]" }] },
    { id: "first", title: "DUP", blocks: [] },
    { id: "second", title: " dup ", blocks: [] }
  ] });

  assert.equal(migrated.workspace.pages[0]?.blocks[0]?.references, undefined);
  assert.deepEqual(migrated.workspace.linkIndex, []);
});

test("web v1 migration bounds reference membership work across 8k explicit refs and 100k wiki tokens", () => {
  const targetCount = 8_000; const tokenCount = 100_000;
  const pages = Array.from({ length: targetCount }, (_, index) => ({ id: `target-${index}`, title: `Target ${index}`, blocks: [] }));
  const links = pages.map(page => ({ pageId: page.id }));
  const input = { schemaVersion: 1, pages: [
    { id: "source", title: "Source", blocks: [{ id: "large", type: "paragraph", text: "[[Target 7999]]".repeat(tokenCount), links }] },
    ...pages
  ] };
  const originalSome = Array.prototype.some; let predicateCalls = 0;
  Array.prototype.some = function<T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown) {
    return originalSome.call(this, (value, index, array) => { predicateCalls++; return predicate.call(thisArg, value, index, array); });
  } as typeof Array.prototype.some;
  try { migrateWebWorkspaceV1(input); } finally { Array.prototype.some = originalSome; }

  assert.ok(predicateCalls < 100_000, `reference membership performed ${predicateCalls} predicate calls`);
});

test("workspace construction handles 150k links without argument spread overflow", () => {
  const blockCount = 150_000;
  const workspace: Workspace = {
    ...createWorkspace("Large links"),
    pages: [
      { id: "source", parentId: null, title: "Source", createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z",
        blocks: Array.from({ length: blockCount }, (_, index) => ({ id: `block-${index}`, type: "paragraph" as const, text: "", children: [], references: [{ pageId: "target" }] })) },
      { id: "target", parentId: null, title: "Target", createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z", blocks: [] }
    ]
  };

  const document = new WorkspaceDocument(workspace);
  assert.equal(document.links().length, blockCount);
});

test("web v1 migration is deterministic, separates UI state, preserves unknown blocks and rebuilds links", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../fixtures/web-workspace-v1.json", import.meta.url), "utf8"));
  const first = migrateWebWorkspaceV1(fixture); const second = migrateWebWorkspaceV1(structuredClone(fixture));
  assert.deepEqual(first, second);
  assert.equal(first.uiState.activePageId, "page-home");
  assert.equal((first.workspace as any).activePageId, undefined);
  assert.equal(first.workspace.schemaVersion, 2);
  assert.equal(first.workspace.pages[0]?.blocks[1]?.type, "unsupported");
  assert.equal(first.workspace.pages[0]?.blocks[1]?.unknownData?.importedType, "plugin-weather");
  assert.deepEqual(first.workspace.linkIndex, [{ sourcePageId: "page-home", targetPageId: "page-tasks", blockId: "block-link" }]);
  assert.equal(first.workspace.databases[0]?.rows[0]?.values["column-name"], "Ship Motion");
  assertWorkspaceValue(first.workspace);
});

test("web v1 migration preserves a maximum-length safe database page ID in deterministic canonical IDs", () => {
  const pageId = "p".repeat(128);
  const result = migrateWebWorkspaceV1({ schemaVersion: 1, activePageId: pageId, pages: [{ id: pageId, parentId: null, order: 0, type: "database", title: "Data", columns: [], rows: [] }] });
  assert.equal(result.workspace.databases[0]?.id, `database:${pageId}`);
  assert.equal(result.workspace.databases[0]?.views[0]?.id, `view:${pageId}:table`);
  assertWorkspaceValue(result.workspace);
});

test("web v1 migration retains the legacy ID grammar while allowing deterministic canonical affixes", () => {
  const candidate = (id: string) => ({ schemaVersion: 1, activePageId: null, pages: [{ id, parentId: null, order: 0, type: "document", title: "Page", blocks: [] }] });
  for (const hostile of ['page"quoted', " page", "page ", "p".repeat(129)]) assert.throws(() => migrateWebWorkspaceV1(candidate(hostile)), /safe stable ID/);
});

test("web v1 trash migration preserves page identity and content", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../fixtures/web-workspace-v1.json", import.meta.url), "utf8"));
  fixture.pages[0].deleted = true;
  fixture.activePageId = fixture.pages[0].id;
  const result = migrateWebWorkspaceV1(fixture);
  const page = result.workspace.pages.find(item => item.id === fixture.pages[0].id);
  assert.equal(page?.deletedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(page?.blocks[0]?.id, fixture.pages[0].blocks[0].id);
  assert.equal(result.uiState.activePageId, null);
});
