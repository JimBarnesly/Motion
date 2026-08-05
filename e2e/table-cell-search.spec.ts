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

test("MOTION-UX-005: genuine empty results have explicit accessible status", async ({ page }) => {
  await restoreClean(page);
  await page.keyboard.press("Control+k");
  const search = page.getByRole("searchbox", { name: "Search workspace" });
  await search.fill("definitely absent");
  const status = page.locator("#searchResults");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveClass(/search-results-empty/);
  await expect(status).toContainText("No results");
  await expect(status).toContainText("Nothing matched “definitely absent”.");
});

test("MOTION-UX-005: native failure is redacted and keyboard retry preserves query without saving", async ({ page }) => {
  const nativeCanary = "SQLITE_IOERR /home/jake/private/motion.sqlite";
  await page.addInitScript(({ workspace, canary }) => {
    let attempts = 0;
    let saves = 0;
    let releaseFirstSearch = () => {};
    Object.defineProperty(window, "__motionSearchTest", { value: {
      get attempts() { return attempts; }, get saves() { return saves; }, releaseFirstSearch() { releaseFirstSearch(); }
    } });
    Object.defineProperty(window, "__TAURI__", { value: { core: { invoke: async (command: string, payload: { request?: { payload?: { type?: string } } }) => {
      if (command === "motion_ui_load") return workspace;
      if (command === "motion_ui_save") { saves += 1; return undefined; }
      if (payload?.request?.payload?.type === "workspace.list") return [{ id: "workspace-1", revision: 1 }];
      if (payload?.request?.payload?.type === "workspace.search") {
        attempts += 1;
        if (attempts === 1) {
          await new Promise<void>(resolve => { releaseFirstSearch = resolve; });
          throw new Error(canary);
        }
        return [];
      }
      return undefined;
    } } } });
  }, { workspace: restoredWorkspace, canary: nativeCanary });

  await page.goto("/");
  await page.keyboard.press("Control+k");
  const search = page.getByRole("searchbox", { name: "Search workspace" });
  await search.fill("stable second");
  const results = page.locator("#searchResults");
  await expect(results).toHaveClass(/search-results-loading/);
  await page.evaluate(() => (window as any).__motionSearchTest.releaseFirstSearch());
  await expect(results).toHaveAttribute("role", "alert");
  await expect(results).toHaveClass(/search-results-error/);
  await expect(results).toContainText("Search couldn’t be completed.");
  await expect(results).not.toContainText(nativeCanary);
  await expect(page.locator("body")).not.toContainText(nativeCanary);

  const retry = page.getByRole("button", { name: "Retry search" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(results).toHaveAttribute("role", "status");
  await expect(results).toHaveClass(/search-results-empty/);
  await expect(search).toHaveValue("stable second");
  expect(await page.evaluate(() => ({ attempts: (window as any).__motionSearchTest.attempts, saves: (window as any).__motionSearchTest.saves }))).toEqual({ attempts: 2, saves: 0 });
});

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
