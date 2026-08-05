import { expect, test, type Page } from "@playwright/test";

const regressionExpect = expect.configure({ timeout: 1_000 });

const layouts = [
  { name: "normal", viewport: { width: 1280, height: 800 } },
  { name: "equivalent 200%", viewport: { width: 640, height: 800 } }
] as const;

const workspace = {
  schemaVersion: 1,
  activePageId: "page-primary",
  pages: [
    { id: "page-primary", parentId: null, order: 0, type: "document", title: "Destructive test", deleted: false,
      blocks: [{ id: "block-one", type: "paragraph", text: "First block" }, { id: "block-two", type: "paragraph", text: "Second block" }] },
    { id: "page-survivor", parentId: null, order: 1, type: "document", title: "Surviving page", deleted: false,
      blocks: [{ id: "block-survivor", type: "paragraph", text: "Survives" }] }
  ]
};

async function seed(page: Page) {
  await page.goto("/");
  await page.evaluate(async value => {
    const request = indexedDB.open("motion-web-development", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => request.result.createObjectStore("workspace");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("workspace", "readwrite");
        transaction.objectStore("workspace").put(value, "default");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, workspace);
  await page.reload();
}

async function consequenceDialog(page: Page, action: () => Promise<void>) {
  let message: string | null = null;
  page.once("dialog", async dialog => { message = dialog.message(); await dialog.dismiss(); });
  await action();
  await page.waitForTimeout(75);
  return message;
}

for (const layout of layouts) {
  test.describe(layout.name, () => {
    test.use({ viewport: layout.viewport });

    for (const key of ["Space", "Enter"] as const) {
      test(`block delete by ${key} requires consequence confirmation and cancellation`, async ({ page }) => {
        await seed(page);
        const button = page.getByRole("button", { name: "Delete block" }).first();
        const before = await page.locator("[data-block-id]").count();
        await button.focus();
        const message = await consequenceDialog(page, () => page.keyboard.press(key));

        expect(message, "block deletion must open a keyboard-accessible confirmation").not.toBeNull();
        expect(message!, "confirmation must state the block-specific irreversible consequence").toMatch(/delete.+block.+cannot be undone|permanent.+block/i);
        await regressionExpect(page.locator("[data-block-id]"), "cancellation must preserve every block").toHaveCount(before);
        await regressionExpect(button, "cancellation must return focus to the invoking control").toBeFocused();
      });
    }

    test("workspace file selection requires replacement confirmation and cancellation", async ({ page }) => {
      await seed(page);
      const restore = page.getByRole("button", { name: "Restore", exact: true });
      await restore.focus();
      let message: string | null = null;
      page.once("dialog", async dialog => { message = dialog.message(); await dialog.dismiss(); });
      const chooser = page.waitForEvent("filechooser");
      await page.keyboard.press("Enter");
      await (await chooser).setFiles({
        name: "replacement.json", mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, activePageId: "replacement", pages: [
          { id: "replacement", parentId: null, order: 0, type: "document", title: "Replacement", deleted: false, blocks: [] }
        ] }))
      });
      await page.waitForTimeout(75);

      expect(message, "workspace replacement must open a keyboard-accessible confirmation").not.toBeNull();
      expect(message!, "confirmation must describe replacement and its effect on the current workspace").toMatch(/replace|restore.+workspace|current workspace/i);
      await regressionExpect(page.getByRole("textbox", { name: "Page title" }), "file selection alone must not replace the workspace").toHaveValue("Destructive test");
      await regressionExpect(restore, "cancellation must return focus to Restore").toBeFocused();
      await regressionExpect(page.getByRole("status"), "cancellation must be announced without claiming replacement").toContainText(/restore cancelled/i);
    });

    test("Tab leaves the editor and can reach footer restore controls", async ({ page }) => {
      await seed(page);
      const editor = page.locator('[contenteditable="true"][data-block]').first();
      const restore = page.getByRole("button", { name: "Restore", exact: true });
      await editor.focus();
      let reached = false;
      for (let index = 0; index < 30; index += 1) {
        await page.keyboard.press("Tab");
        if (await restore.evaluate(element => document.activeElement === element)) { reached = true; break; }
      }
      expect(reached, "the editor must not trap Tab before footer restore controls").toBe(true);
    });

    test("page delete recovers focus to Trash and announces success", async ({ page }) => {
      await seed(page);
      const deletePage = page.getByRole("button", { name: "Delete", exact: true });
      await deletePage.focus();
      page.once("dialog", dialog => dialog.accept());
      await page.keyboard.press("Enter");
      const restorePage = page.getByRole("button", { name: "Restore Destructive test" });
      await regressionExpect(restorePage, "focus must move to the logical recovery action").toBeFocused();
      await regressionExpect(page.getByRole("status")).toContainText(/page moved to trash/i);
    });

    test("Trash restore recovers focus to the restored page and announces success", async ({ page }) => {
      await seed(page);
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "Delete", exact: true }).press("Enter");
      const restorePage = page.getByRole("button", { name: "Restore Destructive test" });
      await restorePage.focus();
      await page.keyboard.press("Enter");
      await regressionExpect(page.getByRole("textbox", { name: "Page title" }), "restored page title is the logical surviving focus target").toBeFocused();
      await regressionExpect(page.getByRole("status")).toContainText(/page restored/i);
    });

    test("confirmed block delete recovers focus to a surviving block and announces success", async ({ page }) => {
      await seed(page);
      const deleteBlock = page.getByRole("button", { name: "Delete block" }).first();
      await deleteBlock.focus();
      page.once("dialog", dialog => dialog.accept());
      await page.keyboard.press("Enter");
      await regressionExpect(page.locator('[contenteditable="true"][data-block]').first(), "focus must recover to a surviving block").toBeFocused();
      await regressionExpect(page.getByRole("status")).toContainText(/block deleted/i);
    });

    test("destructive success uses a consequence-specific live announcement", async ({ page }) => {
      await seed(page);
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "Delete", exact: true }).press("Enter");
      const status = page.getByRole("status");
      await regressionExpect(status, "successful page deletion must be announced explicitly").toContainText(/page moved to trash/i);
    });

    test("restore failure uses a consequence-specific live announcement", async ({ page }) => {
      await seed(page);
      const status = page.getByRole("status");
      const restore = page.getByRole("button", { name: "Restore", exact: true });
      const chooser = page.waitForEvent("filechooser");
      await restore.press("Enter");
      await (await chooser).setFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("not-json") });
      await regressionExpect(status, "restore failure must be exposed through the live status region").toContainText(/restore failed|could not restore/i);
    });

    test("controlled compliant fixture satisfies confirmation, focus, and live-status contract", async ({ page }) => {
      await page.setContent(`
        <main><div id="editor" contenteditable="true" tabindex="0">Block</div>
          <button id="delete">Delete block</button><button id="restore">Restore workspace</button><button id="failRestore">Fail restore</button>
          <div id="status" role="status" aria-live="polite"></div></main>
        <dialog id="confirm"><p id="consequence">Permanently delete this block? This cannot be undone.</p>
          <button id="cancel">Cancel</button><button id="confirmDelete">Delete block permanently</button></dialog>
        <script>
          const trigger=document.querySelector('#delete'), dialog=document.querySelector('#confirm');
          trigger.onclick=()=>dialog.showModal();
          document.querySelector('#cancel').onclick=()=>{dialog.close();trigger.focus()};
          document.querySelector('#confirmDelete').onclick=()=>{dialog.close();trigger.remove();document.querySelector('#restore').focus();document.querySelector('#status').textContent='Block deleted'};
          document.querySelector('#failRestore').onclick=()=>{document.querySelector('#status').textContent='Restore failed: invalid backup'};
        </script>`);
      const trigger = page.getByRole("button", { name: "Delete block", exact: true });
      await trigger.focus(); await page.keyboard.press("Enter");
      await regressionExpect(page.getByText(/cannot be undone/i)).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).press("Enter");
      await regressionExpect(trigger).toBeFocused();
      await trigger.press("Enter"); await page.getByRole("button", { name: "Delete block permanently" }).press("Enter");
      await regressionExpect(page.getByRole("button", { name: "Restore workspace" })).toBeFocused();
      await regressionExpect(page.getByRole("status")).toHaveText("Block deleted");
      await page.getByRole("button", { name: "Fail restore" }).press("Enter");
      await regressionExpect(page.getByRole("status")).toHaveText("Restore failed: invalid backup");
    });
  });
}
