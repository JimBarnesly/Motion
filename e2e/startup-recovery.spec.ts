import { expect, test } from "./fixtures";

test("initial native load stays gated through rejection and invalid data, then retries an empty workspace", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const runtime = window as any;
    runtime.__startupLoads = 0;
    runtime.__startupOtherCommands = [];
    runtime.__TAURI__ = { core: { invoke: (command: string) => {
      if (command !== "motion_ui_load") {
        runtime.__startupOtherCommands.push(command);
        return Promise.reject(new Error("No mutations are authorized during startup"));
      }
      runtime.__startupLoads += 1;
      return new Promise((resolve, reject) => {
        runtime.__resolveStartup = resolve;
        runtime.__rejectStartup = () => reject(new Error("PRIVATE_STARTUP_CANARY C:\\Users\\Private\\notebook.sqlite3"));
      });
    } } };
  });
  await page.goto("/", { waitUntil: "commit" });
  await expect.poll(() => page.evaluate(() => (window as any).__startupLoads)).toBe(1);
  await expect(page.locator("#saveState")).toHaveText("Opening Motion…");
  await expect(page.locator("#content")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("heading", { name: "Opening Motion…" })).toBeVisible();
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("button", { name: "New table", exact: true }).click();
  await page.getByRole("button", { name: /Search Ctrl K/ }).click();
  expect(await page.evaluate(() => (window as any).__startupOtherCommands)).toEqual([]);
  await expect(page.locator("#searchDialog")).not.toBeVisible();

  await page.evaluate(() => (window as any).__rejectStartup());
  await expect(page.locator("#saveState")).toHaveText("Could not open Motion");
  await expect(page.locator("#content")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("alert")).toHaveText("Try again to load your local workspace.");
  await expect(page.getByRole("button", { name: "Retry opening Motion" })).toBeFocused();
  await expect(page.locator("body")).not.toContainText("PRIVATE_STARTUP_CANARY");
  await expect(page.locator("body")).not.toContainText("notebook.sqlite3");
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toHaveCount(0);

  // Two synchronous activations of the same retry control authorize one load.
  await page.getByRole("button", { name: "Retry opening Motion" }).evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => page.evaluate(() => (window as any).__startupLoads)).toBe(2);
  await expect(page.locator("#saveState")).toHaveText("Opening Motion…");
  await expect(page.getByRole("button", { name: "Retry opening Motion" })).toHaveCount(0);
  await page.evaluate(() => (window as any).__resolveStartup({
    schemaVersion: 2, revision: 1, activePageId: null,
    workspace: { schemaVersion: 2, id: "safe-workspace", pages: [{ id: "<invalid-page-id>" }], databases: [], attachments: [], linkIndex: [] }
  }));
  await expect(page.locator("#saveState")).toHaveText("Could not open Motion");
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toHaveCount(0);
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__startupOtherCommands)).toEqual([]);
  await page.getByRole("button", { name: "Retry opening Motion" }).press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).__startupLoads)).toBe(3);
  await page.evaluate(() => (window as any).__resolveStartup({ schemaVersion: 2, workspace: null, revision: 0, activePageId: null }));

  await expect(page.locator("#saveState")).toHaveText("Connected to Motion");
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
  await expect(page.locator("#content")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("[data-startup-state]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__startupOtherCommands)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("browser startup retry loads existing IndexedDB content without substituting an empty workspace", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const runtime = window as any;
    const originalOpen = indexedDB.open.bind(indexedDB);
    runtime.__openStoredWorkspace = originalOpen;
    runtime.__allowBrowserStartup = false;
    Object.defineProperty(indexedDB, "open", { value: (name: string, version?: number) => {
      if (runtime.__allowBrowserStartup) return originalOpen(name, version);
      const request: any = {};
      queueMicrotask(() => {
        request.error = new DOMException("PRIVATE_BROWSER_CANARY", "UnknownError");
        request.onerror?.();
      });
      return request;
    } });
  });
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByRole("button", { name: "Retry opening Motion" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("PRIVATE_BROWSER_CANARY");
  await page.evaluate(async () => {
    const runtime = window as any;
    const stamp = "2026-11-25T00:00:00.000Z";
    const stored = {
      schemaVersion: 2, revision: 7, activePageId: "existing-page", expandedPageIds: [], activeViewIds: {},
      workspace: {
        schemaVersion: 2, id: "existing-workspace", name: "Existing local notebook",
        pages: [{ id: "existing-page", parentId: null, title: "Kept after retry",
          blocks: [{ id: "existing-block", type: "paragraph", text: "Existing canonical text stays intact.", children: [] }],
          createdAt: stamp, updatedAt: stamp }],
        databases: [], attachments: [], linkIndex: [], createdAt: stamp, updatedAt: stamp
      }
    };
    await new Promise<void>((resolve, reject) => {
      const request = runtime.__openStoredWorkspace("motion-web-development", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("workspace");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("workspace", "readwrite");
        transaction.objectStore("workspace").put(stored, "default");
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    });
    runtime.__expectedStoredWorkspace = stored;
    runtime.__allowBrowserStartup = true;
  });
  await page.getByRole("button", { name: "Retry opening Motion" }).press("Enter");
  await expect(page.locator("#saveState")).toHaveText("Browser development mode");
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Kept after retry");
  await expect(page.locator('[data-block="existing-block"]')).toHaveText("Existing canonical text stays intact.");
  await expect(page.locator("#content")).toHaveAttribute("aria-busy", "false");
  expect(await page.evaluate(async () => {
    const runtime = window as any;
    const saved = await new Promise((resolve, reject) => {
      const request = runtime.__openStoredWorkspace("motion-web-development", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const read = database.transaction("workspace", "readonly").objectStore("workspace").get("default");
        read.onsuccess = () => { database.close(); resolve(read.result); };
        read.onerror = () => { database.close(); reject(read.error); };
      };
    });
    return JSON.stringify(saved) === JSON.stringify(runtime.__expectedStoredWorkspace);
  })).toBe(true);
  expect(pageErrors).toEqual([]);
});
