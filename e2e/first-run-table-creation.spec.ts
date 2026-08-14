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

function workspaceItem(page: Page, title: string) {
  return page.getByRole("navigation", { name: "Workspace pages" }).locator('[data-open-page]').filter({ has: page.getByText(title, { exact: true }) });
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
  await expect(workspaceItem(page, defaultTitle)).toHaveCount(1);
  await page.reload();
  await expect(workspaceItem(page, defaultTitle)).toHaveCount(1);
}

async function installFailingNativeSave(page: Page) {
  await page.addInitScript(() => {
    const stamp = "2026-08-13T00:00:00.000Z";
    let workspace: any = null;
    let revision = 0;
    (window as any).__TAURI__ = { core: { invoke: async (command: string, envelope: any) => {
      if (command === "motion_ui_load") return { schemaVersion: 2, workspace: structuredClone(workspace), revision, activePageId: null, expandedPageIds: [] };
      if (command === "motion_ui_save") return undefined;
      if (command === "app_dispatch") {
        const payload = envelope.request.payload;
        if (payload.type === "workspace.create") {
          workspace = { schemaVersion: 2, id: "native-workspace", name: "Motion Workspace", pages: [], databases: [], attachments: [], linkIndex: [], createdAt: stamp, updatedAt: stamp };
          revision = 1;
          return { workspace: structuredClone(workspace), revision };
        }
        if (payload.type === "database.create" || payload.type === "page.create") throw new Error("injected creation failure");
      }
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
      await title.press("Tab");
      await expect(page.getByRole("status")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);
      await page.getByRole("button", { name: "+ New record" }).click();
      await page.getByRole("button", { name: "Untitled", exact: true }).click();
      await page.getByRole("textbox", { name: "Page title" }).fill("durable-cell-008");
      await expect(page.getByRole("status")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("durable-cell-008");
      await expect(workspaceItem(page, "Persistent readings")).toHaveCount(1);

      await page.keyboard.press("Control+k");
      await page.getByRole("searchbox", { name: "Search workspace" }).fill("durable-cell-008");
      const hit = page.locator("#searchResults").getByRole("button", { name: "durable-cell-008 durable-cell-008", exact: true });
      await expect(hit).toHaveCount(1);
      await hit.press("Enter");
      await expect(page.getByRole("textbox", { name: "Page title" })).toBeFocused();
      if (layout.viewport.width <= 720) await page.getByRole("button", { name: "Open navigation" }).click();
      await workspaceItem(page, "Persistent readings").click();
      await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Persistent readings");

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
      if (layout.viewport.width <= 720) await page.getByRole("button", { name: "Open navigation" }).click();
      await workspaceItem(page, "Persistent readings").click();
      await page.getByRole("button", { name: "durable-cell-008", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("durable-cell-008");
    });

    test("MOTION-UX-008: table-first keyboard activation is single-shot and durable", async ({ page }) => {
      await clean(page);
      const create = await rootCreation(page, "New table");
      await create.focus();
      await Promise.all([create.press("Enter"), create.press("Space")]);
      await expect(page.getByRole("status")).toHaveText("Table created and saved.");
      await expect(page.getByRole("textbox", { name: "Database title" })).toBeFocused();
      await expect(workspaceItem(page, "Untitled database")).toHaveCount(1);
      await page.reload();
      await expect(workspaceItem(page, "Untitled database")).toHaveCount(1);
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
    const stamp = "2026-08-13T00:00:00.000Z";
    const empty = { schemaVersion: 2, workspace: null as any, revision: 0, activePageId: null as string|null, expandedPageIds: [] as string[] };
    const loadDocument = () => JSON.parse(localStorage.getItem("motion-native-test-document") ?? JSON.stringify(empty));
    const saveDocument = (value: any) => localStorage.setItem("motion-native-test-document", JSON.stringify(value));
    const mutate = (action: (document: any) => void) => { const document=loadDocument(); action(document); document.revision += 1; saveDocument(document); return { workspace: structuredClone(document.workspace), revision: document.revision }; };
    (window as any).__motionSavedBackup = null;
    (window as any).__TAURI__ = { core: { invoke: async (command: string, args: any) => {
      if (command === "motion_ui_load") return structuredClone(loadDocument());
      if (command === "motion_ui_save") { const document=loadDocument(); document.activePageId=args.request.document.activePageId; document.expandedPageIds=args.request.document.expandedPageIds; saveDocument(document); return null; }
      if (command === "motion_backup_save") { (window as any).__motionSavedBackup = structuredClone(args.request.bundle); return { saved: true, replaced: false, cancelled: false }; }
      if (command !== "app_dispatch") throw new Error(`unexpected native request: ${command}`);
      const payload = args.request.payload;
      if (payload.type === "workspace.create") return mutate(document => { document.workspace={schemaVersion:2,id:"native-workspace",name:payload.name,pages:[],databases:[],attachments:[],linkIndex:[],createdAt:stamp,updatedAt:stamp}; });
      if (payload.type === "page.create") return mutate(document => { document.workspace.pages.push({id:crypto.randomUUID(),parentId:payload.parentId,title:payload.title,blocks:[{id:crypto.randomUUID(),type:"paragraph",text:"",children:[]}],createdAt:stamp,updatedAt:stamp}); });
      if (payload.type === "database.create") return mutate(document => { const pageId=crypto.randomUUID(),databaseId=crypto.randomUUID(),propertyId=crypto.randomUUID();document.workspace.pages.push({id:pageId,parentId:payload.parentId,title:payload.title,blocks:[],createdAt:stamp,updatedAt:stamp});document.workspace.databases.push({id:databaseId,pageId,name:payload.title,properties:[{id:propertyId,name:"Name",type:"title"}],propertyOrder:[propertyId],titlePropertyId:propertyId,rows:[],recordPageIds:[],views:[{id:crypto.randomUUID(),collectionId:databaseId,name:"Table",type:"table",visiblePropertyIds:[propertyId],propertyOrder:[propertyId],columnWidths:{[propertyId]:280},sorts:[]}]}); });
      if (payload.type === "page.rename") return mutate(document => { const page=document.workspace.pages.find((item:any)=>item.id===payload.pageId);page.title=payload.title; });
      if (payload.type === "database.record-create") return mutate(document => { const database=document.workspace.databases.find((item:any)=>item.id===payload.databaseId),id=crypto.randomUUID();document.workspace.pages.push({id,parentId:database.pageId,collectionId:database.id,title:payload.title,blocks:[],properties:payload.values,createdAt:stamp,updatedAt:stamp});database.recordPageIds.push(id); });
      if (payload.type === "database.record-update") return mutate(document => { const page=document.workspace.pages.find((item:any)=>item.id===payload.pageId);page.properties={...page.properties,...payload.values}; });
      if (payload.type === "workspace.list") { const document=loadDocument();return document.workspace?[{id:document.workspace.id,revision:document.revision}]:[]; }
      if (payload.type === "backup.create") return { format: "motion-test-verified", document: structuredClone(loadDocument()) };
      if (payload.type === "backup.verify") return { valid: payload.bundle?.format === "motion-test-verified", errors: [] };
      if (payload.type === "backup.preview") return { workspaceName: "First run", pages: payload.bundle.document.workspace.pages.length, attachments: 0, totalBytes: JSON.stringify(payload.bundle).length };
      if (payload.type === "backup.restore-new") { const source=payload.bundle.document,newWorkspaceId="restored-workspace",document=structuredClone(source),idMap=new Map<string,string>();const identities=[source.workspace.id,...source.workspace.pages.flatMap((page:any)=>[page.id,...page.blocks.map((block:any)=>block.id)]),...source.workspace.databases.flatMap((database:any)=>[database.id,...database.properties.map((property:any)=>property.id),...database.views.map((view:any)=>view.id)])];for(const id of identities)idMap.set(id,id===source.workspace.id?newWorkspaceId:`${newWorkspaceId}:${id}`);document.workspace.id=newWorkspaceId;for(const page of document.workspace.pages){page.id=idMap.get(page.id);if(page.parentId)page.parentId=idMap.get(page.parentId);if(page.collectionId)page.collectionId=idMap.get(page.collectionId);if(page.properties)page.properties=Object.fromEntries(Object.entries(page.properties).map(([id,value])=>[idMap.get(id)??id,value]));for(const block of page.blocks)block.id=idMap.get(block.id);}for(const database of document.workspace.databases){database.id=idMap.get(database.id);database.pageId=idMap.get(database.pageId);database.recordPageIds=database.recordPageIds.map((id:string)=>idMap.get(id));database.propertyOrder=database.propertyOrder.map((id:string)=>idMap.get(id));database.titlePropertyId=idMap.get(database.titlePropertyId);for(const property of database.properties)property.id=idMap.get(property.id);for(const view of database.views){view.id=idMap.get(view.id);view.collectionId=idMap.get(view.collectionId);view.visiblePropertyIds=view.visiblePropertyIds.map((id:string)=>idMap.get(id));view.propertyOrder=view.propertyOrder.map((id:string)=>idMap.get(id));}}document.revision=1;document.activePageId=document.workspace.pages.find((page:any)=>!page.deletedAt)?.id??null;saveDocument(document);return { workspace: structuredClone(document.workspace), revision: document.revision }; }
      throw new Error(`unexpected native payload: ${payload.type}`);
    } } };
  });
  await page.goto("/");
  await (await rootCreation(page, "Add page")).click();
  await page.getByRole("textbox", { name: "Page title" }).fill("Durable native page");
  await (await rootCreation(page, "New table")).click();
  await page.getByRole("textbox", { name: "Database title" }).fill("Durable native table");
  await page.getByRole("textbox", { name: "Database title" }).press("Tab");
  await expect(page.getByRole("status")).toHaveText("Saved to Motion");
  await page.getByRole("button", { name: "+ New record" }).click();
  await page.getByRole("button", { name: "Untitled", exact: true }).click();
  await page.getByRole("textbox", { name: "Page title" }).fill("native-backup-cell-008");
  await expect(page.getByRole("status")).toHaveText("Saved to Motion");
  const before = await page.evaluate(() => (window as any).__TAURI__.core.invoke("motion_ui_load", { request: { schemaVersion: 1 } }));

  await page.getByRole("button", { name: "Verified backup" }).click();
  await expect(page.getByRole("status")).toHaveText("Verified backup saved safely.");
  const bundle = await page.evaluate(() => (window as any).__motionSavedBackup);
  expect(bundle.document).toEqual(before);

  await page.evaluate(() => localStorage.setItem("motion-native-test-document", JSON.stringify({ schemaVersion: 2, workspace: null, revision: 0, activePageId: null, expandedPageIds: [] })));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#verifiedBackupFile").setInputFiles({ name: "motion-verified-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)) });
  await workspaceItem(page, "Durable native table").click();
  await expect(page.getByRole("button", { name: "native-backup-cell-008", exact: true })).toBeVisible();
  const after = await page.evaluate(() => (window as any).__TAURI__.core.invoke("motion_ui_load", { request: { schemaVersion: 1 } }));
  expect(after.workspace.id).not.toBe(before.workspace.id);
  expect(after.workspace.pages.map((page:any) => page.id)).not.toEqual(before.workspace.pages.map((page:any) => page.id));
  expect(after.workspace.pages.map((page:any) => page.title)).toEqual(before.workspace.pages.map((page:any) => page.title));
  expect(after.workspace.databases[0].pageId).toBe(after.workspace.pages.find((page:any) => page.title === "Durable native table").id);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Durable native table");
  await expect(workspaceItem(page, "Durable native page")).toHaveCount(1);
  await expect(workspaceItem(page, "Durable native table")).toHaveCount(1);
});
