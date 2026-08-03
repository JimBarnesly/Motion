import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorkspaceStore, WorkspaceDocument, createWorkspace, exportDatabaseCsv, exportFullWorkspace, exportWorkspaceJson, migrateWorkspace } from "../index.js";

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
