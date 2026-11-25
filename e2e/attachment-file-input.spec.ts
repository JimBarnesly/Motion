import { createHash } from "node:crypto";
import { expect, test } from "./fixtures";

test("native attachment file input retains exact selected bytes after clearing and can select the same file again", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const stamp = "2026-11-25T00:00:00.000Z";
    const runtime = window as any;
    const documentValue: any = {
      schemaVersion: 2, revision: 1, activePageId: "attachment-page", expandedPageIds: [], activeViewIds: {},
      workspace: {
        schemaVersion: 2, id: "attachment-workspace", name: "File input fixture", createdAt: stamp, updatedAt: stamp,
        attachments: [], databases: [], linkIndex: [],
        pages: [{ id: "attachment-page", parentId: null, title: "Attachment input", blocks: [], createdAt: stamp, updatedAt: stamp }]
      }
    };
    runtime.__attachmentInputRequests = [];
    // The real DOM file input, File objects, ingestion controller and native
    // adapter run unchanged. Only the remote native service is a fixture here;
    // installed Windows acceptance separately proves publication and restore.
    runtime.__TAURI__ = { core: { invoke: async (name: string, args: any) => {
      if (name === "motion_ui_load") return structuredClone(documentValue);
      if (name !== "app_dispatch") throw new Error(`Unexpected fixture invocation: ${name}`);
      const request = args.request;
      if (request.protocolVersion !== 1 || request.lane !== "async-command"
          || request.payload.type !== "attachment.ingest-block") throw new Error("Unexpected attachment request");
      const payload = request.payload;
      if (payload.workspaceId !== documentValue.workspace.id || payload.pageId !== "attachment-page"
          || payload.expectedRevision !== documentValue.revision) throw new Error("Attachment authority mismatch");
      runtime.__attachmentInputRequests.push(structuredClone(request));
      const suffix = runtime.__attachmentInputRequests.length;
      const attachment = { id: `attachment-${suffix}`, fileName: payload.fileName, mediaType: payload.mediaType,
        byteLength: payload.bytes.$motionBytes.length, sha256: payload.sha256,
        path: `objects/${payload.sha256}`, createdAt: stamp };
      documentValue.workspace.attachments.push(attachment);
      documentValue.workspace.pages[0].blocks.push({ id: `file-block-${suffix}`, type: "file", text: "",
        children: [], attachmentId: attachment.id });
      documentValue.revision += 1;
      return { workspace: structuredClone(documentValue.workspace), revision: documentValue.revision, saved: true };
    } } };
  });
  await page.goto("/");
  await expect(page.locator("#saveState")).toHaveText("Connected to Motion");
  const input = page.locator("#attachmentFile");
  const bytes = Buffer.from([0, 1, 127, 128, 254, 255]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  for (let count = 1; count <= 2; count += 1) {
    await input.setInputFiles({ name: "chosen.bin", mimeType: "application/octet-stream", buffer: bytes });
    await expect(page.locator(".block-input.file")).toHaveCount(count);
    await expect(page.locator(".block-input.file").last()).toContainText("chosen.bin");
    await expect(page.locator("#saveState")).toHaveText("Attached chosen.bin");
    expect(await input.evaluate(element => ({ value: (element as HTMLInputElement).value,
      files: (element as HTMLInputElement).files?.length })))
      .toEqual({ value: "", files: 0 });
    const requests = await page.evaluate(() => (window as any).__attachmentInputRequests);
    expect(requests).toHaveLength(count);
    expect(requests[count - 1]).toEqual({ protocolVersion: 1, lane: "async-command", payload: {
      type: "attachment.ingest-block", workspaceId: "attachment-workspace", expectedRevision: count,
      pageId: "attachment-page", position: { parentBlockId: null, beforeBlockId: null },
      fileName: "chosen.bin", mediaType: "application/octet-stream", sha256: digest,
      bytes: { $motionBytes: [...bytes] }
    } });
  }
  await input.setInputFiles([]);
  await expect(page.locator("#saveState")).toHaveText("No file selected");
  expect(await page.evaluate(() => (window as any).__attachmentInputRequests.length)).toBe(2);
  await expect(page.locator(".block-input.file")).toHaveCount(2);
  expect(pageErrors).toEqual([]);
});
