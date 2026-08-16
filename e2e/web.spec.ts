import { expect, test } from "./fixtures";

test("local Web workspace persists, searches and exports without external network access", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "Untitled page" })).toHaveCount(0);

  await page.getByRole("button", { name: "New page" }).click();
  const title = page.getByRole("textbox", { name: "Page title" });
  await title.fill("Pump commissioning notes");
  await title.blur();
  await expect(page.locator("#saveState")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);
  const body = page.locator('[contenteditable="true"][data-block]').first();
  await body.fill("Verified local pressure and flow before startup.");
  await body.blur();
  await expect(page.locator("#saveState")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);
  await expect.poll(() => page.evaluate(async () => {
    const request = indexedDB.open("motion-web-development", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
    try { return await new Promise<string>((resolve, reject) => { const read=database.transaction("workspace","readonly").objectStore("workspace").get("default"); read.onsuccess=()=>resolve(read.result?.workspace?.pages?.[0]?.blocks?.[0]?.text ?? ""); read.onerror=()=>reject(read.error); }); }
    finally { database.close(); }
  })).toBe("Verified local pressure and flow before startup.");
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map(database => database.name)))
    .toContain("motion-web-development");

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Pump commissioning notes");
  await expect(page.locator('[contenteditable="true"][data-block]').first()).toHaveText("Verified local pressure and flow before startup.");

  await page.getByRole("button", { name: /Search/ }).click();
  await page.getByRole("searchbox", { name: "Search workspace" }).fill("pressure");
  await expect(page.locator("#searchResults").getByRole("button", { name: /Pump commissioning notes/ })).toBeVisible();
  await page.getByRole("button", { name: "Close search" }).click();

  await page.locator("details.workspace-tools").getByText("Workspace tools", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^motion-(?:browser-development|canonical-export)-\d{4}-\d{2}-\d{2}\.json$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const pages = exported.workspace?.pages ?? JSON.parse(exported.files?.["workspace.json"] ?? "{}").pages;
  expect(pages[0]).toMatchObject({
    title: "Pump commissioning notes",
    blocks: [expect.objectContaining({ text: "Verified local pressure and flow before startup." })]
  });

  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  const pageNavigation = page.getByRole("navigation", { name: "Workspace pages" });
  const trashNavigation = page.getByRole("navigation", { name: "Trash" });
  await expect(pageNavigation.getByRole("button", { name: "Pump commissioning notes", exact: true })).toHaveCount(0);
  await expect(trashNavigation.getByRole("button", { name: "Restore Pump commissioning notes" })).toBeVisible();

  await page.getByRole("button", { name: /Search/ }).click();
  await page.getByRole("searchbox", { name: "Search workspace" }).fill("pressure");
  await expect(page.locator("#searchResults").getByRole("button", { name: /Pump commissioning notes/ })).toHaveCount(0);
  await expect(page.locator("#searchResults")).toContainText("No results");
  await page.getByRole("button", { name: "Close search" }).click();

  await page.reload();
  await expect(pageNavigation.getByRole("button", { name: "Pump commissioning notes", exact: true })).toHaveCount(0);
  await expect(trashNavigation.getByRole("button", { name: "Restore Pump commissioning notes" })).toBeVisible();
  const trashedPage = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("motion-web-development", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const workspace = await new Promise<any>((resolve, reject) => {
        const request = database.transaction("workspace", "readonly").objectStore("workspace").get("default");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return workspace.workspace.pages.find((candidate: any) => candidate.title === "Pump commissioning notes");
    } finally { database.close(); }
  });
  expect(trashedPage).toMatchObject({
    deletedAt: expect.any(String),
    blocks: [expect.objectContaining({ text: "Verified local pressure and flow before startup." })]
  });

  await trashNavigation.getByRole("button", { name: "Restore Pump commissioning notes" }).click();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Pump commissioning notes");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Pump commissioning notes");
  await expect(page.locator('[contenteditable="true"][data-block]').first()).toHaveText("Verified local pressure and flow before startup.");
  await expect(trashNavigation.getByRole("button", { name: "Restore Pump commissioning notes" })).toHaveCount(0);
});

test("initial record properties expose canonical date ranges, attachment IDs, and read-only metadata", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const request = indexedDB.open("motion-web-development", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const workspace = {
      schemaVersion: 2, id: "workspace", name: "Property editors", createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T02:00:00.000Z",
      linkIndex: [],
      attachments: [
        { id: "attachment-1", fileName: "brief.txt", mediaType: "text/plain", byteLength: 5, sha256: "a".repeat(64), path: "objects/a", createdAt: "2026-08-14T00:00:00.000Z" },
        { id: "attachment-2", fileName: "plan.pdf", mediaType: "application/pdf", byteLength: 10, sha256: "b".repeat(64), path: "objects/b", createdAt: "2026-08-14T00:00:00.000Z" }
      ],
      pages: [
        { id: "database-page", parentId: null, title: "Projects", blocks: [], createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z" },
        { id: "record-page", parentId: "database-page", collectionId: "projects", title: "Canonical record title", blocks: [], createdAt: "2026-08-14T01:00:00.000Z", updatedAt: "2026-08-14T02:00:00.000Z", createdBy: "author-id", updatedBy: "editor-id", properties: {} }
      ],
      databases: [{
        id: "projects", pageId: "database-page", name: "Projects", rows: [], recordPageIds: ["record-page"],
        properties: [
          { id: "name", name: "Name", type: "title" }, { id: "window", name: "Window", type: "date-range" },
          { id: "files", name: "Files", type: "files" }, { id: "created", name: "Created", type: "created-time" },
          { id: "updated", name: "Updated", type: "updated-time" }, { id: "creator", name: "Creator", type: "created-by" },
          { id: "editor", name: "Editor", type: "updated-by" }
        ],
        propertyOrder: ["name", "window", "files", "created", "updated", "creator", "editor"], titlePropertyId: "name",
        views: [{ id: "table", collectionId: "projects", name: "Table", type: "table", visiblePropertyIds: ["name", "window", "files", "created", "updated", "creator", "editor"], propertyOrder: ["name", "window", "files", "created", "updated", "creator", "editor"] }]
      }]
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const write = database.transaction("workspace", "readwrite").objectStore("workspace").put({ schemaVersion: 2, workspace, revision: 1, activePageId: "record-page", expandedPageIds: [], activeViewIds: {} }, "default");
        write.onsuccess = () => resolve(); write.onerror = () => reject(write.error);
      });
    } finally { database.close(); }
  });
  await page.reload();

  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Canonical record title");
  await expect(page.getByLabel("Created", { exact: true })).toHaveText("2026-08-14T01:00:00.000Z");
  await expect(page.getByLabel("Updated", { exact: true })).toHaveText("2026-08-14T02:00:00.000Z");
  await expect(page.getByLabel("Creator", { exact: true })).toHaveText("author-id");
  await expect(page.getByLabel("Editor", { exact: true })).toHaveText("editor-id");
  await expect(page.getByLabel("Created", { exact: true })).not.toHaveAttribute("data-property");

  await page.getByLabel("Window start").fill("2026-08-14");
  await page.getByLabel("Window end").fill("2026-08-16");
  await page.getByLabel("Files", { exact: true }).selectOption(["attachment-1", "attachment-2"]);
  await expect(page.locator("#saveState")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);
  await page.reload();
  await expect(page.getByLabel("Window start")).toHaveValue("2026-08-14");
  await expect(page.getByLabel("Window end")).toHaveValue("2026-08-16");
  await expect(page.getByLabel("Files", { exact: true })).toHaveValues(["attachment-1", "attachment-2"]);

  const properties = await page.evaluate(async () => {
    const request = indexedDB.open("motion-web-development", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<any>((resolve, reject) => { const read = database.transaction("workspace", "readonly").objectStore("workspace").get("default"); read.onsuccess = () => resolve(read.result.workspace.pages.find((candidate: any) => candidate.id === "record-page").properties); read.onerror = () => reject(read.error); }); }
    finally { database.close(); }
  });
  expect(properties).toEqual({
    window: { start: "2026-08-14T00:00:00.000Z", end: "2026-08-16T00:00:00.000Z" },
    files: { attachmentIds: ["attachment-1", "attachment-2"] }
  });
});

test("typed table records open as pages and retain view state", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "New table", exact: true }).click();
  await page.getByRole("textbox", { name: "Database title" }).fill("Jobs");
  await page.getByRole("textbox", { name: "Database title" }).press("Tab");
  await expect(page.locator("#saveState")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);

  page.once("dialog", dialog => dialog.accept("Status"));
  await page.getByRole("button", { name: "+ Property" }).click();
  await page.getByRole("toolbar", { name: "Database views" }).getByRole("button", { name: "Status", exact: true }).click();
  await page.locator("#propertyType").selectOption("status");
  await page.locator("#propertyOptions").fill("To do, In progress, Done");
  await page.getByRole("button", { name: "Save" }).click();

  page.once("dialog", dialog => dialog.accept("Cost"));
  await page.getByRole("button", { name: "+ Property" }).click();
  await page.getByRole("toolbar", { name: "Database views" }).getByRole("button", { name: "Cost", exact: true }).click();
  await page.locator("#propertyType").selectOption("number");
  await page.getByRole("button", { name: "Save" }).click();

  await page.getByRole("button", { name: "+ New record" }).click();
  await page.getByRole("button", { name: "Untitled", exact: true }).click();
  await page.getByRole("textbox", { name: "Page title" }).fill("Replace heat pump");
  await page.getByRole("textbox", { name: "Page title" }).blur();
  await expect(page.locator("#saveState")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);
  await page.getByLabel("Status").selectOption({ label: "In progress" });
  await expect(page.locator("#saveState")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);
  await page.getByLabel("Cost").fill("4200");
  await page.getByLabel("Cost").blur();
  await expect(page.locator("#saveState")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);
  await page.getByRole("button", { name: "+ Add block" }).click();
  const recordBody = page.locator('[contenteditable="true"][data-block]').last();
  await recordBody.fill("Need quotes from three suppliers.");
  await recordBody.press("Tab");
  await expect(page.locator("#saveState")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);

  await page.locator('[data-back]').click();
  await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Jobs");
  await expect(page.getByRole("button", { name: "Replace heat pump", exact: true })).toBeVisible();
  const recordRow = page.getByRole("button", { name: "Replace heat pump", exact: true }).locator("xpath=ancestor::tr");
  await expect(recordRow.getByLabel("Status", { exact: true })).toHaveValue(/.+/);
  await expect(recordRow.getByLabel("Cost", { exact: true })).toHaveValue("4200");

  await page.getByRole("button", { name: "Sort" }).click();
  await page.locator("[data-sort-property]").first().selectOption({ label: "Status" });
  await page.getByRole("button", { name: "+ Clause" }).click();
  await page.locator("[data-sort-property]").nth(1).selectOption({ label: "Cost" });
  await page.locator("[data-sort-direction]").nth(1).selectOption("desc");
  await page.getByRole("button", { name: "Apply sorts" }).click();

  await page.getByRole("button", { name: "Filter" }).click();
  await page.locator("#filterProperty").selectOption({ label: "Status" });
  await page.locator("#filterOperator").selectOption("not-equals");
  const statusValue = await page.getByLabel("Status", { exact: true }).inputValue();
  await page.locator("#filterValue").fill(statusValue);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("button", { name: "Replace heat pump", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByRole("button", { name: "Replace heat pump", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "+ List view" }).click();
  await expect(page.getByRole("combobox", { name: "Active database view" })).toHaveValue(/.+/);
  await expect(page.getByRole("list", { name: "List list" })).toBeVisible();
  await expect(page.getByRole("listitem").getByRole("button", { name: "Replace heat pump", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Filter" }).click();
  await page.locator("#filterProperty").selectOption({ label: "Status" });
  await page.locator("#filterOperator").selectOption("not-equals");
  await page.locator("#filterValue").fill(statusValue);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("button", { name: "Replace heat pump", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Active database view" }).selectOption({ label: "Table · table" });
  await expect(page.getByRole("button", { name: "Replace heat pump", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Jobs");
  await expect(page.getByRole("combobox", { name: "Active database view" })).toHaveValue(/.+/);
  await expect(page.getByRole("button", { name: "Replace heat pump", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Replace heat pump", exact: true }).click();
  await expect(page.getByLabel("Status", { exact: true })).not.toHaveValue("");
  await expect(page.getByLabel("Cost", { exact: true })).toHaveValue("4200");
  await expect(page.locator('[contenteditable="true"][data-block]').last()).toHaveText("Need quotes from three suppliers.");
});
