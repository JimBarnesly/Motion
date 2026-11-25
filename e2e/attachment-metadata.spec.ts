import { expect, test, type Page } from "./fixtures";

const stamp = "2026-11-25T00:00:00.000Z";
const originalWorkspace = {
  schemaVersion: 2, id: "attachment-workspace", name: "Attachment notebook", createdAt: stamp, updatedAt: stamp,
  databases: [], linkIndex: [],
  pages: [{
    id: "attachment-page", parentId: null, title: "Attachment notebook", createdAt: stamp, updatedAt: stamp,
    blocks: [{ id: "file-block", type: "file", text: "", children: [], attachmentId: "proof-file" }]
  }],
  attachments: [{
    id: "proof-file", fileName: "proof.txt", mediaType: "text/plain", byteLength: 0,
    sha256: "0".repeat(64), path: "objects/proof", createdAt: stamp
  }]
};

async function storedWorkspace(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("motion-web-development", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction("workspace", "readonly").objectStore("workspace").get("default");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
}

test("a hostile attachment size cannot inject actions or replace the current notebook during import", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await page.getByRole("textbox", { name: "Page title" }).fill("Keep this notebook");
  await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
  const before = await storedWorkspace(page);
  const hostile = structuredClone(originalWorkspace) as any;
  hostile.attachments[0].byteLength = '<button data-trash-page="attachment-page" id="injected-action">Unexpected action</button>';
  const messages: string[] = [];
  page.on("dialog", async dialog => { messages.push(dialog.message()); await dialog.accept(); });

  await page.locator("#restoreFile").setInputFiles({
    name: "hostile-attachment.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ workspace: hostile }))
  });

  await expect(page.locator("#saveState")).toContainText("Restore failed");
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Keep this notebook");
  expect(await storedWorkspace(page)).toEqual(before);
  expect(messages.some(message => /attachments\[0\]\.byteLength/.test(message))).toBe(true);
  expect(messages.join(" ")).not.toContain("Unexpected action");
  await expect(page.locator("#injected-action")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unexpected action", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Keep this notebook");
});

test("valid attachment sizes render numerically while metadata markup remains literal text", async ({ page }) => {
  await page.goto("/");
  const candidate = structuredClone(originalWorkspace);
  candidate.attachments[0].fileName = 'proof <button id="filename-action" data-trash-page="attachment-page">Delete notebook</button>.txt';
  candidate.attachments[0].mediaType = '<button id="mediatype-action">Fake action</button>';
  page.on("dialog", dialog => dialog.accept());
  await page.locator("#restoreFile").setInputFiles({
    name: "valid-attachment.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ workspace: candidate }))
  });

  await expect(page.locator("#saveState")).toHaveText("Workspace restored.");
  const file = page.locator('[data-block-id="file-block"]');
  await expect(file).toContainText(candidate.attachments[0].fileName);
  await expect(file.locator("small")).toHaveText(`${candidate.attachments[0].mediaType} · 0 bytes`);
  await expect(file.getByRole("button", { name: "Download", exact: true })).toHaveCount(1);
  await expect(page.locator("#filename-action,#mediatype-action")).toHaveCount(0);
  await page.reload();
  await expect(file.locator("small")).toHaveText(`${candidate.attachments[0].mediaType} · 0 bytes`);
  await expect(page.locator("#filename-action,#mediatype-action")).toHaveCount(0);
});
