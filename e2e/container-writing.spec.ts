import { expect, test, type Page } from "./fixtures";

type Block = { id: string; type: string; text: string; children: Block[]; [key: string]: unknown };
const paragraph = (id: string, text = id, children: Block[] = []): Block => ({ id, type: "paragraph", text, children });
const nested = (): Block[] => [
  { id: "outer", type: "toggle", text: "Outer", children: [
    { id: "inner", type: "toggle", text: "Inner", children: [
      { ...paragraph("child", "Hiddenneedle [[Target]]"), references: [{ pageId: "target", start: 13, end: 23 }] },
      { id: "opaque", type: "future-widget", text: "Keep extension", children: [], unknownData: { retained: [true, { id: "child" }] } },
      { id: "file", type: "file", text: "Proof", attachmentId: "attachment", children: [] }
    ] }, paragraph("sibling", "Sibling")
  ] }, paragraph("tail", "Root tail")
];
async function readStored(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open("motion-web-development", 1);
      opening.onsuccess = () => resolve(opening.result);opening.onerror = () => reject(opening.error);
    });
    try { return await new Promise<any>((resolve, reject) => {
      const transaction = database.transaction("workspace", "readonly"), reading = transaction.objectStore("workspace").get("default");
      transaction.oncomplete = () => resolve(reading.result);transaction.onabort = () => reject(transaction.error);transaction.onerror = () => reject(transaction.error);
    }); } finally { database.close(); }
  });
}
async function seed(page: Page, blocks = nested(), collapsedBlockIds: string[] = [], fileName = "proof.bin") {
  await page.goto("/");await expect(page.locator("#saveState")).toHaveText("Browser development mode");
  await page.evaluate(async ({ blocks, collapsedBlockIds, fileName }) => {
    const stamp = "2026-11-25T00:00:00.000Z";
    const value = { schemaVersion: 2, revision: 9, activePageId: "writing", expandedPageIds: [], activeViewIds: {}, collapsedBlockIds,
      workspace: { schemaVersion: 2, id: "workspace", name: "Containers", createdAt: stamp, updatedAt: stamp, databases: [], linkIndex: [],
        attachments: [{ id: "attachment", fileName, mediaType: "application/octet-stream", byteLength: 3, sha256: "a".repeat(64), path: "a".repeat(64), createdAt: stamp }],
        pages: [{ id: "writing", parentId: null, title: "Writing", createdAt: stamp, updatedAt: stamp, blocks },
          { id: "target", parentId: null, title: "Target", createdAt: stamp, updatedAt: stamp, blocks: [ { id: "target-text", type: "paragraph", text: "Target content", children: [] } ] }] } };
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const opening = indexedDB.open("motion-web-development", 1);opening.onsuccess = () => resolve(opening.result);opening.onerror = () => reject(opening.error); });
    try { await new Promise<void>((resolve, reject) => { const transaction = database.transaction("workspace", "readwrite");transaction.objectStore("workspace").put(value, "default");transaction.oncomplete = () => resolve();transaction.onabort = () => reject(transaction.error);transaction.onerror = () => reject(transaction.error); }); }
    finally { database.close(); }
  }, { blocks, collapsedBlockIds, fileName });
  await page.reload();await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Writing");
  return readStored(page);
}
async function select(page: Page, id: string, start: number, end = start) {
  await page.locator(`[data-block="${id}"]`).evaluate((element, { start, end }) => {
    (element as HTMLElement).focus();
    const range = document.createRange();
    if (element.firstChild) { range.setStart(element.firstChild, start);range.setEnd(element.firstChild, end); }
    else { range.selectNodeContents(element);range.collapse(true); }
    const selection = window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  }, { start, end });
}
async function paste(page: Page, id: string, text: string) {
  await page.locator(`[data-block="${id}"]`).evaluate((element, text) => {
    const transfer = new DataTransfer();transfer.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });element.dispatchEvent(event);
    if (!event.defaultPrevented) throw new Error("Structured paste was not handled");
  }, text);
}
async function controlNextWrite(page: Page, mode: "abort" | "hold") {
  await page.evaluate(mode => {
    const runtime = window as any, original = IDBObjectStore.prototype.put;
    runtime.__containerWrites = 0;runtime.__containerPutSucceeded = false;runtime.__containerRelease = null;runtime.__containerTimedOut = false;
    runtime.__restoreContainerPut = () => { IDBObjectStore.prototype.put = original; };
    IDBObjectStore.prototype.put = function (...args: any[]) {
      const putting = original.apply(this, args as [any, IDBValidKey]);runtime.__containerWrites++;
      if (runtime.__containerWrites === 1) {
        const transaction = this.transaction, store = this, deadline = Date.now() + 8_000;
        putting.addEventListener("success", () => {
          runtime.__containerPutSucceeded = true;
          if (mode === "abort") { transaction.abort();return; }
          const keepAlive = () => {
            if (runtime.__containerRelease === "abort") { transaction.abort();return; }
            if (runtime.__containerRelease === "complete") return;
            if (Date.now() > deadline) { runtime.__containerTimedOut = true;transaction.abort();return; }
            store.get("default").addEventListener("success", keepAlive);
          };keepAlive();
        });
      }
      return putting;
    };
  }, mode);
}

for (const type of ["toggle", "callout"]) {
  test(`${type} creation, header Enter and child paste retain real hierarchy through undo, redo and reload`, async ({ page }) => {
    const before = await seed(page, [paragraph("header", ""), paragraph("tail", "Preserve sibling")]);
    const errors: string[] = [];page.on("pageerror", error => errors.push(error.message));
    if (type === "toggle") {
      await page.locator('[data-block="header"]').fill("/tog");
      await page.getByRole("option", { name: "Toggle Turn into toggle", exact: true }).click();
    } else await page.locator('[data-block-type="header"]').selectOption("callout");
    await expect(page.locator(`[data-block="header"]`)).toHaveClass(new RegExp(type));
    await page.locator('[data-block="header"]').fill("Header SELECT tail");
    await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
    await select(page, "header", 7, 14);await page.keyboard.press("Enter");
    await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks[0].children.length).toBe(1);
    const entered = await readStored(page), child = entered.workspace.pages[0].blocks[0].children[0];
    expect(entered.workspace.pages[0].blocks[0]).toEqual({ id: "header", type, text: "Header ", references: [], children: [{ id: child.id, type: "paragraph", text: "tail", children: [] }] });
    await expect(page.locator(`[data-block="${child.id}"]`)).toBeFocused();
    await select(page, child.id, 0, 4);await paste(page, child.id, "# Child heading\n- [x] Checked\nLast");
    await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks[0].children.map((block: Block) => block.type)).toEqual(["heading-1", "task", "paragraph"]);
    const pasted = await readStored(page), children = pasted.workspace.pages[0].blocks[0].children;
    expect(pasted.workspace.pages[0].blocks[1]).toEqual(before.workspace.pages[0].blocks[1]);
    expect(children.map((block: Block) => block.text)).toEqual(["Child heading", "Checked", "Last"]);
    await expect(page.locator(`[data-block="${children[2].id}"]`)).toBeFocused();
    await page.keyboard.press("Control+z");await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks).toEqual(entered.workspace.pages[0].blocks);
    await page.keyboard.press("Control+Shift+z");await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks).toEqual(pasted.workspace.pages[0].blocks);
    const durable = await readStored(page);expect(durable.revision).toBe(pasted.revision + 2);
    await page.reload();await expect(page.locator(`[data-block="${children[2].id}"]`)).toHaveText("Last");expect(await readStored(page)).toEqual(durable);expect(errors).toEqual([]);
  });
}

test("header paste preserves a container and its existing children; numbering and move limits use real siblings", async ({ page }) => {
  await seed(page, [
    { id: "header", type: "callout", text: "Before SELECT tail", children: [paragraph("kept", "Keep child")] },
    { ...paragraph("one", "One"), type: "numbered-list", children: [{ ...paragraph("nested-number", "Nested"), type: "numbered-list" }] },
    { ...paragraph("two", "Two"), type: "numbered-list" }, paragraph("break"), { ...paragraph("restart", "Restart"), type: "numbered-list" }
  ]);
  await select(page, "header", 7, 13);await paste(page, "header", "# literal\n- [x] Child");
  await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks[0].children.length).toBe(2);
  const header = (await readStored(page)).workspace.pages[0].blocks[0];
  expect(header.type).toBe("callout");expect(header.text).toBe("Before # literal");expect(header.children[0]).toMatchObject({ type: "task", checked: true, text: "Child tail" });expect(header.children[1].id).toBe("kept");
  for (const [id, number] of [["one", "1"], ["nested-number", "1"], ["two", "2"], ["restart", "1"]]) {
    await expect(page.locator(`[data-block="${id}"]`)).toHaveAttribute("data-list-number", number);
    expect(await page.locator(`[data-block="${id}"]`).evaluate(element => getComputedStyle(element, "::before").content)).toBe(`"${number}. "`);
  }
  await expect(page.locator('[data-move-block="nested-number:-1"]')).toBeDisabled();await expect(page.locator('[data-move-block="nested-number:1"]')).toBeDisabled();
  await expect(page.locator('[data-move-block="kept:-1"]')).toBeEnabled();await expect(page.locator('[data-move-block="kept:1"]')).toBeDisabled();
});

for (const outcome of ["abort", "complete"] as const) {
  test(`fold visibility waits for actual transaction ${outcome} and blocks concurrent input, history and navigation`, async ({ page }) => {
    const before = await seed(page);await select(page, "child", 4);await controlNextWrite(page, "hold");
    await page.locator('[data-toggle-block="outer"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).__containerPutSucceeded)).toBe(true);
    await expect(page.locator('[data-block="child"]')).toBeVisible();await expect(page.locator('[data-block="child"]')).toHaveAttribute("contenteditable", "false");await expect(page.locator("#pageTitle")).toHaveAttribute("readonly", "");await expect(page.locator('[data-toggle-block="outer"]')).toHaveAttribute("aria-expanded", "true");
    await page.locator('[data-block="child"]').dispatchEvent("compositionstart", { data: "blocked" });await page.locator('[data-block="child"]').dispatchEvent("compositionend", { data: "blocked" });
    await page.locator('[data-block="child"]').focus();await page.keyboard.type("UNSAVED");await page.keyboard.press("Control+z");
    await page.locator('#pageTree [data-open-page="target"]').click();await page.locator('[data-toggle-block="outer"]').click();
    await page.evaluate(outcome => { (window as any).__containerRelease = outcome; }, outcome);
    await expect(page.locator("#saveState")).toHaveText(outcome === "abort" ? "View change could not be saved. Try again." : "View saved.");
    const after = await readStored(page);expect(after.workspace).toEqual(before.workspace);expect(after.revision).toBe(before.revision);expect(after.activePageId).toBe("writing");expect(after.collapsedBlockIds).toEqual(outcome === "abort" ? [] : ["outer"]);
    expect(await page.evaluate(() => ({ writes: (window as any).__containerWrites, timedOut: (window as any).__containerTimedOut }))).toEqual({ writes: 1, timedOut: false });
    await page.evaluate(() => (window as any).__restoreContainerPut());
    if (outcome === "abort") { await expect(page.locator('[data-block="child"]')).toBeFocused();await expect(page.locator('[data-block="child"]')).toHaveText("Hiddenneedle [[Target]]");await page.locator('[data-toggle-block="outer"]').click();await expect(page.locator("#saveState")).toHaveText("View saved."); }
    await expect(page.locator('[data-block="child"]')).toHaveCount(0);await expect(page.locator('[data-block="outer"]')).toBeFocused();
    await page.reload();await expect(page.locator('[data-toggle-block="outer"]')).toHaveAttribute("aria-expanded", "false");expect((await readStored(page)).workspace).toEqual(before.workspace);
  });
}

test("failed pending child edits keep their draft visible until retry before folding", async ({ page }) => {
  const before = await seed(page);await controlNextWrite(page, "abort");
  await page.locator('[data-block="child"]').fill("Draft must survive");await page.locator('[data-toggle-block="outer"]').click();
  await expect(page.locator("#editRecovery")).toBeVisible();await expect(page.locator('[data-block="child"]')).toHaveText("Draft must survive");
  await expect(page.locator('[data-toggle-block="outer"]')).toHaveAttribute("aria-expanded", "true");expect((await readStored(page)).workspace).toEqual(before.workspace);
  await page.evaluate(() => (window as any).__restoreContainerPut());await page.locator("#retryEdit").click();await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
  await page.locator('[data-toggle-block="outer"]').click();await expect(page.locator("#saveState")).toHaveText("View saved.");
  expect((await readStored(page)).workspace.pages[0].blocks[0].children[0].children[0].text).toBe("Draft must survive");
  await page.reload();await page.locator('[data-toggle-block="outer"]').click();await expect(page.locator('[data-block="child"]')).toHaveText("Draft must survive");
});

test("hidden-child search and backlinks reveal every ancestor only after a successful UI-state write", async ({ page }) => {
  const before = await seed(page, nested(), ["outer", "inner"]);
  await page.locator("#openSearch").click();await page.locator("#searchInput").fill("Hiddenneedle");
  const result = page.locator('[data-search-entity-id="child"]');await expect(result).toBeVisible();await controlNextWrite(page, "abort");await result.click();
  await expect(page.locator("#saveState")).toHaveText("View change could not be saved. Try again.");await expect(page.locator("#searchDialog")).toBeVisible();expect(await readStored(page)).toEqual(before);
  await page.evaluate(() => (window as any).__restoreContainerPut());await result.click();await expect(page.locator("#searchDialog")).not.toBeVisible();await expect(page.locator('[data-block="child"]')).toBeFocused();
  const revealed = await readStored(page);expect(revealed.collapsedBlockIds).toEqual([]);expect(revealed.workspace).toEqual(before.workspace);expect(revealed.revision).toBe(before.revision);
  await page.locator('[data-toggle-block="inner"]').click();await expect(page.locator("#saveState")).toHaveText("View saved.");await page.locator('[data-toggle-block="outer"]').click();await expect(page.locator("#saveState")).toHaveText("View saved.");
  await page.locator('#pageTree [data-open-page="target"]').click();await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Target");
  await page.locator("#openContext").click();const backlink = page.locator('#backlinks [data-focus-block="child"]');await expect(backlink).toBeVisible();await backlink.click();
  await expect(page.locator('[data-block="child"]')).toBeFocused();expect((await readStored(page)).collapsedBlockIds).toEqual([]);expect((await readStored(page)).workspace).toEqual(before.workspace);
});

test("failed undo keeps the fold preference and canonical tree; retry and redo never focus hidden children", async ({ page }) => {
  const before = await seed(page);await page.locator('[data-block="child"]').fill("Changed child");await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
  await page.locator('[data-toggle-block="outer"]').click();await expect(page.locator("#saveState")).toHaveText("View saved.");const changed = await readStored(page);
  await controlNextWrite(page, "abort");await page.keyboard.press("Control+z");await expect(page.locator("#saveState")).toHaveText("Editor history could not be saved. Try again.");expect(await readStored(page)).toEqual(changed);
  await page.evaluate(() => (window as any).__restoreContainerPut());await page.keyboard.press("Control+z");await expect(page.locator("#saveState")).toHaveText("Change undone and saved.");
  const undone = await readStored(page);expect(undone.workspace.pages[0].blocks).toEqual(before.workspace.pages[0].blocks);expect(undone.collapsedBlockIds).toEqual(["outer"]);expect(undone.revision).toBe(changed.revision + 1);
  await expect(page.locator('[data-block="child"]')).toHaveCount(0);await expect(page.locator('[data-block="outer"]')).toBeFocused();
  await page.keyboard.press("Control+Shift+z");await expect(page.locator("#saveState")).toHaveText("Change redone and saved.");const redone = await readStored(page);expect(redone.workspace.pages[0].blocks).toEqual(changed.workspace.pages[0].blocks);expect(redone.collapsedBlockIds).toEqual(["outer"]);
  await page.reload();await expect(page.locator('[data-toggle-block="outer"]')).toHaveAttribute("aria-expanded", "false");expect(await readStored(page)).toEqual(redone);
});

test("Enter and indentation reveal their collapsed destination, keep IDs, and restore a visible writing focus", async ({ page }) => {
  await seed(page, [{ id: "outer", type: "toggle", text: "Heading", children: [paragraph("kept", "Keep child")] }, paragraph("tail", "Tail")], ["outer"]);
  await select(page, "outer", 7);await page.keyboard.press("Enter");
  await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks[0].children.length).toBe(2);
  let stored = await readStored(page);const childId = stored.workspace.pages[0].blocks[0].children[0].id;
  expect(stored.collapsedBlockIds).toEqual([]);expect(stored.workspace.pages[0].blocks[0].children[0]).toEqual({ id: childId, type: "paragraph", text: "", children: [] });
  await expect(page.locator(`[data-block="${childId}"]`)).toBeFocused();
  await page.keyboard.press("Alt+[");await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks.map((block: Block) => block.id)).toEqual(["outer", childId, "tail"]);
  await expect(page.locator(`[data-block="${childId}"]`)).toBeFocused();
  await page.locator('[data-toggle-block="outer"]').click();await expect(page.locator("#saveState")).toHaveText("View saved.");
  await page.locator(`[data-block="${childId}"]`).focus();await page.keyboard.press("Alt+]");
  await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks[0].children.map((block: Block) => block.id)).toEqual(["kept", childId]);
  stored = await readStored(page);expect(stored.collapsedBlockIds).toEqual([]);await expect(page.locator(`[data-block="${childId}"]`)).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks[0].children.map((block: Block) => block.id)).toEqual([childId, "kept"]);
  await expect(page.locator(`[data-block="${childId}"]`)).toBeFocused();
  await select(page, "outer", 0);const beforeBackspace = await readStored(page);await page.keyboard.press("Backspace");expect(await readStored(page)).toEqual(beforeBackspace);
  await page.reload();await expect(page.locator(`[data-block="${childId}"]`)).toBeVisible();await expect(page.locator('[data-block="kept"]')).toHaveText("Keep child");
});

test("a composing child remains visible and Shift+Enter stays in its container header", async ({ page }) => {
  await seed(page);const child = page.locator('[data-block="child"]');await child.focus();
  await child.dispatchEvent("compositionstart", { data: "draft" });await page.locator('[data-toggle-block="outer"]').click();
  await expect(page.locator("#saveState")).toHaveText("Finish composing text before changing the view.");await expect(child).toBeVisible();await expect(child).toBeFocused();expect((await readStored(page)).collapsedBlockIds).toEqual([]);
  await child.dispatchEvent("compositionend", { data: "" });await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
  await select(page, "outer", 3);await page.keyboard.press("Shift+Enter");await page.keyboard.type("New");
  await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks[0].text).toBe("Out\nNewer");
  const stored = await readStored(page);expect(stored.workspace.pages[0].blocks[0].type).toBe("toggle");expect(stored.workspace.pages[0].blocks[0].children.length).toBe(2);
  await page.reload();await expect(page.locator('[data-block="outer"]')).toHaveText("Out\nNewer");
});

test("same-page search reveal preserves block undo and existing page-tree preferences", async ({ page }) => {
  const before = await seed(page);
  await page.locator('[data-block="child"]').fill("Changedneedle");await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
  await page.locator('[data-toggle-block="outer"]').click();await expect(page.locator("#saveState")).toHaveText("View saved.");
  await page.locator("#openSearch").click();await page.locator("#searchInput").fill("Changedneedle");await page.locator('[data-search-entity-id="child"]').click();
  await expect(page.locator('[data-block="child"]')).toBeFocused();
  expect((await readStored(page)).expandedPageIds).toEqual(before.expandedPageIds);
  await page.keyboard.press("Control+z");await expect(page.locator("#saveState")).toHaveText("Change undone and saved.");
  const undone = await readStored(page);expect(undone.workspace.pages[0].blocks).toEqual(before.workspace.pages[0].blocks);expect(undone.collapsedBlockIds).toEqual([]);
  await expect(page.locator('[data-block="child"]')).toBeFocused();
});

test("aborted fold keeps native type and task controls consistent and restores prior disabled states", async ({ page }) => {
  const blocks = nested();blocks.push({ id: "task", type: "task", text: "Task control", checked: false, children: [] }, { id: "disabled-task", type: "task", text: "Existing disabled control", checked: false, children: [] });
  const before = await seed(page, blocks);
  await page.locator('[data-task="disabled-task"]').evaluate(control => { (control as HTMLInputElement).disabled = true; });
  await controlNextWrite(page, "hold");await page.locator('[data-toggle-block="outer"]').click();await expect.poll(() => page.evaluate(() => (window as any).__containerPutSucceeded)).toBe(true);
  await page.locator('[data-task="task"]').click({ force: true });
  await page.locator('[data-block-type="child"]').focus();await page.keyboard.press("ArrowDown");await page.keyboard.press("Tab");
  await page.evaluate(() => { (window as any).__containerRelease = "abort"; });await expect(page.locator("#saveState")).toHaveText("View change could not be saved. Try again.");
  await expect(page.locator('[data-task="task"]')).not.toBeChecked();await expect(page.locator('[data-task="task"]')).toBeEnabled();
  await expect(page.locator('[data-block-type="child"]')).toHaveValue("paragraph");await expect(page.locator('[data-block-type="child"]')).toBeEnabled();
  await expect(page.locator('[data-task="disabled-task"]')).toBeDisabled();expect(await readStored(page)).toEqual(before);
  expect(await page.evaluate(() => (window as any).__containerWrites)).toBe(1);await page.evaluate(() => (window as any).__restoreContainerPut());
});

test("file metadata containing editable-attribute markers stays literal and never becomes an editor or event attribute", async ({ page }) => {
  const fileName = "data-block=x data-trash-page=writing onmouseover=alert(1) z";
  const before = await seed(page, nested(), [], fileName);
  const file = page.locator('[data-block-id="file"] .block-input.file');
  await expect(file).toHaveAttribute("aria-label", `Attachment ${fileName}`);
  await expect(file).not.toHaveAttribute("data-block");await expect(file).not.toHaveAttribute("contenteditable");
  await expect(file).not.toHaveAttribute("data-trash-page");await expect(file).not.toHaveAttribute("onmouseover");
  await expect(file.locator("strong")).toHaveText(`📎 ${fileName}`);await expect(file.locator('[data-download-attachment="attachment"]')).toHaveCount(1);
  await page.locator('[data-toggle-block="outer"]').click();await expect(page.locator("#saveState")).toHaveText("View saved.");await page.locator('[data-toggle-block="outer"]').click();await expect(page.locator("#saveState")).toHaveText("View saved.");
  await expect(file).not.toHaveAttribute("data-block");await expect(file).not.toHaveAttribute("contenteditable");expect((await readStored(page)).workspace).toEqual(before.workspace);
});
