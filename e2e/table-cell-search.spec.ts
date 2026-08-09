import { expect, test, type Page } from "@playwright/test";

const layouts = [
  { name: "normal", viewport: { width: 1280, height: 800 } },
  { name: "equivalent 200%", viewport: { width: 640, height: 800 } }
] as const;

const restoredWorkspace = {
  schemaVersion: 1,
  activePageId: "notes-page",
  pages: [
    { id: "notes-page", parentId: null, order: 0, type: "document", title: "Existing notes", deleted: false,
      blocks: [{ id: "notes-block", type: "paragraph", text: "Existing title and block search remain available", indent: 0 }] },
    { id: "commissioning-table", parentId: null, order: 1, type: "database", title: "Commissioning register", deleted: false,
      columns: [{ id: "reading-column", name: "Reading", type: "text" }, { id: "owner-column", name: "Owner", type: "text" }],
      rows: [
        { id: "stable-row-a", values: { "reading-column": "Flow <10 & stable\nsecond line", "owner-column": "Jake" } },
        { id: "stable-row-b", values: { "reading-column": "Flow nominal", "owner-column": "Alex" } }
      ] }
  ]
};

async function storedWorkspace(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("motion-web-development", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => request.result.createObjectStore("workspace");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const read = database.transaction("workspace", "readonly").objectStore("workspace").get("default");
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
    } finally { database.close(); }
  });
}

async function restoreClean(page: Page) {
  await page.goto("/");
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("motion-web-development");
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  }));
  await page.reload();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#restoreFile").setInputFiles({
    name: "motion-table-search.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(restoredWorkspace))
  });
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Existing notes");
}

for (const layout of layouts) {
  test.describe(layout.name, () => {
    test.use({ viewport: layout.viewport });

    test("MOTION-UX-005: restored table cells search deterministically and Enter focuses the stable row without mutation", async ({ page }) => {
      await restoreClean(page);
      const before = await storedWorkspace(page);

      await page.keyboard.press("Control+k");
      const search = page.getByRole("searchbox", { name: "Search workspace" });
      await search.fill("stable second");
      const result = page.locator("#searchResults").getByRole("button", { name: /Commissioning register.*Reading: Flow <10 & stable second line/ });
      await expect(result).toBeVisible();
      await expect(page.locator("#searchDialog")).toBeInViewport();
      await result.focus();
      await page.keyboard.press("Enter");

      await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Commissioning register");
      await expect(page.locator('[data-row-id="stable-row-a"] [data-cell]').first()).toBeFocused();
      await expect(page.locator('[data-row-id="stable-row-a"] [data-cell]').first()).toHaveValue(/Flow <10 & stable.*second line/);
      expect(await storedWorkspace(page)).toEqual(before);

      await page.reload();
      await page.keyboard.press("Control+k");
      await page.getByRole("searchbox", { name: "Search workspace" }).fill("stable second");
      const afterRestart = page.locator("#searchResults").getByRole("button", { name: /Commissioning register.*Flow <10 & stable second line/ });
      await expect(afterRestart).toHaveCount(1);
      await expect(afterRestart).toBeVisible();
      await expect(page.locator("#searchResults")).not.toContainText("<script");
    });
  });
}
