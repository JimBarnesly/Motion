import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CANONICAL_MAX_ID_LENGTH, DEFAULT_VALIDATION_LIMITS, MemoryWorkspaceStore, WorkspaceDocument, assertWorkspaceValue, createWorkspace, exportDatabaseCsv, exportFullWorkspace, exportPageMarkdown, exportWorkspaceJson, migrateWebWorkspaceV1, migrateWorkspace, stableId, type Block, type Page } from "../index.js";

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

test("legacy title-only wiki links resolve only when the title is unambiguous", () => {
  const doc = new WorkspaceDocument(createWorkspace("Legacy links"));
  const source = doc.addPage("Source");
  const unique = doc.addPage("Unique");
  doc.addPage("Duplicate"); doc.addPage("Duplicate");
  doc.addBlock(source.id, { id: "legacy-links", type: "paragraph", text: "[[Unique]] [[Duplicate]]" });

  assert.deepEqual(doc.outgoingLinks(source.id), [{ sourcePageId: source.id, targetPageId: unique.id, blockId: "legacy-links" }]);
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
