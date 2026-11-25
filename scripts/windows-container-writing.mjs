import assert from "node:assert/strict";
import { expect as playwrightExpect } from "@playwright/test";

const expect = playwrightExpect.configure({ timeout: 15_000 });
const toggleText = "Writing notes";
const enteredText = "Container child kept by Enter";
const childText = "Containerquartz notes stay nested.";
const taskText = "Confirm the local writing task";
const calloutText = "Keep this local";
const calloutChildText = "This callout has its own child.";

function checkedId(value) {
  assert.equal(typeof value, "string", "Expected a canonical fixture identity");
  assert.equal(value.match(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u)?.[0], value,
    "Fixture identity must be complete and safe in an attribute selector");
  return value;
}

function selectedDocument(snapshot, workspaceId, pageId, allowRevisionTransition = false) {
  assert.ok(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot));
  assert.ok(Array.isArray(snapshot.workspaces) && Array.isArray(snapshot.documents));
  assert.equal(snapshot.workspaces.length, 1, "Container writing must preserve the single workspace");
  assert.equal(snapshot.documents.length, 1, "Every canonical workspace must be observed");
  const document = snapshot.documents[0], workspace = document.workspace, summary = snapshot.workspaces[0];
  assert.equal(summary.id, workspaceId);
  for (const observed of [snapshot.selected.workspace, workspace]) {
    assert.ok(observed && typeof observed === "object" && !Array.isArray(observed));
    assert.equal(observed.schemaVersion, 2);
    assert.equal(observed.id, workspaceId, "Writing must retain the original workspace identity");
    assert.ok(Array.isArray(observed.pages));
    assert.equal(observed.pages.length, 1, "Container writing must preserve the single notebook page");
    assert.equal(observed.pages[0].id, pageId, "Writing must retain the original page identity");
    assert.ok(Array.isArray(observed.pages[0].blocks));
    assert.deepEqual(observed.databases, []);
    assert.deepEqual(observed.attachments, [], "The controller adds its attachment after this helper");
  }
  assert.equal(snapshot.selected.activePageId, pageId);
  const revisions = [snapshot.selected.revision, summary.revision, document.revision];
  assert.ok(revisions.every(revision => Number.isSafeInteger(revision) && revision >= 0));
  if (!revisions.every(revision => revision === document.revision)) {
    assert.ok(allowRevisionTransition, "A stable native snapshot must have matching revisions");
    return null;
  }
  assert.deepEqual(snapshot.selected.workspace, workspace, "Native UI load and query agree on canonical content");
  assert.equal(summary.name, workspace.name);
  assert.equal(summary.updatedAt, workspace.updatedAt);
  return document;
}

async function selectText(page, blockId, start, end = start) {
  await page.locator(`[data-block="${checkedId(blockId)}"]`).evaluate((element, selection) => {
    if (!element.isContentEditable || !element.firstChild || element.childNodes.length !== 1
      || element.firstChild.nodeType !== Node.TEXT_NODE) throw new Error("Expected the plain-text fixture editor");
    element.focus();
    const range = document.createRange();
    range.setStart(element.firstChild, selection.start);
    range.setEnd(element.firstChild, selection.end);
    const current = window.getSelection();
    if (!current) throw new Error("The editor selection is unavailable");
    current.removeAllRanges();
    current.addRange(range);
  }, { start, end });
}

function assertViewOnly(snapshot, before, collapsedBlockIds) {
  assert.deepEqual(snapshot.documents, before.documents,
    "Folding and search reveal must not change canonical blocks, timestamps or revision");
  assert.deepEqual(snapshot.workspaces, before.workspaces);
  assert.deepEqual(snapshot.selected, { ...before.selected, collapsedBlockIds },
    "Only the persisted fold preference may change");
}

/**
 * Called by the installed controller after its first paragraph is durable and
 * before attachment/backup acceptance. All writes use the existing editor UI;
 * readSnapshot is the controller's bounded, read-only native IPC observation.
 * The paste event exercises Motion's real plain-text clipboard handler. It
 * does not claim operating-system clipboard integration.
 */
export async function exerciseContainerWriting({ page, readSnapshot, notebookTitle, notebookText }) {
  assert.equal(typeof readSnapshot, "function");
  assert.ok(typeof notebookTitle === "string" && notebookTitle.length > 0 && notebookTitle.length <= 500);
  assert.ok(typeof notebookText === "string" && notebookText.length > 0 && notebookText.length <= 1_000);
  const initial = await readSnapshot(page);
  const workspaceId = checkedId(initial.selected.workspace?.id);
  const pageId = checkedId(initial.selected.activePageId);
  const original = selectedDocument(initial, workspaceId, pageId);
  const originalPage = original.workspace.pages[0];
  assert.equal(originalPage.title, notebookTitle);
  assert.equal(originalPage.blocks.length, 1, "The controller must provide exactly its original paragraph");
  const originalParagraph = originalPage.blocks[0];
  checkedId(originalParagraph.id);
  assert.equal(originalParagraph.type, "paragraph");
  assert.equal(originalParagraph.text, notebookText);
  assert.deepEqual(originalParagraph.children, []);
  assert.deepEqual(initial.selected.collapsedBlockIds, []);
  await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue(notebookTitle);
  await expect(page.locator('[contenteditable="true"][data-block]').first()).toHaveText(notebookText);

  let incoherentSnapshotRetries = 0;
  const read = async (allowRevisionTransition = false) => {
    const snapshot = await readSnapshot(page);
    const document = selectedDocument(snapshot, workspaceId, pageId, allowRevisionTransition);
    // UI-load, list and get are separate native reads. Only a known revision
    // transition is retried; identity, shape and equal-revision content
    // failures remain immediate assertion failures, without a blanket catch.
    if (!document) { incoherentSnapshotRetries += 1;return null; }
    assert.deepEqual(document.workspace.pages[0].blocks[0], originalParagraph,
      "The original paragraph must remain byte-for-byte unchanged");
    return snapshot;
  };
  const waitFor = async (description, predicate) => {
    let snapshot;
    await expect.poll(async () => {
      snapshot = await read(true);
      if (!snapshot) return false;
      return predicate(snapshot.documents[0].workspace.pages[0], snapshot);
    }, { timeout: 20_000, message: description }).toBe(true);
    return snapshot;
  };

  await page.getByRole("button", { name: "+ Add block", exact: true }).click();
  const added = await waitFor("The UI appends a root paragraph", notebook => notebook.blocks.length === 2);
  const toggleId = checkedId(added.documents[0].workspace.pages[0].blocks[1].id);
  await page.locator(`[data-block="${toggleId}"]`).fill("/tog");
  await page.getByRole("option", { name: "Toggle Turn into toggle", exact: true }).click();
  await waitFor("The actual slash chooser creates a toggle", notebook => notebook.blocks[1]?.type === "toggle");
  await page.locator(`[data-block="${toggleId}"]`).fill(`${toggleText} SELECT ${enteredText}`);
  const typed = await waitFor("The toggle heading is saved before splitting", notebook =>
    notebook.blocks[1]?.text === `${toggleText} SELECT ${enteredText}`);
  await selectText(page, toggleId, toggleText.length, toggleText.length + " SELECT ".length);
  await page.keyboard.press("Enter");
  const entered = await waitFor("Enter creates a real paragraph child", notebook => notebook.blocks[1]?.text === toggleText
    && notebook.blocks[1]?.children.length === 1 && notebook.blocks[1].children[0].text === enteredText);
  const toggle = entered.documents[0].workspace.pages[0].blocks[1];
  const childId = checkedId(toggle.children[0].id);
  assert.equal(toggle.id, toggleId);
  assert.equal(toggle.type, "toggle");
  assert.equal(toggle.children[0].type, "paragraph");
  assert.equal(entered.documents[0].revision, typed.documents[0].revision + 1, "Header split is one atomic command batch");
  await expect(page.locator(`[data-block="${childId}"]`)).toBeFocused();

  await selectText(page, childId, 0, enteredText.length);
  await page.locator(`[data-block="${childId}"]`).evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(paste);
    if (!paste.defaultPrevented) throw new Error("Motion did not handle the multiline paste");
  }, `${childText}\n- [ ] ${taskText}`);
  const pasted = await waitFor("Multiline paste inserts siblings under the real toggle parent", notebook =>
    notebook.blocks.length === 2 && notebook.blocks[1]?.children.length === 2
      && notebook.blocks[1].children[0].text === childText && notebook.blocks[1].children[1].text === taskText);
  const pastedChildren = pasted.documents[0].workspace.pages[0].blocks[1].children;
  assert.equal(pastedChildren[0].id, childId, "Pasting preserves the active child identity");
  assert.deepEqual(pastedChildren.map(block => block.type), ["paragraph", "task"]);
  assert.equal(pastedChildren[1].checked, false);
  assert.equal(pasted.documents[0].revision, entered.documents[0].revision + 1, "Multiline paste is one atomic command batch");
  const taskId = checkedId(pastedChildren[1].id);
  await expect(page.locator(`[data-block="${taskId}"]`)).toBeFocused();
  await page.locator(`[data-task="${taskId}"]`).check();
  await waitFor("The nested task control saves its checked state", notebook => notebook.blocks[1]?.children[1]?.checked === true);

  await page.getByRole("button", { name: "+ Add block", exact: true }).click();
  const withCallout = await waitFor("A separate root block is appended", notebook => notebook.blocks.length === 3);
  const calloutId = checkedId(withCallout.documents[0].workspace.pages[0].blocks[2].id);
  await page.locator(`[data-block-type="${calloutId}"]`).selectOption("callout");
  await waitFor("The actual type selector creates a callout", notebook => notebook.blocks[2]?.type === "callout");
  await page.locator(`[data-block="${calloutId}"]`).fill(`${calloutText} SELECT ${calloutChildText}`);
  const calloutHeader = await waitFor("The callout header is durable", notebook => notebook.blocks[2]?.text === `${calloutText} SELECT ${calloutChildText}`);
  await selectText(page, calloutId, calloutText.length, calloutText.length + " SELECT ".length);
  await page.keyboard.press("Enter");
  const written = await waitFor("Callout Enter retains its type and creates its own child", notebook =>
    notebook.blocks[2]?.text === calloutText && notebook.blocks[2]?.children.length === 1
      && notebook.blocks[2].children[0].text === calloutChildText);
  const notebook = written.documents[0].workspace.pages[0];
  assert.equal(written.documents[0].revision, calloutHeader.documents[0].revision + 1, "Callout header split is one atomic command batch");
  assert.deepEqual(notebook.blocks.map(block => block.type), ["paragraph", "toggle", "callout"]);
  assert.equal(notebook.blocks[2].id, calloutId);
  assert.equal(notebook.blocks[2].children[0].type, "paragraph");
  const calloutChildId = checkedId(notebook.blocks[2].children[0].id);
  const blockIds = [originalParagraph.id, toggleId, childId, taskId, calloutId, calloutChildId];
  assert.equal(new Set(blockIds).size, 6, "Every root and child has a distinct canonical identity");
  assert.deepEqual(notebook.blocks[1].children.map(block => ({ id: block.id, type: block.type, text: block.text })), [
    { id: childId, type: "paragraph", text: childText }, { id: taskId, type: "task", text: taskText }
  ]);
  assert.equal(notebook.blocks[1].children[1].checked, true);
  await expect(page.locator(`[data-block="${calloutChildId}"]`)).toBeFocused();
  // Only the page's block tree and its normal command timestamps may differ.
  assert.deepEqual({ ...written.documents[0].workspace, updatedAt: original.workspace.updatedAt,
    pages: [{ ...notebook, blocks: originalPage.blocks, updatedAt: originalPage.updatedAt }] }, original.workspace);

  const disclosure = page.locator(`[data-toggle-block="${toggleId}"]`);
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await disclosure.click();
  const collapsed = await waitFor("Folding saves the native view preference", (_notebook, snapshot) =>
    snapshot.selected.collapsedBlockIds.length === 1 && snapshot.selected.collapsedBlockIds[0] === toggleId);
  assertViewOnly(collapsed, written, [toggleId]);
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`[data-block="${childId}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-task="${taskId}"]`)).toHaveCount(0);
  await disclosure.click();
  const expanded = await waitFor("Unfolding clears the native view preference", (_notebook, snapshot) => snapshot.selected.collapsedBlockIds.length === 0);
  assertViewOnly(expanded, written, []);
  await expect(page.locator(`[data-block="${childId}"]`)).toHaveText(childText);
  await expect(page.locator(`[data-task="${taskId}"]`)).toBeChecked();

  await disclosure.click();
  const hidden = await waitFor("The child is folded before native search", (_notebook, snapshot) =>
    snapshot.selected.collapsedBlockIds.length === 1 && snapshot.selected.collapsedBlockIds[0] === toggleId);
  assertViewOnly(hidden, written, [toggleId]);
  await expect(page.locator(`[data-block="${childId}"]`)).toHaveCount(0);
  await page.locator("#openSearch").click();
  await page.getByRole("searchbox", { name: "Search workspace" }).fill("Containerquartz");
  const hit = page.locator(`[data-search-entity-id="${childId}"]`);
  await expect(hit).toHaveCount(1);
  // Native FTS brackets the matched term in its displayed snippet.
  await expect(hit).toContainText("[Containerquartz] notes stay nested.");
  await hit.click();
  await expect(page.locator("#searchDialog")).not.toBeVisible();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`[data-block="${childId}"]`)).toBeFocused();
  const revealed = await waitFor("Search reveals and persists the actual hidden block", (_notebook, snapshot) => snapshot.selected.collapsedBlockIds.length === 0);
  assertViewOnly(revealed, written, []);
  await expect(page.locator('[contenteditable="true"][data-block]').first()).toHaveText(notebookText);
  await expect(page.locator(`[data-task="${taskId}"]`)).toBeChecked();
  await expect(page.locator(`[data-block="${calloutId}"]`)).toHaveText(calloutText);
  assertViewOnly(await read(), written, []);

  return { schemaVersion: 1, workspaceId, pageId,
    blockIds: { original: originalParagraph.id, toggle: toggleId, child: childId, task: taskId, callout: calloutId, calloutChild: calloutChildId },
    beforeRevision: original.revision, writtenRevision: written.documents[0].revision, afterRevealRevision: revealed.documents[0].revision,
    incoherentSnapshotRetries,
    workspaceCount: 1, pageCount: 1, rootBlockCount: 3, totalBlockCount: 6, attachmentCountBeforeControllerIngest: 0,
    checks: ["GUI slash toggle", "GUI type-selector callout", "atomic header Enter children", "atomic multiline paste at actual parent",
      "nested task checked through UI", "distinct canonical child identities", "original paragraph unchanged", "fold and unfold persisted",
      "hidden child found by native search", "search reveal persisted and focused", "fold and reveal preserve the complete canonical snapshot and revision"],
    scope: "Real editor and native snapshot assertions. Paste uses the application's ClipboardEvent handler; operating-system clipboard integration is not asserted. The calling controller separately validates attachment, backup, restore and restart retention." };
}
