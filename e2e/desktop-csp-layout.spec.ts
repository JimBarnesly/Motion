import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "./fixtures";

const desktopCsp = JSON.parse(readFileSync(resolve(__dirname, "../apps/desktop/src-tauri/tauri.conf.json"), "utf8")).app.security.csp;

async function seed(page: Page, activePageId: string) {
  await page.addInitScript(() => {
    (window as any).__layoutCspViolations = [];
    document.addEventListener("securitypolicyviolation", event => {
      (window as any).__layoutCspViolations.push({ directive: event.effectiveDirective, blockedUri: event.blockedURI });
    });
  });
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBe(desktopCsp);
  expect(desktopCsp).toContain("style-src 'self'");
  expect(desktopCsp).not.toContain("'unsafe-inline'");
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
  await page.evaluate(async activeId => {
    const stamp = "2026-11-25T00:00:00.000Z";
    const documentValue = {
      schemaVersion: 2, revision: 1, activePageId: activeId,
      expandedPageIds: ["root-page", "child-page"], activeViewIds: { "layout-database": "layout-view" },
      workspace: {
        schemaVersion: 2, id: "layout-workspace", name: "CSP layout", createdAt: stamp, updatedAt: stamp,
        attachments: [], linkIndex: [],
        pages: [
          { id: "root-page", parentId: null, title: "Root page", blocks: [], createdAt: stamp, updatedAt: stamp },
          { id: "child-page", parentId: "root-page", title: "Child page", blocks: [], createdAt: stamp, updatedAt: stamp },
          { id: "nested-page", parentId: "child-page", title: "Nested page", createdAt: stamp, updatedAt: stamp, blocks: [
            { id: "root-block", type: "paragraph", text: "Root block", children: [
              { id: "child-block", type: "paragraph", text: "Child block", children: [
                { id: "nested-block", type: "paragraph", text: "Nested block", children: [] }
              ] }
            ] }
          ] },
          { id: "table-page", parentId: null, title: "Layout table", blocks: [], createdAt: stamp, updatedAt: stamp }
        ],
        databases: [{
          id: "layout-database", pageId: "table-page", name: "Layout table", titlePropertyId: "name",
          properties: [{ id: "name", name: "Name", type: "title" }, { id: "notes", name: "Notes", type: "text" }, { id: "done", name: "Done", type: "checkbox" }],
          propertyOrder: ["name", "notes", "done"], rows: [], recordPageIds: [],
          views: [{ id: "layout-view", collectionId: "layout-database", name: "Table", type: "table",
            visiblePropertyIds: ["name", "notes", "done"], propertyOrder: ["name", "notes", "done"],
            columnWidths: { name: 480, notes: 360, done: 300 } }]
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
  }, activePageId);
  const reloaded = await page.reload();
  expect(reloaded?.headers()["content-security-policy"]).toBe(desktopCsp);
  await expect(page.locator("#saveState")).toHaveText("Browser development mode");
}

async function violations(page: Page) {
  // Policy violation events are queued. Let rendering complete before asserting
  // that the application's layout work caused none.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.evaluate(() => (window as any).__layoutCspViolations);
}

test("nested pages and blocks retain visible indentation under the desktop CSP", async ({ page }) => {
  await seed(page, "nested-page");
  await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Nested page");
  for (const [id, depth] of [["root-page", 0], ["child-page", 1], ["nested-page", 2]] as const) {
    const row = page.locator(`#pageTree .tree-row:has([data-open-page="${id}"])`);
    await expect(row).toHaveCSS("--depth", String(depth));
    await expect(row).toHaveCSS("padding-left", `${depth * 15}px`);
  }
  for (const [id, depth] of [["root-block", 0], ["child-block", 1], ["nested-block", 2]] as const) {
    const row = page.locator(`[data-block-id="${id}"]`);
    await expect(row).toHaveCSS("--indent", String(depth));
    await expect(row).toHaveCSS("margin-left", `${depth * 24}px`);
  }
  await page.getByRole("button", { name: "Collapse Child page", exact: true }).click();
  await expect(page.locator('#pageTree [data-open-page="nested-page"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Child page", exact: true }).click();
  await expect(page.locator('#pageTree .tree-row:has([data-open-page="nested-page"])')).toHaveCSS("padding-left", "30px");
  expect(await violations(page)).toEqual([]);

  await page.setViewportSize({ width: 700, height: 780 });
  await expect(page.locator('[data-block-id="child-block"]')).toHaveCSS("margin-left", "12px");
  await expect(page.locator('[data-block-id="nested-block"]')).toHaveCSS("margin-left", "24px");
  await expect(page.locator('[data-block="nested-block"]')).toHaveText("Nested block");
  expect(await violations(page)).toEqual([]);
});

test("custom table widths survive edits and reload without allowing inline style attributes", async ({ page }) => {
  await seed(page, "table-page");
  await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Layout table");
  const renderedWidths: number[] = [];
  for (const [id, width] of [["name", 480], ["notes", 360], ["done", 300]] as const) {
    const header = page.locator(`th[data-column-drag="${id}"]`);
    expect(await header.evaluate(element => element.style.width)).toBe(`${width}px`);
    renderedWidths.push(await header.evaluate(element => element.getBoundingClientRect().width));
  }
  // The existing table layout fits columns to available space. Verify that
  // distinct requested widths affect actual geometry, not only DOM attributes.
  expect(renderedWidths[0]).toBeGreaterThan(renderedWidths[1]);
  expect(renderedWidths[1]).toBeGreaterThan(renderedWidths[2]);
  expect(await violations(page)).toEqual([]);
  await page.getByRole("slider", { name: "Width of Notes" }).evaluate(input => {
    (input as HTMLInputElement).value = "420";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
  await page.reload();
  await expect(page.getByRole("slider", { name: "Width of Notes" })).toHaveValue("420");
  const resized = page.locator('th[data-column-drag="notes"]');
  expect(await resized.evaluate(element => element.style.width)).toBe("420px");
  expect(await resized.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(renderedWidths[1]);
  expect(await violations(page)).toEqual([]);

  // A positive control proves that this is an enforced policy, not a test that
  // accidentally bypasses CSP or checks only a serialized style attribute.
  await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.id = "blocked-inline-style-probe";
    probe.textContent = "CSP control";
    document.body.append(probe);
    probe.setAttribute("style", "color: rgb(1, 2, 3)");
  });
  await expect(page.locator("#blocked-inline-style-probe")).not.toHaveCSS("color", "rgb(1, 2, 3)");
  expect(await violations(page)).toEqual([{ directive: "style-src-attr", blockedUri: "inline" }]);
  await page.locator("#blocked-inline-style-probe").evaluate(element => element.remove());
});
