import { expect, test, type Page } from "./fixtures";

const nestedFilter = {
  kind: "and", children: [
    { kind: "or", children: [
      { kind: "condition", propertyId: "name", operator: "contains", value: "Pump" },
      { kind: "condition", propertyId: "cost", operator: "gt", value: 500 }
    ] },
    { kind: "not", child: { kind: "condition", propertyId: "done", operator: "equals", value: true } }
  ]
};

async function seed(page: Page) {
  await page.goto("/");
  await page.evaluate(async filter => {
    const stamp = "2026-11-25T00:00:00.000Z";
    const records = [
      { id: "pump", title: "Pump service", cost: 100, done: false },
      { id: "motor", title: "Motor replacement", cost: 900, done: false },
      { id: "closed", title: "Pump completed", cost: 900, done: true },
      { id: "lighting", title: "Lighting", cost: 100, done: false }
    ];
    const properties = [
      { id: "name", name: "Name", type: "title" },
      { id: "cost", name: "Cost", type: "number" },
      { id: "done", name: "Done", type: "checkbox" },
      { id: "created", name: "Created", type: "created-time" },
      { id: "updated", name: "Updated", type: "updated-time" }
    ];
    const documentValue = {
      schemaVersion: 2, revision: 1, activePageId: "database-page", expandedPageIds: [], activeViewIds: { jobs: "filtered" },
      workspace: {
        schemaVersion: 2, id: "filter-workspace", name: "Filters", createdAt: stamp, updatedAt: stamp,
        attachments: [], linkIndex: [],
        pages: [
          { id: "database-page", parentId: null, title: "Jobs", createdAt: stamp, updatedAt: stamp, blocks: [] },
          ...records.map(record => ({ id: record.id, title: record.title, parentId: "database-page", collectionId: "jobs", blocks: [], properties: { cost: record.cost, done: record.done }, createdAt: stamp, updatedAt: stamp }))
        ],
        databases: [{
          id: "jobs", pageId: "database-page", name: "Jobs", properties, propertyOrder: properties.map(property => property.id), titlePropertyId: "name", rows: [], recordPageIds: records.map(record => record.id),
          views: [
            { id: "filtered", name: "Work to do", type: "table", visiblePropertyIds: ["name", "cost", "done"], propertyOrder: ["name", "cost", "done"], filters: filter },
            { id: "all", name: "All jobs", type: "table", visiblePropertyIds: ["name", "cost", "done"], propertyOrder: ["name", "cost", "done"] }
          ]
        }]
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
        transaction.objectStore("workspace").put(documentValue, "default");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, nestedFilter);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Jobs");
}

async function savedViews(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("motion-web-development", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<any[]>((resolve, reject) => {
        const request = database.transaction("workspace", "readonly").objectStore("workspace").get("default");
        request.onsuccess = () => resolve(request.result.workspace.databases[0].views);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
}

const record = (page: Page, name: string) => page.locator("#content").getByRole("button", { name, exact: true });

test("opening and applying nested filters preserves their tree, record results and independent views", async ({ page }) => {
  await seed(page);
  await expect(record(page, "Pump service")).toBeVisible();
  await expect(record(page, "Motor replacement")).toBeVisible();
  await expect(record(page, "Pump completed")).toHaveCount(0);
  await expect(record(page, "Lighting")).toHaveCount(0);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.locator(".filter-group")).toHaveCount(2);
  await expect(page.locator(".filter-clause")).toHaveCount(3);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  expect((await savedViews(page))[0].filters).toEqual(nestedFilter);
  expect((await savedViews(page))[1].filters).toBeUndefined();

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.locator(".filter-clause").nth(1).getByLabel("Filter value").fill("1000");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(record(page, "Pump service")).toBeVisible();
  await expect(record(page, "Motor replacement")).toHaveCount(0);
  const expected = structuredClone(nestedFilter);
  (expected.children[0] as any).children[1].value = 1000;
  expect((await savedViews(page))[0].filters).toEqual(expected);
  await page.reload();
  await expect(record(page, "Pump service")).toBeVisible();
  await expect(record(page, "Motor replacement")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Active database view" }).selectOption("all");
  for (const title of ["Pump service", "Motor replacement", "Pump completed", "Lighting"]) await expect(record(page, title)).toBeVisible();
});

test("nested groups can be added with the keyboard and cancelled without changing the saved view", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const addGroup = page.getByRole("button", { name: "+ Group", exact: true }).last();
  await addGroup.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".filter-group")).toHaveCount(3);
  const added = page.locator(".filter-group").last();
  await added.getByLabel("Match", { exact: true }).selectOption("or");
  await added.getByLabel("Negate group", { exact: true }).check();
  await added.getByLabel("Filter value").fill("Lighting");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".filter-editor")).toHaveCount(0);
  expect((await savedViews(page))[0].filters).toEqual(nestedFilter);
  await expect(page.getByRole("button", { name: "Filter", exact: true })).toBeFocused();
});

test("a failed filter save retains the confirmed view and the editable draft for retry", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.locator(".filter-clause").nth(1).getByLabel("Filter value").fill("1000");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      IDBObjectStore.prototype.put = original;
      throw new DOMException("Storage is full", "QuotaExceededError");
    };
  });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".filter-editor").getByRole("alert")).toContainText("Storage is full");
  expect((await savedViews(page))[0].filters).toEqual(nestedFilter);
  await expect(page.locator(".filter-clause").nth(1).getByLabel("Filter value")).toHaveValue("1000");
  await expect(record(page, "Motor replacement")).toBeVisible();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(record(page, "Motor replacement")).toHaveCount(0);
  expect((await savedViews(page))[0].filters.children[0].children[1].value).toBe(1000);
});

test("new nested groups and negation save, reload and remove without changing sibling branches", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("button", { name: "+ Group", exact: true }).last().click();
  const group = page.locator(".filter-group").last();
  await group.getByRole("combobox", { name: "Match", exact: true }).selectOption("or");
  await group.getByRole("checkbox", { name: "Negate group", exact: true }).check();
  await group.getByLabel("Filter value").fill("Motor replacement");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const expected = structuredClone(nestedFilter) as any;
  expected.children.push({ kind: "not", child: { kind: "or", children: [{ kind: "condition", propertyId: "name", operator: "equals", value: "Motor replacement" }] } });
  expect((await savedViews(page))[0].filters).toEqual(expected);
  await expect(record(page, "Pump service")).toBeVisible();
  await expect(record(page, "Motor replacement")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.locator(".filter-group").last().getByRole("button", { name: "Remove group", exact: true }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  expect((await savedViews(page))[0].filters).toEqual(nestedFilter);
  await expect(record(page, "Motor replacement")).toBeVisible();
});

test("failed Clear preserves an invalid draft and allows retry without changing the saved filter", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.locator(".filter-clause").nth(1).getByLabel("Filter value").fill("unfinished number");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      IDBObjectStore.prototype.put = original;
      throw new DOMException("Storage is full", "QuotaExceededError");
    };
  });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".filter-editor").getByRole("alert")).toContainText("Storage is full");
  expect((await savedViews(page))[0].filters).toEqual(nestedFilter);
  await expect(page.locator(".filter-clause").nth(1).getByLabel("Filter value")).toHaveValue("unfinished number");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".filter-editor")).toHaveCount(0);
  expect((await savedViews(page))[0].filters).toBeUndefined();
  await expect(record(page, "Pump completed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter", exact: true })).toBeFocused();
});

test("switching between date properties retains the chosen relative-date preset", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const condition = page.locator(".filter-clause").first();
  await condition.getByLabel("Filter property").selectOption("created");
  await condition.getByLabel("Filter comparison").selectOption("relative-date");
  await condition.getByLabel("Filter value").selectOption("past-week");
  await condition.getByLabel("Filter property").selectOption("updated");
  await expect(condition.getByLabel("Filter value")).toHaveValue("past-week");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  expect((await savedViews(page))[0].filters.children[0].children[0]).toEqual({ kind: "condition", propertyId: "updated", operator: "relative-date", value: "past-week" });
});
