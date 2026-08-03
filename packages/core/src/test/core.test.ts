import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MemoryWorkspaceStore, WorkspaceDocument, assertWorkspaceValue, createWorkspace, exportDatabaseCsv, exportFullWorkspace, exportPageMarkdown, exportWorkspaceJson, migrateWebWorkspaceV1, migrateWorkspace, type Page } from "../index.js";

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
  const db = doc.addDatabase({ pageId: home.id, name: "Tasks", properties: [
    { id: "title", name: "Title", type: "title" }, { id: "status", name: "Status", type: "status" }, { id: "priority", name: "Priority", type: "number" }
  ], rows: [], views: [{ id: "table", collectionId: "db", name: "All", type: "table", visiblePropertyIds: ["title", "status"], filters: { kind: "condition", propertyId: "status", operator: "equals", value: "open" }, sorts: [{ propertyId: "priority", direction: "desc" }] }] });
  const low = doc.addRecord(db.id, "Low", { status: "open", priority: 1 });
  const high = doc.addRecord(db.id, "High", { status: "open", priority: 5 });
  doc.addRecord(db.id, "Closed", { status: "closed", priority: 10 });
  assert.equal(low.collectionId, db.id);
  assert.deepEqual(doc.queryRecords(db.id, { kind: "and", children: [{ kind: "condition", propertyId: "status", operator: "equals", value: "open" }] }, [{ propertyId: "priority", direction: "desc" }]).map(p => p.id), [high.id, low.id]);
});

test("unknown blocks survive deterministic serialization and v1 migrates", () => {
  const ws = createWorkspace("Future"); const doc = new WorkspaceDocument(ws); const page = doc.addPage("Page");
  doc.addBlock(page.id, { type: "future-plugin-widget", text: "", unknownData: { z: 1, a: { y: true } } });
  const first = exportWorkspaceJson(ws); const second = exportWorkspaceJson(structuredClone(ws));
  assert.equal(first, second); assert.match(first, /future-plugin-widget/); assert.ok(first.indexOf('"a"') < first.indexOf('"z"'));
  const old: any = structuredClone(ws); old.schemaVersion = 1; delete old.linkIndex; old.pages[0].blocks[0].type = "todo";
  const migrated = migrateWorkspace(old); assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.pages[0].blocks[0].type, "task");
});

test("broken stable references remain indexed and null placement is direction-independent", () => {
  const doc = new WorkspaceDocument(createWorkspace("Integrity"));
  const root = doc.addPage("Root");
  doc.addBlock(root.id, { type: "page-mention", text: "Missing", pageId: "deleted-page" });
  assert.equal(doc.brokenLinks(root.id)[0]?.targetPageId, "deleted-page");

  const collectionPage = doc.addPage("Collection");
  const database = doc.addDatabase({ pageId: collectionPage.id, name: "Items", properties: [], rows: [], views: [] });
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
});

test("web v1 migration is deterministic, separates UI state, preserves unknown blocks and rebuilds links", () => {
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
