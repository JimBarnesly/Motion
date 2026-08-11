import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createBackup, previewRestore, restoreIntoNewWorkspace, safeArchivePath, verifyBackup, type WorkspaceSnapshot } from "../index.js";

const bytes = new TextEncoder().encode("attachment contents");
const sha256 = createHash("sha256").update(bytes).digest("hex");

const workspace: WorkspaceSnapshot = {
  schemaVersion: 2,
  id: "workspace-old",
  name: "Portable workspace",
  pages: [
    { id: "page-root", parentId: null, title: "Root", blocks: [{ id: "block-1", type: "paragraph", text: "Hello", children: [], attachmentId: "attachment-1" }], createdAt: "2026-01-01T00:00:00Z" },
    { id: "page-child", parentId: "page-root", title: "Child", blocks: [], createdAt: "2026-01-01T00:00:00Z" }
  ],
  databases: [{ id: "database-1", pageId: "page-root", name: "Tasks", properties: [], rows: [{ id: "row-1", pageId: "page-child" }], recordPageIds: ["page-child"], views: [] }],
  attachments: [{ id: "attachment-1", fileName: "note.txt", sha256, byteLength: bytes.byteLength, path: "/private/source/note.txt" }],
  linkIndex: [{ sourcePageId: "page-root", targetPageId: "page-child", blockId: "block-1" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z"
};

test("backup verifies and restores an equivalent isolated workspace", () => {
  const backup = createBackup(workspace, [{ id: "attachment-1", fileName: "note.txt", bytes }], "2026-01-02T00:00:00Z");
  assert.deepEqual(verifyBackup(backup), { valid: true, errors: [] });
  assert.deepEqual(previewRestore(backup), { valid: true, errors: [], workspaceName: "Portable workspace", pages: 2, databases: 1, records: 1, attachments: 1, totalBytes: backup.manifest.files.reduce((sum, file) => sum + file.byteLength, 0) });

  const restored = restoreIntoNewWorkspace(backup, "workspace-new");
  assert.equal(restored.workspace.id, "workspace-new");
  assert.equal(restored.workspace.pages[1]?.parentId, "workspace-new:page-root");
  assert.equal(restored.workspace.databases[0]?.pageId, "workspace-new:page-root");
  assert.deepEqual(restored.workspace.databases[0]?.recordPageIds, ["workspace-new:page-child"]);
  assert.deepEqual(restored.attachments.get("workspace-new:attachment-1"), bytes);

  const reverse = new Map([...restored.idMap].map(([oldId, newId]) => [newId, oldId]));
  const undoIds = (value: unknown, key?: string): unknown => {
    if (typeof value === "string" && key && (key === "id" || key.endsWith("Id") || key.endsWith("Ids"))) return reverse.get(value) ?? value;
    if (Array.isArray(value)) return value.map(item => undoIds(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, undoIds(child, childKey)]));
    return value;
  };
  assert.deepEqual(undoIds(restored.workspace), workspace);
});

test("restoring a table remaps property IDs and row value keys together", () => {
  const source = structuredClone(workspace) as any;
  source.attachments = [];
  delete source.pages[0].blocks[0].attachmentId;
  source.databases = [{ id: "database-1", pageId: "page-root", name: "Readings",
    properties: [{ id: "property-1", name: "Reading", type: "plain-text" }],
    rows: [{ id: "row-1", values: { "property-1": "stable cell" }, createdAt: source.createdAt, updatedAt: source.updatedAt }], views: [] }];
  const restored = restoreIntoNewWorkspace(createBackup(source, [], "2026-01-01T00:00:00.000Z"), "restored").workspace;
  const propertyId = (restored.databases[0]?.properties[0] as any)?.id;
  assert.equal(propertyId, "restored:property-1");
  assert.equal((restored.databases[0]?.rows[0] as any)?.values[propertyId!], "stable cell");
  assert.equal("property-1" in ((restored.databases[0]?.rows[0] as any)?.values ?? {}), false);
});

test("bounded restore IDs preserve references, attachment keys and non-ID strings", () => {
  const maximumId = "p".repeat(160);
  const migratedDatabaseId = `database:${"d".repeat(128)}`;
  const migratedViewId = `view:${"v".repeat(128)}:table`;
  const attachmentId = "a".repeat(160);
  const source: WorkspaceSnapshot = {
    schemaVersion: 2,
    id: "source-workspace",
    name: "Boundary fixture",
    pages: [{ id: maximumId, parentId: null, title: maximumId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", blocks: [
      { id: "boundary-block", type: "file", text: maximumId, children: [], attachmentId }
    ] }],
    databases: [{ id: migratedDatabaseId, pageId: maximumId, name: "Migrated", properties: [
      { id: "property", name: "Relation", type: "page" }
    ], rows: [{ id: "row", values: { property: maximumId }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }], views: [
      { id: migratedViewId, collectionId: migratedDatabaseId, name: "Table", type: "table", visiblePropertyIds: ["property"] }
    ] }],
    attachments: [{ id: attachmentId, fileName: "boundary.bin", mediaType: "application/octet-stream", sha256, byteLength: bytes.byteLength, path: "/retained/source/path", createdAt: "2026-01-01T00:00:00.000Z" }],
    linkIndex: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const backup = createBackup(source, [{ id: attachmentId, fileName: "boundary.bin", bytes }], "2026-01-02T00:00:00.000Z");
  const namespace = "n".repeat(160);
  const first = restoreIntoNewWorkspace(backup, namespace);
  const repeated = restoreIntoNewWorkspace(backup, namespace);
  const other = restoreIntoNewWorkspace(backup, "other-workspace");
  const firstViews = first.workspace.databases[0]!.views as Array<{ id: string; collectionId: string }>;
  const entityIds = [first.workspace.id, first.workspace.pages[0]!.id, (first.workspace.pages[0]!.blocks[0] as any).id,
    first.workspace.databases[0]!.id, (first.workspace.databases[0]!.properties[0] as any).id,
    first.workspace.databases[0]!.rows[0]!.id, firstViews[0]!.id, first.workspace.attachments[0]!.id];

  assert.equal(new Set(entityIds).size, entityIds.length);
  assert.ok(entityIds.every(id => id.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)));
  assert.deepEqual(first.idMap, repeated.idMap);
  assert.notEqual(first.idMap.get(maximumId), other.idMap.get(maximumId));
  assert.equal(first.workspace.databases[0]!.pageId, first.idMap.get(maximumId));
  assert.equal(firstViews[0]!.collectionId, first.idMap.get(migratedDatabaseId));
  assert.equal((first.workspace.pages[0]!.blocks[0] as any).attachmentId, first.idMap.get(attachmentId));
  assert.equal((first.workspace.databases[0]!.rows[0] as any).values[first.idMap.get("property")!], first.idMap.get(maximumId));
  assert.equal(first.workspace.pages[0]!.title, maximumId);
  assert.equal((first.workspace.pages[0]!.blocks[0] as any).text, maximumId);
  assert.equal(first.workspace.attachments[0]!.path, "/retained/source/path");
  assert.deepEqual(first.attachments.get(first.idMap.get(attachmentId)!), bytes);
});

test("restore remaps only schema-declared internal identities and references", () => {
  const source = structuredClone(workspace) as any;
  source.pages[0] = {
    ...source.pages[0], updatedAt: source.createdAt, createdBy: "page-child", updatedBy: "page-root",
    templateOriginId: "page-root", collectionId: "database-1",
    permissions: { ownerId: "page-root", nested: { pageId: "page-child" } },
    properties: {
      "property-select": "option-open", "property-multi": ["option-tag"], "property-relation": ["page-child"],
      "property-files": { attachmentIds: ["attachment-1"] }, "property-created-by": "page-root",
      "property-updated-by": "page-child", "property-page": "page-child"
    },
    blocks: [{
      id: "block-1", type: "future-widget", text: "Opaque", children: [
        { id: "block-child", type: "paragraph", text: "Child", children: [], references: [{ pageId: "page-root" }] }
      ], attachmentId: "attachment-1", pageId: "page-child", viewId: "view-1", references: [{ pageId: "page-child" }],
      unknownData: { id: "page-root", ownerId: "page-child", nested: { pageId: "page-root" } }
    }]
  };
  source.pages[1] = { ...source.pages[1], updatedAt: source.createdAt, collectionId: "database-1", properties: {} };
  source.databases = [{
    id: "database-1", pageId: "page-root", name: "Tasks", properties: [
      { id: "property-select", name: "Select", type: "select", options: [{ id: "option-open", name: "Open" }] },
      { id: "property-multi", name: "Tags", type: "multi-select", options: [{ id: "option-tag", name: "Tag" }] },
      { id: "property-relation", name: "Relation", type: "relation", relation: { targetCollectionId: "database-1", reciprocalPropertyId: "property-relation" }, relationDatabaseId: "database-1" },
      { id: "property-files", name: "Files", type: "files" },
      { id: "property-created-by", name: "Creator", type: "created-by" },
      { id: "property-updated-by", name: "Updater", type: "updated-by" },
      { id: "property-page", name: "Page", type: "page" }
    ],
    rows: [{ id: "row-1", pageId: "page-child", values: {
      "property-select": "option-open", "property-multi": ["option-tag"], "property-relation": ["page-root"],
      "property-files": { attachmentIds: ["attachment-1"] }, "property-created-by": "page-root",
      "property-updated-by": "page-child", "property-page": "page-child"
    }, createdAt: source.createdAt, updatedAt: source.updatedAt }],
    recordPageIds: ["page-child"],
    views: [{
      id: "view-1", collectionId: "database-1", name: "All", type: "table",
      visiblePropertyIds: ["property-select"], propertyOrder: ["property-multi"], columnWidths: { "property-select": 200 },
      filters: { kind: "and", children: [
        { kind: "condition", propertyId: "property-select", operator: "equals", value: "option-open" },
        { kind: "condition", propertyId: "property-created-by", operator: "equals", value: "page-root" }
      ] },
      sorts: [{ propertyId: "property-multi", direction: "asc" }], groupByPropertyId: "property-select",
      subgroupByPropertyId: "property-multi", calendarDatePropertyId: "property-select",
      timelineStartPropertyId: "property-select", timelineEndPropertyId: "property-multi",
      layout: { propertyId: "property-select", nested: { viewId: "view-1", opaqueOwnerId: "page-root" } },
      permissions: { ownerId: "page-root", pageId: "page-child" }
    }]
  }];
  source.linkIndex = [{ sourcePageId: "page-root", targetPageId: "page-child", blockId: "block-1" }];

  const restored = restoreIntoNewWorkspace(createBackup(source, [{ id: "attachment-1", fileName: "note.txt", bytes }]), "restored");
  const id = (sourceId: string) => restored.idMap.get(sourceId)!;
  const page = restored.workspace.pages[0] as any;
  const database = restored.workspace.databases[0] as any;
  const row = database.rows[0]; const view = database.views[0]; const block = page.blocks[0];

  assert.equal(page.createdBy, "page-child"); assert.equal(page.updatedBy, "page-root");
  assert.equal(page.templateOriginId, "page-root"); assert.deepEqual(page.permissions, source.pages[0].permissions);
  assert.deepEqual(block.unknownData, source.pages[0].blocks[0].unknownData);
  assert.deepEqual(view.permissions, source.databases[0].views[0].permissions);
  assert.equal(row.values[id("property-created-by")], "page-root");
  assert.equal(row.values[id("property-updated-by")], "page-child");
  assert.equal(view.filters.children[1].value, "page-root");

  assert.equal(page.collectionId, id("database-1")); assert.equal(page.parentId, null);
  assert.equal(block.id, id("block-1")); assert.equal(block.children[0].id, id("block-child"));
  assert.equal(block.attachmentId, id("attachment-1")); assert.equal(block.pageId, id("page-child"));
  assert.equal(block.viewId, id("view-1")); assert.equal(block.references[0].pageId, id("page-child"));
  assert.equal(block.children[0].references[0].pageId, id("page-root"));
  assert.equal(page.properties[id("property-select")], id("option-open"));
  assert.deepEqual(page.properties[id("property-multi")], [id("option-tag")]);
  assert.deepEqual(page.properties[id("property-relation")], [id("page-child")]);
  assert.deepEqual(page.properties[id("property-files")], { attachmentIds: [id("attachment-1")] });
  assert.equal(page.properties[id("property-created-by")], "page-root");
  assert.equal(page.properties[id("property-updated-by")], "page-child");
  assert.equal(page.properties[id("property-page")], id("page-child"));
  assert.equal(database.id, id("database-1")); assert.equal(database.pageId, id("page-root"));
  assert.equal(database.properties[0].options[0].id, id("option-open"));
  assert.equal(database.properties[2].relation.targetCollectionId, id("database-1"));
  assert.equal(database.properties[2].relation.reciprocalPropertyId, id("property-relation"));
  assert.equal(database.properties[2].relationDatabaseId, id("database-1"));
  assert.equal(row.id, id("row-1")); assert.equal(row.pageId, id("page-child"));
  assert.equal(row.values[id("property-select")], id("option-open"));
  assert.deepEqual(row.values[id("property-multi")], [id("option-tag")]);
  assert.deepEqual(row.values[id("property-relation")], [id("page-root")]);
  assert.deepEqual(row.values[id("property-files")], { attachmentIds: [id("attachment-1")] });
  assert.equal(row.values[id("property-page")], id("page-child"));
  assert.deepEqual(database.recordPageIds, [id("page-child")]);
  assert.equal(view.id, id("view-1")); assert.equal(view.collectionId, id("database-1"));
  assert.deepEqual(view.visiblePropertyIds, [id("property-select")]);
  assert.deepEqual(view.propertyOrder, [id("property-multi")]);
  assert.deepEqual(view.columnWidths, { [id("property-select")]: 200 });
  assert.equal(view.filters.children[0].propertyId, id("property-select"));
  assert.equal(view.filters.children[0].value, id("option-open"));
  assert.equal(view.sorts[0].propertyId, id("property-multi"));
  assert.equal(view.groupByPropertyId, id("property-select")); assert.equal(view.subgroupByPropertyId, id("property-multi"));
  assert.equal(view.calendarDatePropertyId, id("property-select")); assert.equal(view.timelineStartPropertyId, id("property-select"));
  assert.equal(view.timelineEndPropertyId, id("property-multi"));
  assert.equal(view.layout.propertyId, id("property-select")); assert.equal(view.layout.nested.viewId, id("view-1"));
  assert.equal(view.layout.nested.opaqueOwnerId, "page-root");
  assert.deepEqual(restored.workspace.linkIndex, [{ sourcePageId: id("page-root"), targetPageId: id("page-child"), blockId: id("block-1") }]);
  assert.equal(restored.idMap.has("page-root"), true);
  assert.equal(restored.idMap.has("page-child"), true);
});

test("restore rejects unsafe namespaces and ambiguous duplicate source identities", () => {
  const backup = createBackup({ ...workspace, attachments: [] }, [], "2026-01-02T00:00:00.000Z");
  for (const namespace of ["", "bad/id", "x".repeat(161)]) assert.throws(() => restoreIntoNewWorkspace(backup, namespace), /workspace ID/i);
  const duplicate = structuredClone({ ...workspace, attachments: [] });
  duplicate.pages[1]!.id = duplicate.pages[0]!.id;
  assert.throws(() => restoreIntoNewWorkspace(createBackup(duplicate, []), "safe-workspace"), /duplicate source ID/i);
  const hostile = structuredClone({ ...workspace, attachments: [] });
  hostile.pages[0]!.id = "bad/id";
  assert.throws(() => restoreIntoNewWorkspace(createBackup(hostile, []), "safe-workspace"), /source page ID/i);
});

test("tampering and traversal paths are rejected", () => {
  const backup = createBackup(workspace, [{ id: "attachment-1", fileName: "note.txt", bytes }]);
  const corrupted = { ...backup, files: { ...backup.files, "workspace.json": new TextEncoder().encode("{}") } };
  assert.equal(verifyBackup(corrupted).valid, false);
  assert.throws(() => safeArchivePath("attachments", "..", "secret"), /Unsafe/);
  for (const path of ["/absolute/escape", "\\server\\share", "C:\\escape", "attachments/%2e%2e/escape", "attachments\\..\\escape"]) {
    assert.throws(() => safeArchivePath(path), /Unsafe/, `accepted ${path}`);
  }
  assert.throws(() => createBackup(workspace, [{ id: "attachment-1", fileName: "note.txt", bytes: new Uint8Array([1]) }]), /does not match/);
});
