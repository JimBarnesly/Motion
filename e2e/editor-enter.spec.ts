import { expect, test, type Page } from "./fixtures";

type Block = { id: string; type: string; text: string; children: Block[]; [key: string]: unknown };

async function seed(page: Page, blocks: Block[]) {
  await page.goto("/");
  await page.evaluate(async initialBlocks => {
    const stamp = "2026-11-25T00:00:00.000Z";
    const documentValue = {
      schemaVersion: 2, revision: 1, activePageId: "writing-page", expandedPageIds: [], activeViewIds: {},
      workspace: {
        schemaVersion: 2, id: "writing-workspace", name: "Writing", createdAt: stamp, updatedAt: stamp,
        databases: [], attachments: [], linkIndex: [],
        pages: [{ id: "writing-page", parentId: null, title: "Writing practice", createdAt: stamp, updatedAt: stamp, blocks: initialBlocks }]
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
  }, blocks);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Writing practice");
}

async function savedBlocks(page: Page): Promise<Block[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("motion-web-development", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Block[]>((resolve, reject) => {
        const request = database.transaction("workspace", "readonly").objectStore("workspace").get("default");
        request.onsuccess = () => resolve(request.result.workspace.pages[0].blocks);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
}

async function selectText(page: Page, id: string, start: number, end = start) {
  await page.locator(`[data-block="${id}"]`).evaluate((element, offsets) => {
    (element as HTMLElement).focus();
    const node = element.firstChild ?? element;
    const range = document.createRange();
    range.setStart(node, offsets.start);
    range.setEnd(node, offsets.end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, { start, end });
}

for (const hasFollowingSibling of [false, true]) {
  test(`Enter keeps a nested continuation ${hasFollowingSibling ? "before its sibling" : "under its parent"} after reload`, async ({ page }) => {
    await seed(page, [
      { id: "parent", type: "paragraph", text: "Parent", children: [
        { id: "child", type: "paragraph", text: "BeforeAfter", children: [] },
        ...(hasFollowingSibling ? [{ id: "sibling", type: "paragraph", text: "Sibling", children: [] }] : [])
      ] },
      { id: "root-sibling", type: "paragraph", text: "Root sibling", children: [] }
    ]);
    await selectText(page, "child", 6);
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-block="child"]')).toHaveText("Before");
    await expect(page.locator("#saveState")).toHaveText("Saved in browser (development mode)");

    const persisted = await savedBlocks(page);
    expect(persisted.map(block => block.id)).toEqual(["parent", "root-sibling"]);
    expect(persisted[0].children.map(block => block.text)).toEqual(hasFollowingSibling ? ["Before", "After", "Sibling"] : ["Before", "After"]);
    const continuationId = persisted[0].children[1].id;
    expect(continuationId).not.toBe("child");
    await expect(page.locator(`[data-block="${continuationId}"]`)).toBeFocused();
    await page.keyboard.type("New ");
    await expect.poll(async () => (await savedBlocks(page))[0].children[1].text).toBe("New After");

    await page.reload();
    await expect(page.locator(`[data-block-id="${continuationId}"]`)).toHaveAttribute("style", /--indent:1/);
    await expect(page.locator(`[data-block="${continuationId}"]`)).toHaveText("New After");
    await expect(page.locator('[data-block="child"]')).toHaveText("Before");
  });
}

test("Enter replaces the selected range and starts typing at the beginning of the continuation", async ({ page }) => {
  await seed(page, [{ id: "paragraph", type: "paragraph", text: "Alpha SELECT Omega", children: [] }]);
  await selectText(page, "paragraph", 6, 12);
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-block="paragraph"]')).toHaveText("Alpha ");
  await expect.poll(async () => (await savedBlocks(page)).map(block => block.text)).toEqual(["Alpha ", " Omega"]);
  const continuation = (await savedBlocks(page))[1];
  await expect(page.locator(`[data-block="${continuation.id}"]`)).toBeFocused();
  await page.keyboard.type("New");
  await expect.poll(async () => (await savedBlocks(page))[1].text).toBe("New Omega");
  await page.reload();
  expect((await savedBlocks(page)).map(block => block.text)).toEqual(["Alpha ", "New Omega"]);
  await expect(page.locator(`[data-block="${continuation.id}"]`)).toHaveText("New Omega");
});

test("a single undo reverses nested Enter and redo restores the same block identities", async ({ page }) => {
  const original: Block[] = [{ id: "parent", type: "paragraph", text: "Parent", children: [
    { id: "child", type: "paragraph", text: "BeforeAfter", children: [] }
  ] }];
  await seed(page, original);
  await selectText(page, "child", 6);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await savedBlocks(page))[0].children.map(block => block.text)).toEqual(["Before", "After"]);
  const split = await savedBlocks(page);
  await expect(page.locator(`[data-block="${split[0].children[1].id}"]`)).toBeFocused();

  await page.keyboard.press("Control+z");
  await expect.poll(() => savedBlocks(page)).toEqual(original);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => savedBlocks(page)).toEqual(split);
  await page.reload();
  expect(await savedBlocks(page)).toEqual(split);
});

test("Enter preserves a selection spanning multiple blocks until a supported command is chosen", async ({ page }) => {
  const original: Block[] = [
    { id: "first", type: "paragraph", text: "First paragraph", children: [] },
    { id: "second", type: "paragraph", text: "Second paragraph", children: [] }
  ];
  await seed(page, original);
  await page.evaluate(() => {
    const first = document.querySelector<HTMLElement>('[data-block="first"]')!;
    const second = document.querySelector<HTMLElement>('[data-block="second"]')!;
    first.focus();
    const range = document.createRange();
    range.setStart(first.firstChild!, 5);
    range.setEnd(second.firstChild!, 6);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press("Enter");
  await expect(page.locator("#saveState")).toContainText("within one block");
  expect(await savedBlocks(page)).toEqual(original);
  await expect(page.locator("[data-block]")).toHaveCount(2);
});

test("Enter inside code replaces a selection and keeps the caret immediately after the inserted newline", async ({ page }) => {
  await seed(page, [{ id: "code", type: "code", text: "beforeSELECTafter", language: "js", children: [] }]);
  await selectText(page, "code", 6, 12);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await savedBlocks(page)).map(block => block.text)).toEqual(["before\nafter"]);
  await expect.poll(() => page.locator('[data-block="code"]').evaluate(element => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return -1;
    const prefix = selection.getRangeAt(0).cloneRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(selection.anchorNode!, selection.anchorOffset);
    return prefix.toString().length;
  })).toBe(7);
  await page.keyboard.type("inserted ");
  await expect.poll(async () => (await savedBlocks(page))[0].text).toBe("before\ninserted after");
  await page.reload();
  expect(await savedBlocks(page)).toMatchObject([{ id: "code", type: "code", language: "js", text: "before\ninserted after" }]);
  await expect(page.locator('[data-block="code"]')).toHaveText("before\ninserted after");
});

test("IME composition confirms text without splitting or applying a Markdown shortcut", async ({ page }) => {
  await seed(page, [{ id: "paragraph", type: "paragraph", text: "Original", children: [] }]);
  const input = page.locator('[data-block="paragraph"]');
  await input.focus();
  const prevented = await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.textContent = "# ";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "# ", inputType: "insertCompositionText", isComposing: true }));
    return [
      { key: "Enter", isComposing: true },
      { key: "Enter", keyCode: 229 },
      { key: "Enter" }
    ].map(options => {
      const key = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });
      element.dispatchEvent(key);
      return key.defaultPrevented;
    });
  });
  expect(prevented).toEqual([false, false, false]);
  // Cross the editor's 180 ms save debounce to detect accidental mid-composition saves.
  await page.waitForTimeout(250);
  expect(await savedBlocks(page)).toMatchObject([{ id: "paragraph", type: "paragraph", text: "Original" }]);
  await expect(input).toHaveText("# ");
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "# " }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "# ", inputType: "insertCompositionText", isComposing: false }));
  });
  await expect.poll(async () => (await savedBlocks(page)).map(block => [block.id, block.type, block.text])).toEqual([["paragraph", "paragraph", "# "]]);
  await selectText(page, "paragraph", 2);
  await page.keyboard.type("日本語");
  await expect.poll(async () => (await savedBlocks(page))[0].text).toBe("# 日本語");
  await page.reload();
  await expect(input).toHaveText("# 日本語");
  await expect(page.locator("[data-block]")).toHaveCount(1);
});

test("Enter leaves unsupported block data intact", async ({ page }) => {
  const original = { id: "future", type: "future-widget", text: "Keep intact", children: [], unknownData: { extension: { values: [1, 2], label: "Keep me" } } };
  await seed(page, [original]);
  await selectText(page, "future", 4);
  await page.keyboard.press("Enter");
  await expect(page.locator("#saveState")).toContainText("cannot be split");
  expect(await savedBlocks(page)).toEqual([original]);
  await page.reload();
  expect(await savedBlocks(page)).toEqual([original]);
  await expect(page.locator('[data-block="future"]')).toHaveText("Keep intact");
});
