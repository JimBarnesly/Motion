import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { readAndVerifyBackupFile } from "../apps/desktop/backup-file.mjs";
import { decodeBinary } from "../apps/web/app-adapter.js";
import { expect, test, type Page } from "./fixtures";

async function bounded<T>(operation: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(description)), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

type SaveMode = "inspect-failure" | "damaged-bundle" | "missing-acknowledgement" | "invalid-byte-length" | "cancel" | "success";

// The actual UI, adapter, byte codec, verification, service inspection and file
// writer run here. The binding substitutes for Rust's native dialog/IPC only;
// it selects a fixture path and returns the same plain-object rejection shape.
// Installed Windows acceptance separately exercises the real dialog and helper.
async function withNativeBackup(page: Page, initialMode: SaveMode, body: (fixture: {
  root: string; destination: () => string; retry: () => void;
  snapshot: () => Promise<unknown>; saveCalls: () => number;
}) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), "motion-backup-recovery-"));
  const root = join(parent, "data");
  const child = spawn(process.execPath, [resolve("apps/desktop/service-runner.mjs"), root], {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MOTION_SERVICE_START_GATE: "0" }
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-4_000); });
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let tail: Promise<unknown> = Promise.resolve();
  const sendService = (lane: string, payload: unknown): Promise<any> => {
    const operation = tail.then(async () => {
      let receive!: (line: string) => void;
      const pending = new Promise<string>(resolveLine => { receive = resolveLine; });
      lines.once("line", receive);
      try {
        child.stdin.write(JSON.stringify({ lane, payload }) + "\n");
        const reply = JSON.parse(await bounded(pending, "Service did not reply: " + stderr));
        if (!reply.ok) throw reply.error;
        return reply.value;
      } finally { lines.removeListener("line", receive); }
    });
    tail = operation.catch(() => {});
    return operation;
  };
  let mode = initialMode;
  let destination = join(root, "selected.json");
  let saveCalls = 0;
  try {
    const created = await sendService("command", { type: "workspace.create", name: "Backup recovery" });
    const added = await sendService("command", { type: "page.create", workspaceId: created.workspace.id,
      expectedRevision: created.revision, title: "Preserve my notebook" });
    const pageId = added.workspace.pages[0].id;
    await sendService("ui-save", { schemaVersion: 2, document: { workspaceId: created.workspace.id,
      activePageId: pageId, expandedPageIds: [], activeViewIds: {} } });
    if (mode === "inspect-failure") await writeFile(destination, "This existing file must remain untouched.", { mode: 0o600 });
    await page.exposeFunction("__motionBackupTestInvoke", async (command: string, args: any) => {
      try {
        let value;
        if (command === "motion_ui_load") value = await sendService("ui-load", args.request);
        else if (command === "motion_ui_save") value = await sendService("ui-save", args.request);
        else if (command === "app_dispatch") {
          if (args.request.protocolVersion !== 1) throw new Error("Unexpected protocol");
          value = await sendService(args.request.lane, args.request.payload);
          if (mode === "damaged-bundle" && args.request.payload.type === "backup.create") {
            value.files["workspace.json"].$motionBytes[0] ^= 1;
          }
        } else if (command === "motion_backup_save") {
          saveCalls += 1;
          if (mode === "cancel") return { ok: true, value: { saved: false, cancelled: true } };
          // Preserve the real post-dialog inspection before dispatching save.
          const inspected = await sendService("native-backup-inspect", { destination });
          if (inspected.exists || inspected.replacement) throw new Error("Fixture requires a fresh destination");
          const saved = await sendService("native-backup-save", {
            destination, replaceConfirmed: false, bundle: args.request.bundle
          });
          value = mode === "missing-acknowledgement" ? {} : {
            saved: true, cancelled: false, replaced: false, byteLength: mode === "invalid-byte-length" ? null : saved.byteLength
          };
        } else throw new Error("Unexpected native command");
        return { ok: true, value };
      } catch (error: any) {
        return { ok: false, error: { code: error?.code ?? "FIXTURE_ERROR", message: error?.message ?? "Fixture failed" } };
      }
    });
    await page.addInitScript(() => {
      const runtime = window as any;
      runtime.__TAURI__ = { core: { invoke: async (command: string, args: unknown) => {
        const reply = await runtime.__motionBackupTestInvoke(command, args);
        if (!reply.ok) throw reply.error;
        return reply.value;
      } } };
    });
    await page.goto("/");
    await expect(page.locator("#saveState")).toHaveText("Connected to Motion");
    await page.locator("#attachmentFile").setInputFiles({ name: "proof.bin", mimeType: "application/octet-stream",
      buffer: Buffer.from([0, 1, 127, 128, 254, 255]) });
    await expect(page.locator("#saveState")).toHaveText("Attached proof.bin");
    await page.locator("details.workspace-tools").getByText("Workspace tools", { exact: true }).click();
    await body({ root, destination: () => destination,
      retry: () => { mode = "success"; destination = join(root, "retried.json"); },
      snapshot: () => sendService("query", { type: "workspace.get", workspaceId: created.workspace.id }),
      saveCalls: () => saveCalls });
  } finally {
    await tail;
    child.stdin.end();
    try {
      const [code] = await bounded(exited, "Service shutdown timed out");
      expect(code, stderr).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await bounded(exited, "Service did not stop during cleanup");
      }
      lines.close();
      await rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }
}

for (const mode of ["inspect-failure", "damaged-bundle", "missing-acknowledgement", "invalid-byte-length", "cancel"] as const) {
  test(`verified backup handles ${mode} visibly and retries without changing notebook content`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await withNativeBackup(page, mode, async fixture => {
      const before = await fixture.snapshot();
      await page.getByRole("button", { name: "Verified backup", exact: true }).click();
      const status = page.locator("#saveState");
      if (mode === "cancel") {
        await expect(status).toHaveText("Backup save cancelled.");
        await expect(status).toHaveAttribute("data-backup-state", "cancelled");
      } else {
        await expect(status).toHaveText(mode === "damaged-bundle"
          ? "Backup could not be prepared. Try Verified backup again."
          : "Backup save could not be confirmed. Check the selected destination, then try Verified backup again.");
        await expect(status).toHaveAttribute("data-backup-state", "failed");
        await expect(status).toHaveAttribute("data-backup-stage", mode === "damaged-bundle" ? "verify" : "save");
        await expect(status).toHaveAttribute("data-backup-error-code", ["missing-acknowledgement", "invalid-byte-length"].includes(mode) ? "INVALID_RESPONSE" : "VALIDATION_FAILED");
      }
      expect(await fixture.snapshot()).toEqual(before);
      if (mode === "inspect-failure") {
        expect(await readFile(fixture.destination(), "utf8")).toBe("This existing file must remain untouched.");
      } else if (["missing-acknowledgement", "invalid-byte-length"].includes(mode)) {
        expect(await readAndVerifyBackupFile(fixture.destination())).toEqual({ valid: true, errors: [] });
      } else {
        await expect(readFile(fixture.destination())).rejects.toHaveProperty("code", "ENOENT");
      }
      expect(fixture.saveCalls()).toBe(mode === "damaged-bundle" ? 0 : 1);
      expect(pageErrors).toEqual([]);

      fixture.retry();
      await page.getByRole("button", { name: "Verified backup", exact: true }).click();
      await expect(status).toHaveText("Verified backup saved safely.");
      await expect(status).toHaveAttribute("data-backup-state", "saved");
      await expect(status).not.toHaveAttribute("data-backup-error-code");
      expect(await readAndVerifyBackupFile(fixture.destination())).toEqual({ valid: true, errors: [] });
      const saved = decodeBinary(JSON.parse(await readFile(fixture.destination(), "utf8")));
      const savedWorkspace = JSON.parse(new TextDecoder().decode(saved.files["workspace.json"]));
      expect(savedWorkspace).toEqual((before as any).workspace);
      const attachment = Object.entries(saved.files).find(([path]) => path.startsWith("attachments/"))!;
      expect([...attachment[1] as Uint8Array]).toEqual([0, 1, 127, 128, 254, 255]);
      expect(await fixture.snapshot()).toEqual(before);
      expect(fixture.saveCalls()).toBe(mode === "damaged-bundle" ? 1 : 2);
      expect(pageErrors).toEqual([]);
    });
  });
}
