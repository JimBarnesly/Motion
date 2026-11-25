import { expect, test, type Page } from "./fixtures";

async function stored(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open("motion-web-development", 1);opening.onsuccess = () => resolve(opening.result);opening.onerror = () => reject(opening.error);
    });
    try { return await new Promise<any>((resolve, reject) => {
      const transaction = database.transaction("workspace", "readonly"), reading = transaction.objectStore("workspace").get("default");
      transaction.oncomplete = () => resolve(reading.result);transaction.onabort = () => reject(transaction.error);transaction.onerror = () => reject(transaction.error);
    }); } finally { database.close(); }
  });
}

async function seed(page: Page, options: { active?: string; board?: Record<string, unknown>; required?: boolean; hostile?: boolean; noGrouping?: boolean } = {}) {
  await page.goto("/");await expect(page.locator("#saveState")).toHaveText("Browser development mode");
  await page.evaluate(async options => {
    const stamp = "2026-11-25T00:00:00.000Z";
    const title = options.hostile ? 'Alpha <button data-trash-page="db-page">keep</button>' : "Alpha";
    const statusName = options.hostile ? 'Status <img src="bad">' : "Status";
    const properties: any[] = [{ id: "title", name: "Name", type: "title" }, { id: "score", name: "Priority", type: "number" }];
    if (!options.noGrouping) properties.splice(1, 0,
      { id: "status", name: statusName, type: "status", ...(options.required ? { validation: { required: true } } : {}), options: [
        { id: "doing", name: "In progress" }, { id: "todo", name: options.hostile ? 'To <button data-trash-page="db-page">do</button>' : "To do" },
        { id: "done", name: "Done" }, { id: "later", name: "Later" }
      ] }, { id: "category", name: "Category", type: "select", options: [{ id: "work", name: "Work" }, { id: "home", name: "Home" }] });
    const ids = properties.map(property => property.id);
    const base = { collectionId: "database", visiblePropertyIds: ids, propertyOrder: ids, sorts: [] };
    const views = [{ ...base, id: "table", name: "Table", type: "table" }, { ...base, id: "list", name: "List", type: "list" },
      { ...base, id: "board", name: "Status board", type: "board", ...(!options.noGrouping ? { groupByPropertyId: "status" } : {}), ...options.board }];
    const recordData = [
      { id: "a", title, status: "todo", category: "work", score: 3 },
      { id: "b", title: "Bravo", status: "done", category: "home", score: 1 },
      { id: "c", title: "Charlie", status: options.required ? "todo" : null, category: "work", score: 2 },
      { id: "d", title: "Delta", status: options.required ? "doing" : undefined, category: null, score: 4 }
    ];
    const records = recordData.map(record => ({ id: record.id, parentId: "db-page", title: record.title, collectionId: "database",
      properties: { score: record.score, ...(!options.noGrouping ? { status: record.status, category: record.category } : {}) },
      blocks: [{ id: `body-${record.id}`, type: "paragraph", text: `Keep ${record.id} body`, children: [] },
        { id: `opaque-${record.id}`, type: "future-widget", text: "Preserve extension", children: [], unknownData: { retained: [true, { id: record.id }] } }],
      createdAt: stamp, updatedAt: stamp, unknownData: { retained: `record-${record.id}` } }));
    const value = { schemaVersion: 2, revision: 9, activePageId: "db-page", expandedPageIds: [], activeViewIds: { database: options.active ?? "board" }, collapsedBlockIds: [],
      workspace: { schemaVersion: 2, id: "workspace", name: "Board fixture", createdAt: stamp, updatedAt: stamp, attachments: [], linkIndex: [],
        pages: [{ id: "db-page", parentId: null, title: "Work board", blocks: [], createdAt: stamp, updatedAt: stamp }, ...records],
        databases: [{ id: "database", pageId: "db-page", name: "Work board", titlePropertyId: "title", properties, propertyOrder: ids,
          rows: [], recordPageIds: recordData.map(record => record.id), views }] } };
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const opening = indexedDB.open("motion-web-development", 1);opening.onsuccess = () => resolve(opening.result);opening.onerror = () => reject(opening.error); });
    try { await new Promise<void>((resolve, reject) => { const transaction = database.transaction("workspace", "readwrite");transaction.objectStore("workspace").put(value, "default");transaction.oncomplete = () => resolve();transaction.onabort = () => reject(transaction.error);transaction.onerror = () => reject(transaction.error); }); }
    finally { database.close(); }
  }, options);
  await page.reload();await expect(page.getByRole("textbox", { name: "Database title", exact: true })).toHaveValue("Work board");
  return stored(page);
}

async function failNextWrite(page: Page, hold = false, ordinal = 1) {
  await page.evaluate(({ hold, ordinal }) => {
    const runtime = window as any, original = IDBObjectStore.prototype.put;
    runtime.__boardWrites = 0;runtime.__boardPutSucceeded = false;runtime.__boardRelease = false;runtime.__boardTimedOut = false;
    runtime.__restoreBoardPut = () => { IDBObjectStore.prototype.put = original; };
    IDBObjectStore.prototype.put = function (...args: any[]) {
      const write = original.apply(this, args as [any, IDBValidKey]);runtime.__boardWrites++;
      if (runtime.__boardWrites === ordinal) write.addEventListener("success", () => {
        runtime.__boardPutSucceeded = true;
        const transaction = this.transaction, store = this, deadline = Date.now() + 8_000;
        const keepAlive = () => {
          if (!hold || runtime.__boardRelease) { transaction.abort();return; }
          if (Date.now() > deadline) { runtime.__boardTimedOut = true;transaction.abort();return; }
          store.get("default").addEventListener("success", keepAlive);
        };keepAlive();
      });
      return write;
    };
  }, { hold, ordinal });
}

test("status and select boards share table/list filter and sort results without rewriting records", async ({ page }) => {
  const before = await seed(page, { board: { filters: { kind: "condition", propertyId: "score", operator: "gt", value: 1 }, sorts: [{ propertyId: "score", direction: "asc" }] } });
  await expect(page.locator(".board-lane-heading > span:first-child")).toHaveText(["In progress", "To do", "Done", "Later", "Unassigned"]);
  await expect(page.locator('[data-board-lane=""]').getByRole("listitem")).toHaveCount(2);
  await expect(page.locator('[data-board-lane=""] .board-card-link')).toHaveText(["Charlie", "Delta"]);
  await expect(page.locator('[data-board-lane="todo"] .board-card-link')).toHaveText(["Alpha"]);
  await expect(page.locator('[data-record-drag],[data-record-move]')).toHaveCount(0);
  await page.locator("#boardGrouping").selectOption("category");await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
  await expect(page.locator(".board-lane-heading > span:first-child")).toHaveText(["Work", "Home", "Unassigned"]);
  await expect(page.locator('[data-board-lane="work"] .board-card-link')).toHaveText(["Charlie", "Alpha"]);
  await page.locator("#addTableView").click();await expect(page.locator("#saveState")).toHaveText("View saved.");
  await expect(page.locator("tbody .record-link")).toHaveText(["Charlie", "Alpha", "Delta"]);
  await page.locator("#addListView").click();await expect(page.locator("#saveState")).toHaveText("View saved.");
  await expect(page.locator(".list-record .record-link")).toHaveText(["Charlie", "Alpha", "Delta"]);
  const after = await stored(page);
  expect(after.workspace.pages).toEqual(before.workspace.pages);
  expect(after.workspace.databases[0].recordPageIds).toEqual(before.workspace.databases[0].recordPageIds);
  expect(after.workspace.databases[0].views[0]).toEqual(before.workspace.databases[0].views[0]);
  await page.locator("#activeView").selectOption("board");await expect(page.locator("#saveState")).toHaveText("View saved.");
  const selected = await stored(page);await page.reload();await expect(page.locator("#boardGrouping")).toHaveValue("category");
  expect(await stored(page)).toEqual(selected);
});

test("failed card moves retain canonical pages and recover through retry and discard", async ({ page }) => {
  const before = await seed(page), move = page.locator('[data-record="a"][data-board-move]');
  await failNextWrite(page);await move.selectOption("done");
  await expect(page.locator("#editRecovery")).toBeVisible();await expect(move).toHaveAttribute("data-unsaved", "true");
  await expect(page.locator('[data-board-lane="todo"] [data-record-id="a"]')).toBeVisible();
  expect(await stored(page)).toEqual(before);
  await page.locator("#retryEdit").click();await expect(page.locator('[data-board-lane="done"] [data-record-id="a"]')).toBeVisible();
  await expect(move).toBeFocused();
  const moved = await stored(page), original = before.workspace.pages.find((record: any) => record.id === "a"), record = moved.workspace.pages.find((record: any) => record.id === "a");
  expect({ ...record, properties: original.properties, updatedAt: original.updatedAt }).toEqual(original);
  expect(record.properties.status).toBe("done");expect(moved.revision).toBe(before.revision + 1);
  expect(moved.workspace.databases).toEqual(before.workspace.databases);
  await page.evaluate(() => (window as any).__restoreBoardPut());await failNextWrite(page);await move.selectOption("");
  await expect(page.locator("#editRecovery")).toBeVisible();await page.locator("#discardEdit").click();
  await expect(move).toHaveValue("done");expect(await stored(page)).toEqual(moved);
  await page.reload();await expect(page.locator('[data-board-lane="done"] [data-record-id="a"]')).toBeVisible();
  expect(await stored(page)).toEqual(moved);
});

test("a move out of a filtered board preserves full manual order and gives focus to the board", async ({ page }) => {
  const before = await seed(page, { board: { filters: { kind: "condition", propertyId: "status", operator: "equals", value: "todo" } } });
  await expect(page.locator(".board-card")).toHaveCount(1);
  await page.locator('[data-record="a"][data-board-move]').selectOption("done");
  await expect(page.locator(".board-card")).toHaveCount(0);await expect(page.locator("#boardView")).toBeFocused();
  await expect(page.locator("#saveState")).toHaveText("Card moved and saved. It no longer matches this view.");
  const after = await stored(page);
  expect(after.workspace.databases).toEqual(before.workspace.databases);
  expect(after.workspace.pages.filter((record: any) => record.id !== "a")).toEqual(before.workspace.pages.filter((record: any) => record.id !== "a"));
  expect(after.workspace.pages.find((record: any) => record.id === "a").properties.status).toBe("done");
  await page.locator("#filterButton").click();await page.locator("#clearFilter").click();
  await expect(page.locator(".board-card")).toHaveCount(4);
  expect((await stored(page)).workspace.databases[0].recordPageIds).toEqual(before.workspace.databases[0].recordPageIds);
});

test("aborted view selection stays on the durable view and blocks intervening control writes", async ({ page }) => {
  const before = await seed(page);await failNextWrite(page, true);
  await page.locator("#activeView").selectOption("table");
  await expect.poll(() => page.evaluate(() => (window as any).__boardPutSucceeded)).toBe(true);
  await expect(page.locator("#boardGrouping")).toBeDisabled();
  await expect(page.locator('[data-record="a"][data-board-move]')).toBeDisabled();
  await page.locator("#addTableView").click();await page.keyboard.press("Control+z");
  await page.evaluate(() => { (window as any).__boardRelease = true; });
  await expect(page.locator("#saveState")).toHaveText("View change could not be saved. Try again.");
  await expect(page.locator("#activeView")).toHaveValue("board");await expect(page.locator("#activeView")).toBeFocused();
  expect(await stored(page)).toEqual(before);
  expect(await page.evaluate(() => (window as any).__boardWrites)).toBe(1);
  expect(await page.evaluate(() => (window as any).__boardTimedOut)).toBe(false);
  await page.evaluate(() => (window as any).__restoreBoardPut());await page.locator("#activeView").selectOption("table");
  await expect(page.locator("#saveState")).toHaveText("View saved.");
  const selected = await stored(page);expect(selected.workspace).toEqual(before.workspace);expect(selected.revision).toBe(before.revision);
  await page.reload();await expect(page.locator("#activeView")).toHaveValue("table");expect(await stored(page)).toEqual(selected);
});

test("a saved view whose selection fails remains available without duplicating or changing records", async ({ page }) => {
  const before = await seed(page, { active: "table" });await failNextWrite(page, false, 2);
  await page.locator("#addBoardView").click();
  await expect(page.locator("#saveState")).toHaveText("View created; its selection could not be saved. Select the view to try again.");
  const created = await stored(page), views = created.workspace.databases[0].views;
  expect(views).toHaveLength(4);expect(created.activeViewIds.database).toBe("table");
  expect(created.workspace.pages).toEqual(before.workspace.pages);expect(created.revision).toBe(before.revision + 1);
  expect(views.slice(0, 3)).toEqual(before.workspace.databases[0].views);
  await expect(page.locator("#activeView")).toHaveValue("table");await expect(page.locator("#activeView")).toBeFocused();
  await page.evaluate(() => (window as any).__restoreBoardPut());await page.locator("#activeView").selectOption(views[3].id);
  await expect(page.locator("#saveState")).toHaveText("View saved.");
  const selected = await stored(page);expect(selected.workspace).toEqual(created.workspace);expect(selected.revision).toBe(created.revision);
  await page.reload();await expect(page.locator("#activeView")).toHaveValue(views[3].id);expect(await stored(page)).toEqual(selected);
});

test("creating a board refuses a pending width edit and copies the confirmed width after retry", async ({ page }) => {
  const before = await seed(page, { active: "table" });
  await page.evaluate(() => {
    const width = document.querySelector<HTMLInputElement>('[data-column-width="title"]')!;
    width.value = "368";width.dispatchEvent(new Event("input", { bubbles: true }));
    // Dispatch in the same task so the creation action precedes the 180ms edit debounce.
    document.querySelector<HTMLButtonElement>("#addBoardView")!.click();
  });
  await expect(page.locator("#editRecovery")).toBeVisible();
  await expect(page.locator("#editRecoveryMessage")).toHaveText("Retry or discard the unsaved edit before continuing.");
  await expect(page.locator("#saveState")).toHaveText("Unsaved change — action required");
  await expect(page.locator("#activeView")).toHaveValue("table");
  expect(await stored(page)).toEqual(before);
  await page.locator("#retryEdit").click();
  await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
  const confirmed = await stored(page), source = confirmed.workspace.databases[0].views.find((view: any) => view.id === "table");
  expect(source.columnWidths.title).toBe(368);expect(confirmed.revision).toBe(before.revision + 1);
  expect(confirmed.workspace.pages).toEqual(before.workspace.pages);
  await page.locator("#addBoardView").click();await expect(page.locator("#saveState")).toHaveText("View saved.");
  const created = await stored(page), database = created.workspace.databases[0], view = database.views.find((item: any) => item.id === created.activeViewIds.database);
  expect(database.views).toHaveLength(4);expect(view.type).toBe("board");expect(view.id).not.toBe("board");
  expect(view.columnWidths).toEqual(source.columnWidths);expect(view.sorts).toEqual(source.sorts);expect(view.filters).toEqual(source.filters);
  expect(database.views.slice(0, 3)).toEqual(confirmed.workspace.databases[0].views);
  expect(database.recordPageIds).toEqual(before.workspace.databases[0].recordPageIds);
  expect(created.workspace.pages).toEqual(before.workspace.pages);expect(created.revision).toBe(confirmed.revision + 1);
  await page.reload();await expect(page.locator("#activeView")).toHaveValue(view.id);await expect(page.locator("#boardView")).toBeVisible();
  expect(await stored(page)).toEqual(created);
});

test("failed grouping edits retain the complete saved view and retry without discarding imported settings", async ({ page }) => {
  const before = await seed(page, { board: { layout: { retained: [1, true] }, cardPreview: { retained: "unchanged" } } });
  await failNextWrite(page);await page.locator("#boardGrouping").selectOption("category");
  await expect(page.locator("#editRecovery")).toBeVisible();await expect(page.locator("#boardGrouping")).toHaveAttribute("data-unsaved", "true");
  expect(await stored(page)).toEqual(before);
  await page.locator("#retryEdit").click();await expect(page.locator(".board-lane-heading > span:first-child")).toHaveText(["Work", "Home", "Unassigned"]);
  await expect(page.locator("#boardGrouping")).toBeFocused();
  const after = await stored(page), board = after.workspace.databases[0].views.find((view: any) => view.id === "board");
  expect({ ...board, groupByPropertyId: "status" }).toEqual(before.workspace.databases[0].views[2]);
  expect(after.workspace.pages).toEqual(before.workspace.pages);expect(after.revision).toBe(before.revision + 1);
});

for (const board of [{ subgroupByPropertyId: "category", layout: { imported: [1, true] }, cardPreview: { type: "unknown-preview", retained: true } }, { groupByPropertyId: "score" }]) {
  test(`unsupported board ${"subgroupByPropertyId" in board ? "subgroups" : "grouping type"} remains explicit and lossless`, async ({ page }) => {
    const before = await seed(page, { board });
    await expect(page.locator("#boardView")).toHaveAttribute("data-board-state", "unsupported");
    await expect(page.locator(".board-configuration")).toContainText("not supported");await expect(page.locator(".board-card")).toHaveCount(0);
    expect(await stored(page)).toEqual(before);
    await page.locator("#activeView").selectOption("table");await expect(page.locator("tbody tr")).toHaveCount(4);
    expect((await stored(page)).workspace).toEqual(before.workspace);
    await page.locator("#activeView").selectOption("board");await expect(page.locator("#saveState")).toHaveText("View saved.");
    await page.reload();await expect(page.locator("#boardView")).toHaveAttribute("data-board-state", "unsupported");expect((await stored(page)).workspace).toEqual(before.workspace);
  });
}

test("board labels stay literal, required groups cannot clear, and an unconfigured board stays readable", async ({ page }) => {
  const before = await seed(page, { hostile: true, required: true });
  await expect(page.locator('[data-board-open="a"]')).toHaveText('Alpha <button data-trash-page="db-page">keep</button>');
  await expect(page.locator('#boardView img,#boardView [data-trash-page]')).toHaveCount(0);
  await expect(page.locator('[data-record="a"][data-board-move] option[value=""]')).toHaveJSProperty("disabled", true);
  await expect(page.locator('[data-board-lane=""]')).toBeVisible();expect(await stored(page)).toEqual(before);
  const unconfigured = await seed(page, { noGrouping: true });
  await expect(page.locator("#boardView")).toHaveAttribute("data-board-state", "unconfigured");
  await expect(page.locator("#boardGrouping")).toBeDisabled();await expect(page.locator(".board-configuration")).toHaveText("Add a status or select property to group this board.");
  expect(await stored(page)).toEqual(unconfigured);
  await page.locator("#addTableView").click();await expect(page.locator("tbody tr")).toHaveCount(4);
  expect((await stored(page)).workspace.pages).toEqual(unconfigured.workspace.pages);
});
