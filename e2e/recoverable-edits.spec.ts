import { expect, test, type Locator, type Page } from "@playwright/test";

const layouts = [
  { name: "normal", viewport: { width: 1280, height: 800 } },
  { name: "equivalent 200%", viewport: { width: 720, height: 800 } }
] as const;

const initialWorkspace = {
  schemaVersion: 1, activePageId: "document-page", pages: [
    { id: "document-page", parentId: null, order: 0, type: "document", title: "Durable document", deleted: false, blocks: [
      { id: "paragraph-block", type: "paragraph", text: "Durable text", indent: 0, links: [] },
      { id: "heading-block", type: "heading1", text: "Durable heading", indent: 0, links: [] },
      { id: "task-block", type: "task", text: "Durable checklist", checked: false, indent: 0, links: [] },
      { id: "code-block", type: "code", text: "durable code", indent: 0, links: [] }
    ] },
    { id: "table-page", parentId: null, order: 1, type: "database", title: "Durable table", deleted: false,
      columns: [{ id: "name-column", name: "Durable column", type: "text" }], rows: [{ id: "stable-row", values: { "name-column": "Durable cell" } }] }
  ]
};

async function installNativeFailureHarness(page: Page) {
  await page.addInitScript(workspace => {
    let durable = structuredClone(workspace), failNext = false, saves = 0;
    Object.defineProperty(window, "__motionEditTest", { value: {
      failNext() { failNext = true; }, get durable() { return structuredClone(durable); }, get saves() { return saves; }
    } });
    Object.defineProperty(window, "__TAURI__", { value: { core: { invoke: async (command: string, payload: any) => {
      if (command === "motion_ui_load") return structuredClone(durable);
      if (command === "motion_ui_save") {
        saves += 1;
        if (failNext) { failNext = false; throw new Error("SQLITE_IOERR /private/workspace.db secret-canary"); }
        durable = structuredClone(payload.request.document); return undefined;
      }
      if (payload?.request?.payload?.type === "workspace.list") return [{ id: "workspace-1", revision: saves }];
      if (payload?.request?.payload?.type === "workspace.search") return [];
      if (payload?.request?.payload?.type === "workspace.export") return { schemaVersion: 1, workspace: structuredClone(durable) };
      return undefined;
    } } } });
  }, initialWorkspace);
}

async function failNextSave(page: Page) { await page.evaluate(() => (window as any).__motionEditTest.failNext()); }
async function durable(page: Page) { return page.evaluate(() => (window as any).__motionEditTest.durable); }

async function rejectThenRetry(page: Page, editor: Locator, edit: () => Promise<void>, expectedName: RegExp) {
  const savesBefore = await page.evaluate(() => (window as any).__motionEditTest.saves);
  await failNextSave(page); await edit();
  const recovery = page.locator("#editRecovery");
  await expect(recovery).toBeVisible(); await expect(recovery).toHaveAttribute("role", "alert");
  await expect(recovery).toContainText(expectedName); await expect(recovery).not.toContainText("SQLITE_IOERR");
  await expect(editor).toHaveAttribute("data-unsaved", "true"); await expect(editor).toHaveAttribute("aria-invalid", "true"); await expect(editor).toBeFocused();
  const retry = page.getByRole("button", { name: "Retry save" }); await retry.focus(); await page.keyboard.press("Enter");
  await expect(recovery).toBeHidden(); await expect(page.locator("#saveState")).toContainText("saved");
  expect(await page.evaluate(() => (window as any).__motionEditTest.saves)).toBe(savesBefore + 2);
}

for (const layout of layouts) {
  test.describe(layout.name, () => {
    test.use({ viewport: layout.viewport });

    test("MOTION-UX-011: failed edits retain exact values and retry/discard honestly", async ({ page }) => {
      test.setTimeout(60_000);
      await installNativeFailureHarness(page); await page.goto("/");
      const special = "  Māori 😀 <tag> & punctuation\n\n\tsecond line  ";
      const inlineSpecial = "  Māori 😀 <tag> & punctuation  ";
      let title = page.getByRole("textbox", { name: "Page title" });
      await rejectThenRetry(page, title, () => title.fill(inlineSpecial), /Page title could not be saved/);
      expect((await durable(page)).pages[0].title).toBe(inlineSpecial);

      let paragraph = page.locator('[data-block="paragraph-block"]');
      await failNextSave(page); await paragraph.fill(`paragraph:${special}`); await expect(page.locator("#editRecovery")).toBeVisible();
      await page.locator('[data-block="heading-block"]').fill("must not commit");
      paragraph = page.locator('[data-block="paragraph-block"]'); await expect(paragraph).toBeFocused();
      await expect(page.locator('[data-block="heading-block"]')).toHaveText("Durable heading");
      await page.getByRole("button", { name: "Retry save" }).click(); await expect(page.locator("#editRecovery")).toBeHidden();
      expect((await durable(page)).pages[0].blocks[0].text).toBe(`paragraph:${special}`);
      const paragraphType = page.locator('[data-block-type="paragraph-block"]');
      await rejectThenRetry(page, paragraphType, () => paragraphType.selectOption("heading2"), /Block type could not be saved/);
      expect((await durable(page)).pages[0].blocks[0].type).toBe("heading2");

      const headingValue = `heading:${special}`;
      await rejectThenRetry(page, page.locator('[data-block="heading-block"]'), () => page.locator('[data-block="heading-block"]').fill(headingValue), /Heading 1 text could not be saved/);
      expect((await durable(page)).pages[0].blocks[1].text).toBe(headingValue);
      const codeValue = `const value = "<unsafe>";\n\n\treturn "😀";  `;
      await rejectThenRetry(page, page.locator('[data-block="code-block"]'), () => page.locator('[data-block="code-block"]').fill(codeValue), /Code text could not be saved/);
      expect((await durable(page)).pages[0].blocks[3].text).toBe(codeValue);
      const task = page.getByRole("checkbox", { name: "Mark task complete" });
      await rejectThenRetry(page, task, () => task.check(), /Checklist state could not be saved/);
      expect((await durable(page)).pages[0].blocks[2].checked).toBe(true);

      const openNavigation = page.getByRole("button", { name: "Open navigation" });
      if (await openNavigation.isVisible()) await openNavigation.click();
      await page.getByRole("button", { name: "Durable table", exact: true }).click();
      title = page.getByRole("textbox", { name: "Database title" });
      await rejectThenRetry(page, title, () => title.fill(`table:${inlineSpecial}`), /Table title could not be saved/);
      const column = page.getByRole("textbox", { name: "Column name" });
      await rejectThenRetry(page, column, () => column.fill(`column:${inlineSpecial}`), /Table column name could not be saved/);
      const cell = page.locator('[data-cell="stable-row:name-column"]');
      await failNextSave(page); await cell.fill(`cell:${special}`); await expect(page.locator("#editRecovery")).toBeVisible();
      await expect(cell).toHaveValue(`cell:${special}`);
      await failNextSave(page); await page.getByRole("button", { name: "Retry save" }).click();
      await expect(page.locator("#editRecovery")).toBeVisible(); await expect(cell).toHaveValue(`cell:${special}`);
      await expect(page.locator("#saveState")).not.toContainText("Saved to Motion");
      await page.getByRole("button", { name: "Discard unsaved changes" }).focus(); await page.keyboard.press("Space");
      const restoredCell = page.locator('[data-cell="stable-row:name-column"]');
      await expect(restoredCell).toHaveValue("Durable cell"); await expect(restoredCell).toBeFocused();
      await expect(page.locator("#saveState")).toContainText("discarded");
      expect((await durable(page)).pages[1].rows[0].values["name-column"]).toBe("Durable cell");
    });

    test("MOTION-UX-011: unresolved edits warn before reload and cannot leak into Trash or search", async ({ page }) => {
      await installNativeFailureHarness(page); await page.goto("/");
      const paragraph = page.locator('[data-block="paragraph-block"]');
      await failNextSave(page); await paragraph.fill("rejected-search-marker"); await expect(page.locator("#editRecovery")).toBeVisible();
      await page.getByRole("button", { name: "Delete", exact: true }).click(); await expect(page.locator("#editRecovery")).toContainText("Retry or discard");
      expect((await durable(page)).pages[0].deleted).toBe(false);
      await page.keyboard.press("Control+k"); await page.getByRole("searchbox", { name: "Search workspace" }).fill("rejected-search-marker");
      await expect(page.locator("#searchResults")).toContainText("No results"); await page.keyboard.press("Escape");
      const warning = page.waitForEvent("dialog"), reload = page.reload({ waitUntil: "domcontentloaded" });
      const dialog = await warning; expect(dialog.type()).toBe("beforeunload"); await dialog.accept(); await reload;
      await expect(page.locator('[data-block="paragraph-block"]')).toHaveText("Durable text");
      expect((await durable(page)).pages[0].blocks[0].text).toBe("Durable text");
    });
  });
}
