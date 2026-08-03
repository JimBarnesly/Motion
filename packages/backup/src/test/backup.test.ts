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

test("tampering and traversal paths are rejected", () => {
  const backup = createBackup(workspace, [{ id: "attachment-1", fileName: "note.txt", bytes }]);
  const corrupted = { ...backup, files: { ...backup.files, "workspace.json": new TextEncoder().encode("{}") } };
  assert.equal(verifyBackup(corrupted).valid, false);
  assert.throws(() => safeArchivePath("attachments", "..", "secret"), /Unsafe/);
  assert.throws(() => createBackup(workspace, [{ id: "attachment-1", fileName: "note.txt", bytes: new Uint8Array([1]) }]), /does not match/);
});
