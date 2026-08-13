import { expect, test, type Page } from "./fixtures";

const layouts = [
  { name: "normal", viewport: { width: 1280, height: 800 } },
  { name: "equivalent 200%", viewport: { width: 640, height: 800 } }
] as const;

const initialDocument = {
  schemaVersion: 2,
  revision: 7,
  activePageId: "document-page",
  expandedPageIds: [],
  workspace: {
    schemaVersion: 2, id: "workspace-1", name: "Motion Workspace", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    attachments: [], databases: [], linkIndex: [],
    pages: [
      { id: "document-page", parentId: null, title: "Durable document", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", favourite: false, blocks: [
        { id: "paragraph-block", type: "paragraph", text: "Durable text", children: [] },
        { id: "task-block", type: "task", text: "Durable task", checked: false, children: [] }
      ] },
      { id: "other-page", parentId: null, title: "Other durable page", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", favourite: false, blocks: [] }
    ]
  }
};

async function installTypedFailureHarness(page: Page) {
  await page.addInitScript(documentValue => {
    let durable = structuredClone(documentValue), failNext = false, exportCalls = 0, exportGate: Promise<void>|null = null, releaseExport: (() => void)|null = null;
    const command = (payload: any) => {
      const workspace = structuredClone(durable.workspace);
      const page = (id: string) => workspace.pages.find((item: any) => item.id === id);
      if (payload.type === "page.rename") page(payload.pageId).title = payload.title;
      else if (payload.type === "page.replace-blocks") page(payload.pageId).blocks = structuredClone(payload.blocks);
      else if (payload.type === "database.record-update") Object.assign(page(payload.pageId).properties ??= {}, structuredClone(payload.values));
      else if (payload.type === "database.view-update") Object.assign(workspace.databases.find((item: any) => item.id === payload.databaseId).views.find((item: any) => item.id === payload.viewId), structuredClone(payload.patch));
      else throw new Error(`unexpected typed command: ${payload.type}`);
      durable = { ...durable, revision: durable.revision + 1, workspace };
      return { revision: durable.revision, workspace: structuredClone(workspace) };
    };
    Object.defineProperty(window, "__motionEditV2", { value: {
      failNext() { failNext = true; },
      pauseExport() { exportGate = new Promise(resolve => { releaseExport = resolve; }); },
      releaseExport() { releaseExport?.(); exportGate = null; releaseExport = null; },
      get durable() { return structuredClone(durable); },
      get exportCalls() { return exportCalls; }
    } });
    Object.defineProperty(window, "__TAURI__", { value: { core: { invoke: async (name: string, args: any) => {
      if (name === "motion_ui_load") return structuredClone(durable);
      if (name === "motion_ui_save") return undefined;
      if (name !== "app_dispatch") throw new Error("unexpected native bridge call");
      const payload = args.request.payload;
      if (payload.type === "workspace.list") return [{ id: "workspace-1", revision: durable.revision }];
      if (payload.type === "workspace.search") return [];
      if (payload.type === "workspace.export") { exportCalls += 1; if (exportGate) await exportGate; return { schemaVersion: 1, files: {}, attachments: [] }; }
      if (failNext) { failNext = false; throw new Error("SQLITE_IOERR /private/workspace.db secret-canary"); }
      return command(payload);
    } } } });
  }, initialDocument);
}

async function failNext(page: Page) { await page.evaluate(() => (window as any).__motionEditV2.failNext()); }
async function durable(page: Page) { return page.evaluate(() => (window as any).__motionEditV2.durable); }

for (const layout of layouts) {
  test.describe(layout.name, () => {
    test.use({ viewport: layout.viewport });

    test("MOTION-UX-011 v2: failed typed edits retain exact candidates and Retry/Discard are honest", async ({ page }) => {
      await installTypedFailureHarness(page);
      await page.goto("/");
      const title = page.getByRole("textbox", { name: "Page title" });
      const exact = "  Māori 😀 <tag> & punctuation  ";

      await failNext(page);
      await title.fill(exact);
      const recovery = page.locator("#editRecovery");
      await expect(recovery).toBeVisible();
      await expect(recovery).toHaveAttribute("role", "alert");
      await expect(recovery).toContainText("Page title could not be saved");
      await expect(recovery).not.toContainText(/SQLITE_IOERR|private|secret-canary/);
      await expect(title).toHaveValue(exact);
      await expect(title).toHaveAttribute("data-unsaved", "true");
      await expect(title).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator("#saveState")).not.toContainText("Saved to Motion");
      expect((await durable(page)).workspace.pages[0].title).toBe("Durable document");

      const rejectedParagraph = page.locator('[data-block="paragraph-block"]');
      await rejectedParagraph.fill("must be rejected");
      await expect(title).toHaveValue(exact);
      await expect(title).toHaveAttribute("data-unsaved", "true");
      await expect(rejectedParagraph).toHaveText("Durable text");
      await expect(page.locator("#editRecovery")).toContainText("Resolve the unsaved edit");

      const retry = page.getByRole("button", { name: "Retry save" });
      await retry.focus();
      await page.keyboard.press("Enter");
      await expect(recovery).toBeHidden();
      await expect(page.locator("#saveState")).toHaveText("Saved to Motion");
      await expect(title).toHaveValue(exact);
      expect((await durable(page)).workspace.pages[0].title).toBe(exact);

      let paragraph = page.locator('[data-block="paragraph-block"]');
      const multiline = "exact 😀 text\n\twith whitespace  ";
      await failNext(page);
      await paragraph.fill(multiline);
      await expect(recovery).toBeVisible();
      await expect(paragraph).toHaveText(multiline);
      expect((await durable(page)).workspace.pages[0].blocks[0].text).toBe("Durable text");

      const discard = page.getByRole("button", { name: "Discard unsaved changes" });
      await discard.focus();
      await page.keyboard.press("Space");
      paragraph = page.locator('[data-block="paragraph-block"]');
      await expect(recovery).toBeHidden();
      await expect(paragraph).toHaveText("Durable text");
      await expect(paragraph).toBeFocused();
      expect((await durable(page)).workspace.pages[0].blocks[0].text).toBe("Durable text");
    });

    test("MOTION-UX-011 v2: an in-flight canonical read rejects edits without DOM or state mutation", async ({ page }) => {
      await installTypedFailureHarness(page);
      await page.goto("/");
      await page.evaluate(() => (window as any).__motionEditV2.pauseExport());
      if (layout.viewport.width <= 720) await page.getByRole("button", { name: "Open navigation" }).click();
      const exportButton = page.getByRole("button", { name: "Export JSON" });
      await exportButton.click();
      await expect.poll(() => page.evaluate(() => (window as any).__motionEditV2.exportCalls)).toBe(1);

      const title = page.getByRole("textbox", { name: "Page title" });
      await title.fill("must not enter state");
      await expect(title).toHaveValue("Durable document");
      await expect(title).not.toHaveAttribute("data-unsaved", "true");
      expect((await durable(page)).workspace.pages[0].title).toBe("Durable document");

      await page.evaluate(() => (window as any).__motionEditV2.releaseExport());
      await expect(page.locator("#saveState")).toContainText("edit not applied");
    });

    test("MOTION-UX-011 v2: unresolved edits block canonical reads, destructive navigation, and unload", async ({ page }) => {
      await installTypedFailureHarness(page);
      await page.goto("/");
      const paragraph = page.locator('[data-block="paragraph-block"]');
      await failNext(page);
      await paragraph.fill("rejected-search-marker");
      await expect(page.locator("#editRecovery")).toBeVisible();

      await page.keyboard.press("Control+k");
      await page.getByRole("searchbox", { name: "Search workspace" }).fill("rejected-search-marker");
      await expect(page.locator("#searchResults")).toContainText("No results");
      await page.getByRole("button", { name: "Close search" }).click();

      if (layout.viewport.width <= 720) await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("button", { name: "Export JSON" }).click();
      await expect(page.locator("#editRecovery")).toContainText("before exporting");
      expect(await page.evaluate(() => (window as any).__motionEditV2.exportCalls)).toBe(0);
      await page.getByRole("navigation", { name: "Workspace pages" }).locator('[data-open-page]').filter({ has: page.getByText("Other durable page", { exact: true }) }).click();
      await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Durable document");
      await expect(page.locator("#editRecovery")).toContainText("before leaving this page");

      const warning = page.waitForEvent("dialog");
      const reload = page.reload({ waitUntil: "domcontentloaded" });
      const dialog = await warning;
      expect(dialog.type()).toBe("beforeunload");
      await dialog.accept();
      await reload;
      await expect(page.locator('[data-block="paragraph-block"]')).toHaveText("Durable text");
    });
  });
}
