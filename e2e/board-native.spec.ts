import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Page } from "./fixtures";

async function bounded<T>(operation: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(description)), 5_000);
  })]); } finally { clearTimeout(timer); }
}

function launchService(root: string) {
  const child = spawn(process.execPath, [resolve("apps/desktop/service-runner.mjs"), root], {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MOTION_SERVICE_START_GATE: "0" }
  });
  const exited = once(child, "exit"), lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = "", tail: Promise<unknown> = Promise.resolve();
  child.stderr.setEncoding("utf8").on("data", part => { stderr = (stderr + part).slice(-4_000); });
  child.stdin.on("error", () => {});
  const send = (lane: string, payload: unknown): Promise<any> => {
    const operation = tail.then(async () => {
      let receive!: (line: string) => void;
      const pending = new Promise<string>(resolveLine => { receive = resolveLine; });
      lines.once("line", receive);
      try {
        child.stdin.write(JSON.stringify({ lane, payload }) + "\n");
        const reply = JSON.parse(await bounded(pending, "Service did not reply: " + stderr));
        if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
        return reply.value;
      } finally { lines.removeListener("line", receive); }
    });
    tail = operation.catch(() => {});
    return operation;
  };
  return { send, async close() {
    await tail;child.stdin.end();
    try { const [code] = await bounded(exited, "Service shutdown timed out");expect(code, stderr).toBe(0); }
    finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill();await bounded(exited, "Service cleanup timed out"); }
      lines.close();
    }
  } };
}

// Only Tauri's transport is substituted. The actual UI/codec, typed commands,
// canonical validator, SQLite persistence, view-state file and search run.
async function withNativeBoard(page: Page, filtered: boolean, body: (fixture: {
  initial: any; databaseId: string; pageId: string; statusId: string; recordId: string; boardId: string;
  snapshot: () => Promise<any>; selection: () => Promise<any>; commands: any[]; restart: () => Promise<void>;
}) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), "motion-board-ui-")), root = join(parent, "data");
  let service = launchService(root);
  const pageErrors: string[] = [], commands: any[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    let current = await service.send("command", { type: "workspace.create", name: "Board acceptance" });
    const workspaceId = current.workspace.id;
    const command = async (type: string, payload: any) => {
      current = await service.send("command", { type, workspaceId, expectedRevision: current.revision, ...payload });
      return current;
    };
    await command("database.create", { title: "Native board" });
    let database = current.workspace.databases[0];
    const databaseId = database.id, pageId = database.pageId;
    await command("database.property-add", { databaseId, property: { name: "Status", type: "status",
      options: [{ id: "doing", name: "In progress" }, { id: "todo", name: "To do" }, { id: "done", name: "Done" }, { id: "later", name: "Later" }] } });
    const statusId = current.workspace.databases[0].properties.find((property: any) => property.name === "Status").id;
    await command("database.record-create", { databaseId, title: "Alpha", values: { [statusId]: "todo" } });
    const recordId = current.workspace.databases[0].recordPageIds[0];
    await command("block.create", { pageId: recordId, position: { parentBlockId: null, beforeBlockId: null },
      block: { id: "preserved-body", type: "paragraph", text: "Keep record editor content", children: [] } });
    await command("block.create", { pageId: recordId, position: { parentBlockId: null, beforeBlockId: null },
      block: { id: "preserved-extension", type: "future-widget", text: "Keep opaque content", children: [], unknownData: { retained: [true, { id: "preserved-body" }] } } });
    await command("database.record-create", { databaseId, title: "Bravo", values: { [statusId]: "done" } });
    database = current.workspace.databases[0];
    const boardId = "native-board-view";
    await command("database.view-create", { databaseId, view: { id: boardId, name: "Native status", type: "board",
      visiblePropertyIds: [...database.views[0].visiblePropertyIds], propertyOrder: [...database.views[0].propertyOrder],
      groupByPropertyId: statusId, ...(filtered ? { filters: { kind: "condition", propertyId: statusId, operator: "equals", value: "todo" } } : {}) } });
    await service.send("ui-save", { schemaVersion: 2, document: { workspaceId, activePageId: pageId,
      expandedPageIds: [], activeViewIds: { [databaseId]: filtered ? boardId : current.workspace.databases[0].views[0].id }, collapsedBlockIds: [] } });
    await page.exposeFunction("__motionBoardTestInvoke", async (nativeCommand: string, args: any) => {
      try {
        let value;
        if (nativeCommand === "motion_ui_load") value = await service.send("ui-load", args.request);
        else if (nativeCommand === "motion_ui_save") value = await service.send("ui-save", args.request);
        else if (nativeCommand === "app_dispatch") {
          assert.equal(args.request.protocolVersion, 1);
          assert.ok(["query", "command", "async-query", "async-command"].includes(args.request.lane));
          if (args.request.lane === "command") commands.push(structuredClone(args.request.payload));
          value = await service.send(args.request.lane, args.request.payload);
        } else throw new Error("Unexpected native command in board fixture");
        return { ok: true, value };
      } catch (error: any) { return { ok: false, error: { code: error.code ?? "FIXTURE_ERROR", message: error.message } }; }
    });
    await page.addInitScript(() => {
      const runtime = window as any;
      runtime.__TAURI__ = { core: { invoke: async (command: string, args: unknown) => {
        const reply = await runtime.__motionBoardTestInvoke(command, args);
        if (!reply.ok) throw reply.error;
        return reply.value;
      } } };
    });
    await page.goto("/");await expect(page.locator("#saveState")).toHaveText("Connected to Motion");
    await body({ initial: current, databaseId, pageId, statusId, recordId, boardId, commands,
      snapshot: () => service.send("query", { type: "workspace.get", workspaceId }),
      selection: () => service.send("ui-load", { schemaVersion: 2 }),
      restart: async () => { await service.close();service = launchService(root); } });
    expect(pageErrors).toEqual([]);
  } finally { await service.close();await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

test("clear filters removes the native saved expression rather than only announcing success", async ({ page }) => {
  await withNativeBoard(page, true, async fixture => {
    await expect(page.locator(".board-card")).toHaveCount(1);
    await page.locator("#filterButton").click();await page.locator("#clearFilter").click();
    await expect(page.locator("#saveState")).toHaveText("Filters cleared.");
    await expect(page.locator(".board-card")).toHaveCount(2);
    const after = await fixture.snapshot();
    const database = after.workspace.databases[0];
    expect(database.views.find((view: any) => view.id === fixture.boardId)).not.toHaveProperty("filters");
    expect(database.recordPageIds).toEqual(fixture.initial.workspace.databases[0].recordPageIds);
    expect(after.workspace.pages).toEqual(fixture.initial.workspace.pages);
    expect(after.revision).toBe(fixture.initial.revision + 1);
    await page.reload();await expect(page.locator(".board-card")).toHaveCount(2);
    expect(await fixture.snapshot()).toEqual(after);
  });
});

test("GUI board moves and record editing preserve canonical pages through real service restart", async ({ page }) => {
  await withNativeBoard(page, false, async fixture => {
    await page.locator("#addBoardView").click();
    await expect(page.locator("#saveState")).toHaveText("View saved.");
    const boardId = await page.locator("#activeView").inputValue();
    await expect(page.locator(".board-lane-heading > span:first-child")).toHaveText(["In progress", "To do", "Done", "Later", "Unassigned"]);
    const move = page.locator(`[data-record="${fixture.recordId}"][data-board-move]`);
    await move.selectOption("done");
    await expect(page.locator(`[data-board-lane="done"] [data-record-id="${fixture.recordId}"]`)).toBeVisible();
    await expect(move).toBeFocused();
    let saved = await fixture.snapshot(), record = saved.workspace.pages.find((item: any) => item.id === fixture.recordId);
    const originalRecord = fixture.initial.workspace.pages.find((item: any) => item.id === fixture.recordId);
    expect(record.blocks).toEqual(originalRecord.blocks);
    expect(record.properties[fixture.statusId]).toBe("done");
    await move.selectOption("");
    await expect(page.locator(`[data-board-lane=""] [data-record-id="${fixture.recordId}"]`)).toBeVisible();
    saved = await fixture.snapshot();record = saved.workspace.pages.find((item: any) => item.id === fixture.recordId);
    expect(record.properties[fixture.statusId]).toBeNull();
    expect(fixture.commands.find(command => command.type === "database.record-update" && command.values[fixture.statusId] === null)).toBeTruthy();
    await move.selectOption("todo");
    await expect(page.locator(`[data-board-lane="todo"] [data-record-id="${fixture.recordId}"]`)).toBeVisible();
    await page.locator(`[data-board-open="${fixture.recordId}"]`).click();
    const title = page.getByRole("textbox", { name: "Page title", exact: true });
    await expect(title).toBeFocused();await title.fill("Alpha revised");
    await expect(page.locator("#saveState")).toHaveText("Saved to Motion");
    await expect(page.locator('[data-block="preserved-body"]')).toHaveText("Keep record editor content");
    await page.locator('#breadcrumbs button').getByText("Native board", { exact: true }).click();
    await expect(page.locator(`[data-board-open="${fixture.recordId}"]`)).toBeFocused();
    await expect(page.locator(`[data-board-open="${fixture.recordId}"]`)).toHaveText("Alpha revised");
    await page.locator("#addTableView").click();await expect(page.locator("#saveState")).toHaveText("View saved.");
    await expect(page.locator("table")).toBeVisible();
    await page.locator("#activeView").selectOption(boardId);await expect(page.locator("#saveState")).toHaveText("View saved.");
    const durable = await fixture.snapshot(), selected = await fixture.selection();
    expect(selected.activeViewIds[fixture.databaseId]).toBe(boardId);
    expect(durable.workspace.databases[0].recordPageIds).toEqual(fixture.initial.workspace.databases[0].recordPageIds);
    expect(durable.workspace.pages.find((item: any) => item.id === fixture.recordId).blocks).toEqual(originalRecord.blocks);
    expect(fixture.commands.filter(command => command.type === "database.record-reorder")).toEqual([]);
    await fixture.restart();await page.reload();
    await expect(page.locator("#activeView")).toHaveValue(boardId);
    await expect(page.locator(`[data-board-lane="todo"] [data-record-id="${fixture.recordId}"]`)).toBeVisible();
    expect(await fixture.snapshot()).toEqual(durable);
    expect(await fixture.selection()).toEqual(selected);
  });
});
