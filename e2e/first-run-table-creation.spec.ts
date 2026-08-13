import { expect, test, type Page } from "./fixtures";

const layouts = [
  { name: "normal", viewport: { width: 1280, height: 800 } },
  { name: "equivalent 200%", viewport: { width: 640, height: 800 } }
] as const;

async function clean(page: Page) {
  await page.goto("/");
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("motion-web-development");
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
}

async function rootCreation(page: Page, name: "Add page" | "New table") {
  if ((page.viewportSize()?.width ?? 1280) <= 720 && !(await page.locator("#sidebar").evaluate(element => element.classList.contains("open"))))
    await page.getByRole("button", { name: "Open navigation" }).click();
  return page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name, exact: true });
}

async function exportWorkspace(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) <= 720) await page.getByRole("button", { name: "Open navigation" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  if ((page.viewportSize()?.width ?? 1280) <= 720) await page.getByRole("button", { name: "Close navigation" }).click();
  return Buffer.concat(chunks);
}

async function assertSingleCreation(page: Page, action: "Add page" | "New table", key: "Enter" | "Space", repeated = false) {
  await clean(page);
  const create = await rootCreation(page, action);
  await create.focus();
  if (repeated) {
    await page.keyboard.down(key);
    await page.keyboard.down(key);
    await page.keyboard.down(key);
    await page.keyboard.up(key);
  } else await page.keyboard.press(key);
  const titleName = action === "New table" ? "Database title" : "Page title";
  const defaultTitle = action === "New table" ? "Untitled database" : "Untitled page";
  await expect(page.getByRole("status")).toHaveText(`${action === "New table" ? "Table" : "Page"} created and saved.`);
  await expect(page.getByRole("textbox", { name: titleName })).toBeFocused();
  await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: defaultTitle, exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: defaultTitle, exact: true })).toHaveCount(1);
}

async function installFailingNativeSave(page: Page) {
  await page.addInitScript(() => {
    (window as any).__TAURI__ = { core: { invoke: async (command: string) => {
      if (command === "motion_ui_load") return { schemaVersion: 1, pages: [], activePageId: null };
      if (command === "motion_ui_save") throw new Error("injected save failure");
      throw new Error("unexpected native request");
    } } };
  });
}

for (const layout of layouts) {
  test.describe(layout.name, () => {
    test.use({ viewport: layout.viewport });

    test("MOTION-UX-008: page-first keeps a persistent root table action and preserves the table through search, Trash, restart and restore", async ({ page }) => {
      await clean(page);
      await (await rootCreation(page, "Add page")).click();
      await expect(page.getByRole("status")).toHaveText("Page created and saved.");
      await expect(await rootCreation(page, "New table")).toBeVisible();

      await (await rootCreation(page, "New table")).click();
      await expect(page.getByRole("status")).toHaveText("Table created and saved.");
      const title = page.getByRole("textbox", { name: "Database title" });
      await expect(title).toBeFocused();
      await title.fill("Persistent readings");
      await page.getByRole("button", { name: "+ New row" }).click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("durable-cell-008");
      await expect(page.getByRole("status")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Persistent readings");
      await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("durable-cell-008");
      await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "Persistent readings", exact: true })).toHaveCount(1);

      await page.keyboard.press("Control+k");
      await page.getByRole("searchbox", { name: "Search workspace" }).fill("durable-cell-008");
      const hit = page.locator("#searchResults").getByRole("button", { name: /Persistent readings.*durable-cell-008/ });
      await expect(hit).toHaveCount(1);
      await hit.press("Enter");
      await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();

      const backup = await exportWorkspace(page);
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "Trash", exact: true }).click();
      if (layout.viewport.width <= 720) await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.getByRole("navigation", { name: "Trash" }).getByRole("button", { name: "Restore Persistent readings" })).toBeVisible();
      await page.getByRole("navigation", { name: "Trash" }).getByRole("button", { name: "Restore Persistent readings" }).click();
      await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Persistent readings");

      page.once("dialog", dialog => dialog.accept());
      await page.locator("#restoreFile").setInputFiles({ name: "motion-backup.json", mimeType: "application/json", buffer: backup });
      await expect(page.getByRole("status")).toHaveText("Workspace restored.");
      await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("durable-cell-008");
    });

    test("MOTION-UX-008: table-first keyboard activation is single-shot and durable", async ({ page }) => {
      await clean(page);
      const create = await rootCreation(page, "New table");
      await create.focus();
      await Promise.all([create.press("Enter"), create.press("Space")]);
      await expect(page.getByRole("status")).toHaveText("Table created and saved.");
      await expect(page.getByRole("textbox", { name: "Database title" })).toBeFocused();
      await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "Untitled database", exact: true })).toHaveCount(1);
      await page.reload();
      await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "Untitled database", exact: true })).toHaveCount(1);
    });

    for (const action of ["Add page", "New table"] as const) for (const key of ["Enter", "Space"] as const) {
      test(`MOTION-UX-008: ${action} ${key} activation creates one durable root item with deterministic focus`, async ({ page }) => {
        await assertSingleCreation(page, action, key);
      });
    }

    for (const action of ["Add page", "New table"] as const) {
      test(`MOTION-UX-008: held/repeated Space on ${action} creates only one durable root item`, async ({ page }) => {
        await assertSingleCreation(page, action, "Space", true);
      });
    }
  });
}

test("MOTION-UX-008: save failure rolls creation back and reports failure without claiming success", async ({ page }) => {
  await installFailingNativeSave(page);
  await page.goto("/");
  const create = await rootCreation(page, "New table");
  await create.click();
  await expect(page.getByRole("status")).toHaveText("Table creation failed. No content was added.");
  await expect(create).toBeFocused();
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "Untitled database" })).toHaveCount(0);
});

test("MOTION-UX-008: Add page save failure rolls back, announces failure, and restores trigger focus", async ({ page }) => {
  await installFailingNativeSave(page);
  await page.goto("/");
  const create = await rootCreation(page, "Add page");
  await create.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Page creation failed. No content was added.");
  await expect(create).toBeFocused();
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "Untitled page" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "Untitled page" })).toHaveCount(0);
});

test("MOTION-UX-008: native verified backup restores created content and stable IDs into a clean workspace", async ({ page }) => {
  await page.addInitScript(() => {
    const empty = { schemaVersion: 1, pages: [], activePageId: null };
    const loadDocument = () => JSON.parse(localStorage.getItem("motion-native-test-document") ?? JSON.stringify(empty));
    const saveDocument = (value: any) => localStorage.setItem("motion-native-test-document", JSON.stringify(value));
    const revision = () => Number(localStorage.getItem("motion-native-test-revision") ?? 0);
    const advanceRevision = () => localStorage.setItem("motion-native-test-revision", String(revision() + 1));
    (window as any).__motionSavedBackup = null;
    (window as any).__TAURI__ = { core: { invoke: async (command: string, args: any) => {
      if (command === "motion_ui_load") return structuredClone(loadDocument());
      if (command === "motion_ui_save") { saveDocument(args.request.document); advanceRevision(); return null; }
      if (command === "motion_backup_save") { (window as any).__motionSavedBackup = structuredClone(args.request.bundle); return { saved: true, replaced: false, cancelled: false }; }
      if (command !== "app_dispatch") throw new Error(`unexpected native request: ${command}`);
      const payload = args.request.payload;
      if (payload.type === "workspace.list") return [{ id: "native-workspace", revision: revision() }];
      if (payload.type === "backup.create") return { format: "motion-test-verified", document: structuredClone(loadDocument()) };
      if (payload.type === "backup.verify") return { valid: payload.bundle?.format === "motion-test-verified", errors: [] };
      if (payload.type === "backup.preview") return { workspaceName: "First run", pages: payload.bundle.document.pages.length, attachments: 0, totalBytes: JSON.stringify(payload.bundle).length };
      if (payload.type === "backup.restore-new") { saveDocument(payload.bundle.document); advanceRevision(); return { workspace: { id: "restored-workspace" }, revision: revision() }; }
      throw new Error(`unexpected native payload: ${payload.type}`);
    } } };
  });
  await page.goto("/");
  await (await rootCreation(page, "Add page")).click();
  await page.getByRole("textbox", { name: "Page title" }).fill("Durable native page");
  await (await rootCreation(page, "New table")).click();
  await page.getByRole("textbox", { name: "Database title" }).fill("Durable native table");
  await page.getByRole("button", { name: "+ New row" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("native-backup-cell-008");
  await expect(page.getByRole("status")).toHaveText("Saved to Motion");
  const before = await page.evaluate(() => (window as any).__TAURI__.core.invoke("motion_ui_load", { request: { schemaVersion: 1 } }));

  await page.getByRole("button", { name: "Verified backup" }).click();
  await expect(page.getByRole("status")).toHaveText("Verified backup saved safely.");
  const bundle = await page.evaluate(() => (window as any).__motionSavedBackup);
  expect(bundle.document).toEqual(before);

  await page.evaluate(() => (window as any).__TAURI__.core.invoke("motion_ui_save", { request: { schemaVersion: 1, document: { schemaVersion: 1, pages: [], activePageId: null } } }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#verifiedBackupFile").setInputFiles({ name: "motion-verified-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)) });
  await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Durable native table");
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("native-backup-cell-008");
  const after = await page.evaluate(() => (window as any).__TAURI__.core.invoke("motion_ui_load", { request: { schemaVersion: 1 } }));
  expect(after).toEqual(before);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Durable native table");
  await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "Durable native page", exact: true })).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "Durable native table", exact: true })).toHaveCount(1);
});
