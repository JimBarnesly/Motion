import { expect, test, type Page } from "./fixtures";

async function readStored(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("motion-web-development", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<any>((resolve, reject) => {
        const transaction = database.transaction("workspace", "readonly");
        const request = transaction.objectStore("workspace").get("default");
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
  });
}

async function seed(page: Page, { selected = "primary", deleted = false, withSurvivor = true }: {
  selected?: string | null; deleted?: boolean; withSurvivor?: boolean;
} = {}) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
  await page.evaluate(async options => {
    const stamp = "2026-11-25T00:00:00.000Z";
    const value = {
      schemaVersion: 2, revision: 9, activePageId: options.selected, expandedPageIds: [], activeViewIds: {},
      workspace: {
        schemaVersion: 2, id: "lifecycle-workspace", name: "Lifecycle", createdAt: stamp, updatedAt: stamp,
        attachments: [], databases: [], linkIndex: [],
        pages: [
          { id: "primary", parentId: null, title: "Restorable page", createdAt: stamp, updatedAt: stamp,
            ...(options.deleted ? { deletedAt: stamp } : {}),
            blocks: [{ id: "primary-block", type: "paragraph", text: "Canonical content remains intact", children: [] }] },
          ...(options.withSurvivor ? [
            { id: "survivor", parentId: null, title: "Surviving page", createdAt: stamp, updatedAt: stamp, blocks: [] },
            { id: "other", parentId: null, title: "Other page", createdAt: stamp, updatedAt: stamp, blocks: [] }
          ] : [])
        ]
      }
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("motion-web-development", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("workspace", "readwrite");
        transaction.objectStore("workspace").put(value, "default");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, { selected, deleted, withSurvivor });
  const before = await readStored(page);
  await page.reload();
  await expect(page.locator("#saveState")).toHaveText("Browser development mode");
  return before;
}

for (const scenario of [
  { name: "deleted selection", selected: "primary", deleted: true, withSurvivor: true, expectedTitle: "Surviving page" },
  { name: "missing selection", selected: "missing", deleted: true, withSurvivor: true, expectedTitle: "Surviving page" },
  { name: "all pages in Trash", selected: "primary", deleted: true, withSurvivor: false, expectedTitle: null },
  { name: "explicit workspace home", selected: null, deleted: false, withSurvivor: true, expectedTitle: null }
]) {
  test(`loading ${scenario.name} keeps canonical content and chooses a valid UI selection`, async ({ page }) => {
    const before = await seed(page, scenario);
    if (scenario.expectedTitle) {
      await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue(scenario.expectedTitle);
    } else {
      await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveCount(0);
    }
    expect((await readStored(page)).workspace).toEqual(before.workspace);
  });
}

test("Trash and Restore persist the canonical change and selected page before announcing completion", async ({ page }) => {
  await seed(page);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(page.locator("#saveState")).toHaveText("Page moved to Trash");
  const trashed = await readStored(page);
  expect(trashed.activePageId).toBe("survivor");
  expect(trashed.workspace.pages[0].deletedAt).toEqual(expect.any(String));
  expect(trashed.workspace.pages[0].blocks[0].text).toBe("Canonical content remains intact");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Surviving page");
  await page.getByRole("button", { name: "Restore Restorable page", exact: true }).click();
  await expect(page.locator("#saveState")).toHaveText("Page restored");
  const restored = await readStored(page);
  expect(restored.activePageId).toBe("primary");
  expect(restored.workspace.pages[0]).not.toHaveProperty("deletedAt");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Restorable page");
  await expect(page.locator('[data-block="primary-block"]')).toHaveText("Canonical content remains intact");
  await expect(page.getByRole("button", { name: "Restore Restorable page", exact: true })).toHaveCount(0);
});

for (const outcome of ["abort", "complete"] as const) {
  test(`a held Restore transaction ${outcome}s without an intervening navigation, retry, or undo write`, async ({ page }) => {
    const before = await seed(page, { selected: "survivor", deleted: true });
    page.on("dialog", dialog => dialog.accept());
    await page.evaluate(() => {
      const runtime = window as any;
      const original = IDBObjectStore.prototype.put;
      runtime.__lifecyclePutCount = 0;
      runtime.__lifecyclePutSucceeded = false;
      runtime.__restoreLifecyclePut = () => { IDBObjectStore.prototype.put = original; };
      IDBObjectStore.prototype.put = function (...args: any[]) {
        const request = original.apply(this, args as [any, IDBValidKey]);
        runtime.__lifecyclePutCount += 1;
        if (runtime.__lifecyclePutCount === 1) {
          request.addEventListener("success", () => {
            const transaction = request.transaction!;
            let holding = true;
            runtime.__lifecyclePutSucceeded = true;
            runtime.__releaseLifecycleWrite = (commit = false) => {
              if (!holding) return;
              holding = false;
              if (!commit) transaction.abort();
            };
            // Real read requests keep this real IndexedDB transaction active.
            // No mock success or timer substitutes for its eventual commit/abort.
            const keepAlive = () => {
              if (holding) transaction.objectStore("workspace").get("default").addEventListener("success", keepAlive);
            };
            keepAlive();
          });
        }
        return request;
      };
    });
    try {
      await page.getByRole("button", { name: "Restore Restorable page", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__lifecyclePutSucceeded)).toBe(true);
      await expect(page.locator("#saveState")).toHaveText("Saving…");
      await page.locator('#pageTree [data-open-page="other"]').click();
      await page.getByRole("button", { name: "Restore Restorable page", exact: true }).click();
      await page.keyboard.press("Control+z");
      expect(await page.evaluate(() => (window as any).__lifecyclePutCount)).toBe(1);
      await expect(page.locator("#saveState")).toHaveText("Saving…");
      await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Surviving page");
      await page.evaluate(commit => (window as any).__releaseLifecycleWrite(commit), outcome === "complete");
      await expect(page.locator("#saveState")).toHaveText(outcome === "abort" ? "Save failed" : "Page restored");
      const after = await readStored(page);
      expect(await page.evaluate(() => (window as any).__lifecyclePutCount)).toBe(1);
      if (outcome === "abort") {
        expect(after).toEqual(before);
        await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Surviving page");
        await expect(page.getByRole("button", { name: "Restore Restorable page", exact: true })).toBeVisible();
      } else {
        expect(after.activePageId).toBe("primary");
        expect(after.workspace.pages[0]).not.toHaveProperty("deletedAt");
        expect(after.workspace.pages[0].blocks).toEqual(before.workspace.pages[0].blocks);
        expect(after.workspace.pages.slice(1)).toEqual(before.workspace.pages.slice(1));
        await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Restorable page");
        await expect(page.getByRole("button", { name: "Restore Restorable page", exact: true })).toHaveCount(0);
      }
    } finally {
      await page.evaluate(() => {
        (window as any).__releaseLifecycleWrite?.();
        (window as any).__restoreLifecyclePut?.();
      });
    }
    if (outcome === "abort") {
      await page.getByRole("button", { name: "Restore Restorable page", exact: true }).click();
      await expect(page.locator("#saveState")).toHaveText("Page restored");
      const retried = await readStored(page);
      expect(retried.activePageId).toBe("primary");
      expect(retried.workspace.pages[0]).not.toHaveProperty("deletedAt");
    }
  });
}

test("browser adapter rejects a read transaction aborted after its get request succeeds", async ({ page }) => {
  const before = await seed(page);
  const result = await page.evaluate(async () => {
    const { createMotionUiAdapter } = await import("/app-adapter.js");
    const original = IDBObjectStore.prototype.get;
    let requestSucceeded = false;
    IDBObjectStore.prototype.get = function (key) {
      const request = original.call(this, key);
      request.addEventListener("success", () => {
        requestSucceeded = true;
        request.transaction!.abort();
      });
      return request;
    };
    try {
      try { await createMotionUiAdapter({}).load(); return { outcome: "resolved", requestSucceeded }; }
      catch (error) { return { outcome: "rejected", requestSucceeded, name: (error as Error).name }; }
    } finally { IDBObjectStore.prototype.get = original; }
  });
  expect(result).toEqual({ outcome: "rejected", requestSucceeded: true, name: "AbortError" });
  expect(await readStored(page)).toEqual(before);
});
