import { expect, test, type Page } from "./fixtures";

type Block = { id: string; type: string; text: string; children: Block[]; [key: string]: unknown };
const paragraph = (id: string, text = id, children: Block[] = []): Block => ({ id, type: "paragraph", text, children });
const blockIds = (blocks: Block[]): string[] => blocks.flatMap(block => [block.id, ...blockIds(block.children)]);

async function readStored(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("motion-web-development", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<any>((resolve, reject) => {
        const transaction = database.transaction("workspace", "readonly");
        const request = transaction.objectStore("workspace").get("default");
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
  });
}

async function seed(page: Page, blocks: Block[]) {
  await page.goto("/");
  await expect(page.locator("#saveState")).toHaveText("Browser development mode");
  await page.evaluate(async initialBlocks => {
    const stamp = "2026-11-25T00:00:00.000Z";
    const value = {
      schemaVersion: 2, revision: 9, activePageId: "writing-page", expandedPageIds: [], activeViewIds: {},
      workspace: {
        schemaVersion: 2, id: "writing-workspace", name: "Nested writing", createdAt: stamp, updatedAt: stamp,
        databases: [], linkIndex: [],
        attachments: [{ id: "proof-attachment", fileName: "retained-evidence.bin", mediaType: "application/octet-stream",
          byteLength: 3, sha256: "a".repeat(64), path: "a".repeat(64), createdAt: stamp }],
        pages: [
          { id: "writing-page", parentId: null, title: "Nested writing", createdAt: stamp, updatedAt: stamp, blocks: initialBlocks },
          { id: "target-page", parentId: null, title: "Target", createdAt: stamp, updatedAt: stamp,
            blocks: [{ id: "target-content", type: "paragraph", text: "Keep the linked page unchanged", children: [] }] }
        ]
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
        transaction.objectStore("workspace").put(value, "default");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, blocks);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Nested writing");
  return readStored(page);
}

async function selectText(page: Page, blockId: string, start: number, end: number) {
  await page.locator(`[data-block="${blockId}"]`).evaluate((element, offsets) => {
    (element as HTMLElement).focus();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const point = (offset: number): [Node, number] => {
      for (const node of nodes) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
      }
      throw new Error("The selected text is outside the actual editor block");
    };
    const range = document.createRange();
    range.setStart(...point(offsets.start));
    range.setEnd(...point(offsets.end));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, { start, end });
}

test("Ctrl+D preserves a nested subtree and its targets through undo, redo, and durable reload", async ({ page }) => {
  const source: Block = {
    ...paragraph("source", "[[Target]] note"),
    references: [{ pageId: "target-page", start: 0, end: 10 }],
    unknownData: { imported: { sourceId: "source", flags: [true, false] } },
    children: [
      { id: "file-child", type: "file", text: "Evidence", attachmentId: "proof-attachment", children: [] },
      { id: "future-child", type: "future-widget", text: "Imported widget", pageId: "target-page", language: "future-language",
        unknownData: { payload: { id: "file-child", values: [1, { retained: "exactly" }] } },
        children: [{ ...paragraph("grandchild", "[[Target]] detail"), references: [{ pageId: "target-page" }] }] }
    ]
  };
  const original = [paragraph("outer", "Outer", [source, paragraph("following", "Following")]), paragraph("root-tail", "Root tail")];
  const before = await seed(page, original);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.locator('[data-block="source"]').focus();
  await page.keyboard.press("Control+d");
  await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
  await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks[0].children.length).toBe(3);

  const duplicated = await readStored(page);
  const copied: Block = duplicated.workspace.pages[0].blocks[0].children[1];
  const expectedCopy = structuredClone(source);
  expect(copied.id).not.toBe(source.id);
  expectedCopy.id = copied.id;
  expectedCopy.children[0].id = `${copied.id}:0`;
  expectedCopy.children[1].id = `${copied.id}:1`;
  expectedCopy.children[1].children[0].id = `${copied.id}:1.0`;
  expect(copied).toEqual(expectedCopy);
  const expectedBlocks = structuredClone(original);
  expectedBlocks[0].children.splice(1, 0, expectedCopy);
  expect(duplicated.workspace.pages[0].blocks).toEqual(expectedBlocks);
  const identities = [duplicated.workspace.id, ...duplicated.workspace.attachments.map((item: { id: string }) => item.id),
    ...duplicated.workspace.pages.flatMap((item: { id: string; blocks: Block[] }) => [item.id, ...blockIds(item.blocks)])];
  expect(new Set(identities).size).toBe(identities.length);
  expect(duplicated.workspace.pages.slice(1)).toEqual(before.workspace.pages.slice(1));
  expect(duplicated.workspace.attachments).toEqual(before.workspace.attachments);
  expect(duplicated.revision).toBe(before.revision + 1);
  await expect(page.locator(`[data-block-id="${copied.id}"]`)).toHaveCSS("--indent", "1");
  await expect(page.locator(".block-input.file")).toHaveCount(2);

  await page.keyboard.press("Control+z");
  await expect.poll(() => readStored(page)).toEqual(before);
  await expect(page.locator(`[data-block-id="${copied.id}"]`)).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => readStored(page)).toEqual(duplicated);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Nested writing");
  expect(await readStored(page)).toEqual(duplicated);
  await expect(page.locator(`[data-block="${copied.id}:1.0"]`)).toHaveText("[[Target]] detail");

  await page.locator(`[data-block="${copied.id}:1.0"]`).fill("[[Target]] edited copy");
  await expect.poll(async () => (await readStored(page)).workspace.pages[0].blocks[0].children[1].children[1].children[0].text)
    .toBe("[[Target]] edited copy");
  const edited = await readStored(page);
  expect(edited.workspace.pages[0].blocks[0].children[0]).toEqual(source);
  expect(edited.workspace.pages[0].blocks[0].children[1].children[1].unknownData).toEqual(source.children[1].unknownData);
  expect(edited.workspace.pages[0].blocks[0].children[1].children[1].children[0].references).toEqual([{ pageId: "target-page" }]);
  await page.reload();
  await expect(page.locator(`[data-block="${copied.id}:1.0"]`)).toHaveText("[[Target]] edited copy");
  await expect(page.locator('[data-block="grandchild"]')).toHaveText("[[Target]] detail");
  expect(await readStored(page)).toEqual(edited);
  expect(pageErrors).toEqual([]);
});

for (const leadingDivider of [false, true]) {
  test(`nested ${leadingDivider ? "leading-divider paste appends to its parent" : "Markdown paste precedes its actual sibling"} through undo, redo, and reload`, async ({ page }) => {
    const active: Block = { ...paragraph("active", "[[Target]] SELECT tail", [paragraph("retained-child", "Keep this child")]),
      references: [{ pageId: "target-page", start: 0, end: 10 }], unknownData: { imported: { retain: ["all", "fields"] } } };
    const following = leadingDivider ? [] : [paragraph("following-paste", "Following")];
    const original = [paragraph("outside", "Outside", [
      paragraph("paste-parent", "Parent", [active, ...following]), paragraph("outer-sibling", "Outer sibling")
    ]), paragraph("root-sibling", "Root sibling")];
    const before = await seed(page, original);
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await selectText(page, "active", 11, 17);
    const prevented = await page.locator('[data-block="active"]').evaluate((element, text) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", text);
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, leadingDivider ? "---\n- [x] Checklist" : "# Heading\n- [x] Checklist");
    expect(prevented).toBe(true);
    await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");
    const pasted = await readStored(page);
    const siblings: Block[] = pasted.workspace.pages[0].blocks[0].children[0].children;
    expect(siblings).toHaveLength(3);
    expect(siblings[0]).toEqual({ ...active, type: leadingDivider ? "paragraph" : "heading-1",
      text: leadingDivider ? "[[Target]] " : "[[Target]] Heading", references: [{ pageId: "target-page" }] });
    const task = siblings[leadingDivider ? 2 : 1];
    expect(task).toEqual({ id: expect.any(String), type: "task", text: "Checklist tail", checked: true, children: [] });
    if (leadingDivider) expect(siblings[1]).toEqual({ id: expect.any(String), type: "divider", text: "", children: [] });
    else expect(siblings[2]).toEqual(following[0]);
    const expectedBlocks = structuredClone(original);
    expectedBlocks[0].children[0].children = siblings;
    expect(pasted.workspace.pages[0].blocks).toEqual(expectedBlocks);
    expect(new Set(blockIds(expectedBlocks)).size).toBe(blockIds(expectedBlocks).length);
    expect(pasted.workspace.pages.slice(1)).toEqual(before.workspace.pages.slice(1));
    expect(pasted.workspace.attachments).toEqual(before.workspace.attachments);
    expect(pasted.revision).toBe(before.revision + 1);
    await expect(page.locator(`[data-block-id="${task.id}"]`)).toHaveCSS("--indent", "2");

    await page.keyboard.press("Control+z");
    await expect.poll(() => readStored(page)).toEqual(before);
    await expect(page.locator('[data-block="active"]')).toHaveText(active.text);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(() => readStored(page)).toEqual(pasted);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Nested writing");
    await expect(page.locator(`[data-block="${task.id}"]`)).toHaveText("Checklist tail");
    await expect(page.locator('[data-block="retained-child"]')).toHaveText("Keep this child");
    await expect(page.locator(`[data-block-id="${task.id}"]`)).toHaveCSS("--indent", "2");
    expect(await readStored(page)).toEqual(pasted);
    expect(pageErrors).toEqual([]);
  });
}
