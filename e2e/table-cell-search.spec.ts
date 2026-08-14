import { expect, test, type Page } from "./fixtures";

const layouts = [
  { name: "normal", viewport: { width: 1280, height: 800 } },
  { name: "equivalent 200%", viewport: { width: 640, height: 800 } }
] as const;

const stamp = "2026-08-03T00:00:00Z";
const canonicalWorkspace = {
  schemaVersion: 2,
  id: "workspace-search",
  name: "Search workspace",
  pages: [
    { id: "notes-page", parentId: null, title: "Existing notes", createdAt: stamp, updatedAt: stamp,
      blocks: [{ id: "notes-block", type: "paragraph", text: "Existing title and nested block search remain available", children: [] }] },
    { id: "commissioning-table", parentId: null, title: "Commissioning register", createdAt: stamp, updatedAt: stamp, blocks: [] },
    { id: "stable-record-a", parentId: "commissioning-table", collectionId: "commissioning-db", title: "Pump A", createdAt: stamp, updatedAt: stamp, blocks: [],
      properties: { reading: "Flow <10 & stable\nsecond line", proof: { attachmentIds: ["proof-attachment"] } } },
    { id: "stable-record-b", parentId: "commissioning-table", collectionId: "commissioning-db", title: "Pump B", createdAt: stamp, updatedAt: stamp, blocks: [], properties: { reading: "Flow nominal" } }
  ],
  databases: [{ id: "commissioning-db", pageId: "commissioning-table", name: "Commissioning register",
    properties: [{ id: "title", name: "Name", type: "title" }, { id: "reading", name: "Reading", type: "text" }, { id: "proof", name: "Proof", type: "files" }],
    propertyOrder: ["title", "reading", "proof"], titlePropertyId: "title",
    rows: [{ id: "native-row-a", pageId: "stable-record-a", values: {} }], recordPageIds: ["stable-record-a", "stable-record-b"],
    views: [{ id: "table-view", collectionId: "commissioning-db", name: "Table", type: "table", visiblePropertyIds: ["title", "reading"], propertyOrder: ["title", "reading"], columnWidths: {} }] }],
  attachments: [{ id: "proof-attachment", fileName: "commissioning-proof.pdf", mediaType: "application/pdf", byteLength: 3, sha256: "a".repeat(64), path: "/private/never-render-this-path", createdAt: stamp }],
  linkIndex: [], createdAt: stamp, updatedAt: stamp
};

async function storedDocument(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("motion-web-development", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => request.result.createObjectStore("workspace");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<any>((resolve, reject) => {
        const read = database.transaction("workspace", "readonly").objectStore("workspace").get("default");
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
    } finally { database.close(); }
  });
}

async function restoreClean(page: Page) {
  await page.goto("/");
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("motion-web-development");
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  }));
  await page.reload();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#restoreFile").setInputFiles({
    name: "motion-canonical-search.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ workspace: canonicalWorkspace }))
  });
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Existing notes");
}

for (const layout of layouts) {
  test.describe(layout.name, () => {
    test.use({ viewport: layout.viewport });

    test("MOTION-UX-005: canonical properties and attachments search safely; Enter focuses the stable record", async ({ page }) => {
      await restoreClean(page);
      const beforeWorkspace = (await storedDocument(page)).workspace;

      await page.keyboard.press("Control+k");
      const search = page.getByRole("searchbox", { name: "Search workspace" });
      await expect(page.locator("#searchResults")).toContainText("Search page titles, block text, record properties, and attachment filenames.");
      await search.fill("stable second");
      const result = page.locator("#searchResults").getByRole("button", { name: /Pump A.*Reading: Flow <10 & stable second line/ });
      await expect(result).toBeVisible();
      await expect(page.locator("#searchDialog")).toBeInViewport();
      await result.press("Enter");

      await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Pump A");
      await expect(page.getByRole("textbox", { name: "Page title" })).toBeFocused();
      expect((await storedDocument(page)).workspace).toEqual(beforeWorkspace);

      await page.keyboard.press("Control+k");
      await page.getByRole("searchbox", { name: "Search workspace" }).fill("commissioning proof");
      const attachment = page.locator("#searchResults").getByRole("button", { name: /Pump A.*commissioning-proof\.pdf/ });
      await expect(attachment).toHaveCount(1);
      await expect(attachment).toBeVisible();
      await expect(page.locator("#searchResults")).not.toContainText("/private/never-render-this-path");
    });

    test("native row recovery keeps the query on retry and focuses its canonical record without a workspace command", async ({ page }) => {
      await page.addInitScript((workspaceDocument) => {
        let attempts = 0;
        (window as any).__searchLanes = [];
        (window as any).__TAURI__ = { core: { invoke: async (command: string, envelope: any) => {
          if (command === "motion_ui_load") return { schemaVersion: 2, workspace: structuredClone(workspaceDocument), revision: 4, activePageId: "notes-page", expandedPageIds: [] };
          if (command === "motion_ui_save") return undefined;
          if (command === "app_dispatch") {
            const { lane, payload } = envelope.request;
            (window as any).__searchLanes.push(lane);
            if (payload.type === "workspace.list") return [{ id: "workspace-search", revision: 4 }];
            if (payload.type === "workspace.search") {
              attempts += 1;
              if (attempts === 1) throw new Error("/Users/alice/private.db: SQLITE_IOERR");
              if (payload.query === "record-page") return [{ workspaceId: "workspace-search", entityId: "stable-record-a", entityType: "page", ownerEntityId: "commissioning-table", title: "Pump A", snippet: "Record page" }];
              return [{ workspaceId: "workspace-search", entityId: "native-row-a", entityType: "row", ownerEntityId: "commissioning-table", title: "Commissioning register", snippet: "Reading: Flow stable" }];
            }
          }
          throw new Error("Unexpected test IPC operation");
        } } };
      }, canonicalWorkspace);
      await page.goto("/");
      await page.keyboard.press("Control+k");
      const search = page.getByRole("searchbox", { name: "Search workspace" });
      await search.fill("stable");
      await expect(page.locator("#searchResults")).toContainText("Search is unavailable right now. Your workspace was not changed.");
      await expect(page.locator("#searchResults")).not.toContainText("alice");
      await expect(search).toHaveValue("stable");
      await page.getByRole("button", { name: "Retry search" }).press("Enter");
      await expect(search).toHaveValue("stable");
      const result = page.locator("#searchResults").getByRole("button", { name: /Commissioning register.*Flow stable/ });
      await result.press("Enter");
      await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Commissioning register");
      await expect(page.locator('[data-record-id="stable-record-a"] .record-link')).toBeFocused();

      await page.keyboard.press("Control+k");
      await page.getByRole("searchbox", { name: "Search workspace" }).fill("record-page");
      await page.locator("#searchResults").getByRole("button", { name: /Pump A.*Record page/ }).press("Enter");
      await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Pump A");
      await expect(page.getByRole("textbox", { name: "Page title" })).toBeFocused();
      await expect(page.getByRole("textbox", { name: "Database title" })).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).__searchLanes.every((lane: string) => lane === "query"))).toBe(true);
    });
  });
}
