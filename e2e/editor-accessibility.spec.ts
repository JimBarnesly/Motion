import { expect, test, type Page } from "@playwright/test";

const layouts = [
  { name: "normal", viewport: { width: 1280, height: 800 } },
  { name: "equivalent 200%", viewport: { width: 640, height: 800 } }
] as const;

async function seed(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const value = { schemaVersion: 1, activePageId: "page-editor", pages: [{ id: "page-editor", parentId: null, order: 0,
      type: "document", title: "Editor accessibility", deleted: false,
      blocks: [{ id: "block-editor", type: "paragraph", text: "Content stays attached to its block", indent: 0 }] }] };
    const request = indexedDB.open("motion-web-development", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => request.result.createObjectStore("workspace");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put(value, "default");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload();
}

for (const layout of layouts) {
  test.describe(layout.name, () => {
    test.use({ viewport: layout.viewport });

    test("MOTION-UX-001: block type is visible, readable, stable and persisted", async ({ page }) => {
      await seed(page);
      let control = page.getByRole("combobox", { name: /Block type: Text/i });
      await expect(control).toBeVisible();
      const presentation = await control.evaluate(element => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return { color: style.color, width: bounds.width, height: bounds.height };
      });
      expect(presentation.color).not.toBe("transparent");
      expect(presentation.width).toBeGreaterThanOrEqual(76);
      expect(presentation.height).toBeGreaterThan(24);

      for (const [value, label] of [["heading1", "Heading 1"], ["task", "Task"], ["code", "Code"], ["divider", "Divider"], ["paragraph", "Text"]] as const) {
        await control.selectOption(value);
        control = page.getByRole("combobox", { name: new RegExp(`Block type: ${label}`, "i") });
        await expect(control).toHaveValue(value);
        await expect(page.locator('[data-block-id="block-editor"]')).toHaveCount(1);
      }
      await page.reload();
      await expect(page.getByRole("combobox", { name: /Block type: Text/i })).toHaveValue("paragraph");
      await expect(page.locator('[data-block="block-editor"]')).toHaveText("Content stays attached to its block");
    });

    test("MOTION-A11Y-001: Tab exits the editor and indentation uses a distinct shortcut", async ({ page }) => {
      await seed(page);
      const editor = page.locator('[contenteditable="true"][data-block="block-editor"]');
      await editor.focus();
      await page.keyboard.press("Alt+]");
      await expect(editor).toBeFocused();
      await expect(page.locator('[data-block-id="block-editor"]')).toHaveAttribute("style", /--indent:1/);

      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Delete block" })).toBeFocused();
      await editor.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByRole("combobox", { name: /Block type: Text/i })).toBeFocused();
    });
  });
}
