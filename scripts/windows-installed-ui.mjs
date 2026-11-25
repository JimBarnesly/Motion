import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { invokeWindowsNativeHelper } from "@motion/storage";

assert.equal(process.platform, "win32", "Installed UI acceptance requires Windows");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Use a disposable CI profile for installed UI acceptance");
const executable = process.env.MOTION_INSTALLED_APP;
assert.ok(executable && isAbsolute(executable) && executable.endsWith(".exe"));
const output = process.env.MOTION_ACCEPTANCE_OUTPUT;
assert.ok(output && isAbsolute(output));
const phase = process.env.MOTION_ACCEPTANCE_PHASE ?? "installed";
assert.ok(["installed", "reinstalled"].includes(phase), "Known installed acceptance phase");
await mkdir(output, { recursive: true });
const notebookTitle = "Windows acceptance notebook";
const notebookText = "Local notebook persists after the installed application closes.";
const attachmentName = "offline-proof.txt";
const attachmentBytes = Buffer.from("Motion installed attachment proof");
const baselinePath = join(output, "installed-notebook-baseline.json");
const forbiddenRequests = [], pageErrors = [], unexpectedDialogs = [];
const localOrigins = new Set(["http://tauri.localhost", "https://tauri.localhost", "http://ipc.localhost", "https://ipc.localhost"]);
const activeInstances = new Set();
const activeNativeDrivers = new Set();
let instanceSequence = 0;
let running;

function record(list, entry) {
  list.push(entry);
  if (list.length > 100) list.shift();
}

async function bounded(operation, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureFailureDiagnostics(current = running) {
  if (!current) return;
  const prefix = current === running ? phase : `${phase}-${current.label}`;
  const diagnostics = {
    schemaVersion: 1, commit: process.env.GITHUB_SHA, phase, instance: current.label,
    process: { exitCode: current.child.exitCode, signalCode: current.child.signalCode, stderr: current.stderr, stdout: current.stdout },
    console: current.console, browserLog: current.browserLog,
    failedRequests: current.failedRequests, failedResponses: current.failedResponses,
    pageErrors, forbiddenRequests, dialogs: current.dialogs, unexpectedDialogs
  };
  const page = current.page;
  if (page && !page.isClosed()) {
    try {
      diagnostics.startup = await bounded(page.evaluate(async () => {
        const startup = {
          url: location.href, readyState: document.readyState,
          contentChildren: document.querySelector("#content")?.childElementCount ?? null,
          saveState: document.querySelector("#saveState")?.textContent ?? null,
          backupState: document.querySelector("#saveState")?.dataset.backupState ?? null,
          backupStage: document.querySelector("#saveState")?.dataset.backupStage ?? null,
          backupErrorCode: document.querySelector("#saveState")?.dataset.backupErrorCode ?? null,
          scripts: [...document.scripts].map(script => ({ type: script.type, src: script.src })),
          invokeAvailable: typeof window.__TAURI__?.core?.invoke === "function",
          unhandledRejections: window.__motionAcceptanceRejections ?? []
        };
        if (!startup.invokeAvailable) return startup;
        // Read-only, bounded probe. Keep workspace contents out of diagnostic artifacts.
        let timer;
        try {
          startup.nativeLoad = await Promise.race([
            window.__TAURI__.core.invoke("motion_ui_load", { request: { schemaVersion: 2 } }).then(value => ({
              outcome: "resolved", schemaVersion: value?.schemaVersion,
              revision: value?.revision, emptyWorkspace: value?.workspace === null,
              pageCount: Array.isArray(value?.workspace?.pages) ? value.workspace.pages.length : null
            }), error => ({ outcome: "rejected", code: String(error?.code ?? "unknown").slice(0, 100), message: String(error?.message ?? error).slice(0, 512) })),
            new Promise(resolve => { timer = setTimeout(() => resolve({ outcome: "timeout" }), 5000); })
          ]);
        } finally {
          clearTimeout(timer);
        }
        return startup;
      }), 8000, "Startup diagnostic probe");
    } catch (error) {
      diagnostics.probeFailure = error.message;
    }
    try {
      await page.screenshot({ path: join(output, `${prefix}-ui-failure.png`), fullPage: true, timeout: 5000 });
    } catch (error) {
      diagnostics.screenshotFailure = error.message;
    }
  }
  diagnostics.process = { exitCode: current.child.exitCode, signalCode: current.child.signalCode, stderr: current.stderr, stdout: current.stdout };
  await writeFile(join(output, `${prefix}-startup-diagnostics.json`), `${JSON.stringify(diagnostics, null, 2)}\n`);
  console.error(`Installed startup diagnostic (${current.label}): ${JSON.stringify(diagnostics.startup ?? diagnostics.probeFailure ?? diagnostics.process)}`);
  if (current.stderr) console.error(`Installed application stderr: ${current.stderr}`);
  console.error(`Installed browser errors: ${JSON.stringify({ console: current.console.slice(-10), browserLog: current.browserLog.slice(-10), failedRequests: current.failedRequests.slice(-10), failedResponses: current.failedResponses.slice(-10), pageErrors })}`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function expectReady(current) {
  await expect(current.page.locator("#saveState")).toHaveText("Connected to Motion", { timeout: 30_000 });
  await expect(current.page.locator("#content")).not.toBeEmpty({ timeout: 30_000 });
  await expect(current.page.locator("[data-startup-state]")).toHaveCount(0);
}

async function launch({ startup = "ready", role = "owner" } = {}) {
  assert.ok(["ready", "blocked"].includes(startup));
  const webviewProfile = await mkdtemp(join(tmpdir(), "motion-webview-acceptance-"));
  const port = await freePort();
  const launchStartedAt = Date.now();
  const child = spawn(executable, [], { windowsHide: false, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env,
    MOTION_ACCEPTANCE_TRACE_BACKUP: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    WEBVIEW2_USER_DATA_FOLDER: webviewProfile
  } });
  const launchReturnedAt = Date.now();
  let launchError;
  const current = { child, port, webviewProfile, launchStartedAt, launchReturnedAt, label: `${role}-${++instanceSequence}`,
    browser: null, page: null, stderr: "", stdout: "", console: [], browserLog: [],
    failedRequests: [], failedResponses: [], dialogs: [], expectedDialog: null };
  child.stderr.on("data", bytes => { current.stderr = `${current.stderr}${bytes}`.slice(-12_000); });
  child.stdout.on("data", bytes => { current.stdout = `${current.stdout}${bytes}`.slice(-12_000); });
  child.on("error", error => { launchError = error; });
  activeInstances.add(current);
  running = current;
  let browser, lastConnectionError;
  const deadline = Date.now() + 60_000;
  while (!browser && Date.now() < deadline) {
    if (launchError || child.exitCode !== null) throw new Error(`Installed application did not stay running: ${launchError?.message ?? current.stderr}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 }); }
    catch (error) { lastConnectionError = error; await delay(200); }
  }
  if (!browser) throw new Error(`Installed WebView2 did not become available: ${lastConnectionError?.message ?? current.stderr}`);
  current.browser = browser;
  const context = browser.contexts()[0];
  assert.ok(context, "Installed application has a WebView2 context");
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (!["http:", "https:"].includes(url.protocol) || localOrigins.has(url.origin)) return route.continue();
    record(forbiddenRequests, { instance: current.label, origin: url.origin });
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", socket => {
    record(forbiddenRequests, { instance: current.label, origin: new URL(socket.url()).origin });
    socket.close({ code: 1008, reason: "External networking is disabled during installed acceptance" });
  });
  const page = context.pages().find(candidate => candidate.url().includes("tauri.localhost")) ?? context.pages()[0]
    ?? await context.waitForEvent("page", { timeout: 15_000 });
  current.page = page;
  page.setDefaultTimeout(15_000);
  // Observe only bounded error fields. Do not intercept IPC, suppress events,
  // or change application failure handling to obtain a passing result.
  await page.evaluate(() => {
    const observations = [];
    Object.defineProperty(window, "__motionAcceptanceRejections", { value: observations });
    window.addEventListener("unhandledrejection", event => {
      const reason = event.reason;
      observations.push({ type: typeof reason,
        code: typeof reason?.code === "string" ? reason.code.slice(0, 100) : null,
        message: typeof reason?.message === "string" ? reason.message.slice(0, 512) : null });
      if (observations.length > 20) observations.shift();
    });
  });
  page.on("pageerror", error => record(pageErrors, { instance: current.label, message: error.message }));
  page.on("console", message => record(current.console, { type: message.type(), text: message.text().slice(0, 2000), location: message.location() }));
  page.on("requestfailed", request => record(current.failedRequests, { url: request.url(), failure: request.failure()?.errorText }));
  page.on("response", response => {
    if (response.status() >= 400) record(current.failedResponses, { url: response.url(), status: response.status() });
  });
  page.on("dialog", async dialog => {
    const expected = current.expectedDialog;
    const accepted = expected?.type === dialog.type() && expected.message === dialog.message();
    const detail = { instance: current.label, type: dialog.type(), message: dialog.message().slice(0, 2000), accepted };
    record(current.dialogs, detail);
    try {
      if (accepted) {
        current.expectedDialog = null;
        await dialog.accept();
        expected.observed = true;
      } else {
        record(unexpectedDialogs, detail);
        await dialog.dismiss();
      }
    } catch (error) {
      record(unexpectedDialogs, { ...detail, failure: error.message });
    }
  });
  // CDP Log.enable replays retained browser entries, including CSP/module errors
  // that occurred before this controller connected. Do not reload past a failure.
  const logs = await context.newCDPSession(page);
  logs.on("Log.entryAdded", ({ entry }) => record(current.browserLog, {
    level: entry.level, source: entry.source, text: entry.text.slice(0, 2000), url: entry.url, lineNumber: entry.lineNumber
  }));
  await logs.send("Log.enable");
  if (startup === "blocked") {
    await expect(page.locator('[data-startup-state="error"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#saveState")).toHaveText("Could not open Motion");
    await expect(page.getByRole("button", { name: "Retry opening Motion" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveCount(0);
  } else {
    await expectReady(current);
  }
  assert.equal(await page.evaluate(() => typeof window.__TAURI__?.core?.invoke), "function");
  return current;
}

async function closeNormally(current) {
  assert.ok(activeInstances.has(current), "The exact installed instance must still be tracked");
  assert.equal(current.child.exitCode, null, "The installed window must remain running until normal close");
  assert.equal(current.child.signalCode, null);
  const exit = once(current.child, "exit");
  const powershellRoot = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
  const powershell = join(powershellRoot, "powershell.exe");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  assert.ok(Number.isSafeInteger(current.child.pid) && current.child.pid > 0);
  execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${current.child.pid}).CloseMainWindow()`], {
    windowsHide: true, timeout: 15_000, env: { ...environment, PSModulePath: join(powershellRoot, "Modules") }
  });
  const [code, signal] = await bounded(exit, 15_000, "Normal installed-window close");
  assert.equal(code, 0, "The installed application exits successfully after its window closes");
  assert.equal(signal, null);
  await bounded(current.browser.close(), 5000, "Installed browser disconnect");
  activeInstances.delete(current);
  if (running === current) running = [...activeInstances].at(-1);
}

async function nativeSnapshot(page) {
  return bounded(page.evaluate(async () => {
    const invoke = window.__TAURI__.core.invoke;
    const query = payload => invoke("app_dispatch", { request: { protocolVersion: 1, lane: "query", payload } });
    const selected = await invoke("motion_ui_load", { request: { schemaVersion: 2 } });
    const workspaces = await query({ type: "workspace.list" });
    if (!Array.isArray(workspaces) || workspaces.length > 8) throw new Error("Unexpected installed fixture workspace count");
    workspaces.sort((left, right) => left.id.localeCompare(right.id));
    const documents = [];
    for (const workspace of workspaces) documents.push(await query({ type: "workspace.get", workspaceId: workspace.id }));
    return { selected, workspaces, documents };
  }), 20_000, "Canonical native notebook snapshot");
}

async function expectNotebook(current, baseline) {
  const page = current.page;
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue(notebookTitle);
  await expect(page.locator('[contenteditable="true"][data-block]').first()).toHaveText(notebookText);
  await expect(page.locator(".block-input.file")).toContainText(attachmentName);
  const snapshot = await nativeSnapshot(page);
  assert.equal(snapshot.selected.workspace?.id, baseline.selectedWorkspaceId, "The restored notebook remains selected in native storage");
  assert.equal(snapshot.selected.revision, baseline.restored.revision);
  assert.equal(snapshot.selected.activePageId, baseline.activePageId);
  assert.deepEqual(snapshot.workspaces, baseline.workspaces, "Restart must not add or change a workspace");
  assert.deepEqual(snapshot.documents.find(item => item.workspace.id === baseline.original.workspace.id), baseline.original,
    "The original canonical workspace and its revision remain unchanged");
  assert.deepEqual(snapshot.documents.find(item => item.workspace.id === baseline.selectedWorkspaceId), baseline.restored,
    "The restored canonical workspace and its revision remain unchanged");
  const restoredAttachment = await bounded(page.evaluate(async fileName => {
    const { createMotionUiAdapter } = await import(new URL("./app-adapter.js", location.href).href);
    const adapter = createMotionUiAdapter();
    if (adapter.kind !== "tauri") throw new Error("Expected the actual native adapter");
    const loaded = await adapter.load();
    const matches = loaded.workspace.attachments.filter(item => item.fileName === fileName);
    if (matches.length !== 1) throw new Error("Expected one restored attachment");
    const result = await adapter.readAttachment(matches[0].id);
    if (!(result.bytes instanceof Uint8Array)) throw new Error("Native attachment bytes were not decoded");
    return { workspaceId: loaded.workspace.id, attachment: result.attachment, bytes: Array.from(result.bytes) };
  }, attachmentName), 15_000, "Read restored attachment through the installed adapter");
  assert.equal(restoredAttachment.workspaceId, baseline.selectedWorkspaceId);
  assert.equal(restoredAttachment.attachment.fileName, attachmentName);
  assert.deepEqual(restoredAttachment.bytes, [...attachmentBytes], "Restored attachment bytes are exact, including after restart/reinstall");
  return snapshot;
}

function startNativeDialogDriver(request) {
  const powershellRoot = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  const input = `${JSON.stringify(request)}\n`;
  assert.ok(Buffer.byteLength(input) <= 16_384);
  const child = spawn(join(powershellRoot, "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Mta", "-File",
    fileURLToPath(new URL("./windows-native-save-dialog.ps1", import.meta.url))], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...environment, PSModulePath: join(powershellRoot, "Modules") }
  });
  const messages = [];
  let buffer = "", stderr = "", outputBytes = 0, failure, stopping = false, progress = 0, resolveReady, resolveClosed, closedResult;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const fail = error => {
    failure ??= error;
    resolveReady(null);
    if (!stopping && child.exitCode === null && child.signalCode === null) { stopping = true; child.kill(); }
  };
  const timer = setTimeout(() => fail(new Error("Native dialog helper exceeded its 65-second deadline")), 65_000);
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.setEncoding("utf8").on("data", chunk => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > 128 * 1024) { fail(new Error("Native dialog helper exceeded its output limit")); return; }
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        assert.equal(message.schemaVersion, 1);
        assert.equal(message.operation, request.operation);
        assert.ok(!messages.some(previous => previous.event === "result"), "No native dialog output may follow its result");
        if (message.event === "result") {
          assert.equal(typeof message.ok, "boolean");
          if (message.ok && request.operation === "save") assert.equal(progress, 3, "All actual UI actions must have been observed");
        } else {
          assert.equal(request.operation, "save");
          assert.equal(message.event, ["ready", "dialog", "filename"][progress++]);
        }
        assert.ok(messages.length < 4);
        messages.push(message);
        if (message.event === "ready") resolveReady(message);
      } catch (error) { fail(error); }
    }
  });
  child.stderr.setEncoding("utf8").on("data", chunk => {
    outputBytes += Buffer.byteLength(chunk);
    stderr = `${stderr}${chunk}`.slice(-8192);
    if (outputBytes > 128 * 1024) fail(new Error("Native dialog helper exceeded its output limit"));
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    closedResult = { code, signal };
    resolveReady(null);
    resolveClosed(closedResult);
  });
  const driver = {
    child,
    evidence: () => ({ messages, stderr, failure: failure?.message, exit: closedResult }),
    async ready() {
      const message = await ready;
      if (!message || failure) throw failure ?? new Error("Native dialog helper closed before becoming ready");
      assert.equal(child.exitCode, null);
      return message;
    },
    async finish() {
      const exit = await bounded(closed, 70_000, "Native dialog helper completion");
      if (failure) throw failure;
      assert.equal(buffer.trim(), "", "Native dialog helper must finish a complete JSON line");
      assert.equal(exit.signal, null);
      const result = messages.at(-1);
      assert.equal(result?.event, "result", `Native dialog helper did not report a result: ${stderr}`);
      assert.equal(exit.code, result.ok ? 0 : 1);
      return result;
    },
    async stop() {
      if (!closedResult && child.exitCode === null && child.signalCode === null) child.kill();
      try { await bounded(closed, 5000, "Native dialog helper cleanup"); }
      catch (error) {
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
        throw error;
      }
      activeNativeDrivers.delete(driver);
    }
  };
  activeNativeDrivers.add(driver);
  child.stdin.end(input);
  return driver;
}

async function saveNativeBackupThroughDialog(current) {
  assert.equal(process.env.MOTION_NATIVE_HELPER, executable, "Fixture setup and read-back use the installed native helper");
  assert.ok(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP));
  const fixture = await mkdtemp(join(process.env.RUNNER_TEMP, "Motion native Save As "));
  const directory = join(fixture, "Private backups");
  const destination = join(directory, "Saved notebook proof.json");
  const neighbour = join(directory, "preserve.txt");
  const neighbourBytes = Buffer.from("Unrelated native save fixture remains unchanged.");
  const proof = { schemaVersion: 1, commit: process.env.GITHUB_SHA, phase, instance: current.label, status: "failed",
    scope: "Actual fresh-file native Save As; native cancellation and overwrite confirmations remain untested.", drivers: [] };
  const normalizedDestination = win32.normalize(destination).toLowerCase();
  proof.expectedDestination = { shape: "drive", length: destination.length,
    normalizedPathSha256: createHash("sha256").update(normalizedDestination).digest("hex"),
    normalizedParentSha256: createHash("sha256").update(win32.dirname(normalizedDestination)).digest("hex") };
  let savedBytes, operationFailure;
  async function runDriver(request, onReady) {
    const driver = startNativeDialogDriver(request);
    try {
      if (onReady) await onReady(await driver.ready());
      return await driver.finish();
    } finally {
      try { await driver.stop(); }
      finally { proof.drivers.push(driver.evidence()); }
    }
  }
  try {
    const privateRoot = invokeWindowsNativeHelper({ operation: "private.directory", path: directory, create: true });
    assert.match(privateRoot.identity, /^[a-f0-9]{64}$/);
    await writeFile(neighbour, neighbourBytes, { flag: "wx" });
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    assert.equal(current.child.exitCode, null);
    assert.equal(current.child.signalCode, null);
    const identified = await runDriver({ schemaVersion: 1, operation: "identify", processId: current.child.pid, executablePath: executable });
    assert.equal(identified.ok, true, identified.error?.message);
    const identity = identified.identity;
    assert.equal(identity.processId, current.child.pid);
    assert.equal(identity.executablePath.toLowerCase(), executable.toLowerCase());
    assert.ok(Number.isSafeInteger(identity.sessionId) && identity.sessionId >= 0);
    assert.match(identity.startTimeFileTimeUtc, /^\d{15,20}$/);
    const startedAt = Number((BigInt(identity.startTimeFileTimeUtc) - 116444736000000000n) / 10000n);
    assert.ok(startedAt >= current.launchStartedAt - 1000 && startedAt <= current.launchReturnedAt + 1000,
      "The authenticated process creation belongs to this controller's actual spawn");
    assert.equal(current.child.exitCode, null);
    proof.processIdentity = identity;
    const request = { schemaVersion: 1, operation: "save", processId: current.child.pid, executablePath: executable,
      expectedIdentity: identity, destination };

    // Real Windows negative control: a stale creation identity must fail before
    // UI Automation becomes ready or changes any control or destination.
    const stale = await runDriver({ ...request, expectedIdentity: { ...identity,
      startTimeFileTimeUtc: String(BigInt(identity.startTimeFileTimeUtc) + 1n) } });
    assert.equal(stale.ok, false);
    assert.equal(stale.phase, "authenticate");
    assert.equal(stale.error?.code, "PROCESS_IDENTITY_MISMATCH");
    assert.deepEqual(proof.drivers.at(-1).messages.map(message => message.event), ["result"]);
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    assert.deepEqual(await readFile(neighbour), neighbourBytes);
    proof.staleProcessIdentityRejectedBeforeUiAction = true;

    const tools = current.page.locator("details.workspace-tools");
    if (await tools.getAttribute("open") === null) await tools.locator("summary").click();
    await expect(current.page.locator("#createVerifiedBackup")).toBeVisible();
    await expect(current.page.locator("#createVerifiedBackup")).toBeEnabled();
    const selected = await runDriver(request, async ready => {
      assert.deepEqual(ready.identity, identity);
      assert.equal(current.child.exitCode, null);
      await current.page.locator("#createVerifiedBackup").click();
    });
    assert.equal(selected.ok, true, selected.error?.message);
    assert.equal(selected.dialog?.title, "Save verified Motion backup");
    assert.equal(selected.dialog?.processId, current.child.pid);
    assert.equal(selected.filename?.observedControlMatched, true);
    assert.equal(selected.filename?.control?.name, "File name:");
    assert.equal(selected.filename?.control?.automationId, "1001");
    assert.equal(selected.filename?.control?.controlType, "ControlType.Edit");
    assert.equal(selected.filename?.control?.processId, current.child.pid);
    assert.equal(selected.filename?.exactDestinationReadBack, true);
    assert.equal(selected.filename?.valuePattern, true);
    assert.equal(selected.filenameFocus?.observed, true);
    assert.equal(selected.filenameFocus?.control?.processId, current.child.pid);
    assert.equal(selected.filenameFocus?.control?.automationId, "1001");
    assert.equal(selected.filenameFocus?.control?.hasKeyboardFocus, true);
    assert.equal(selected.saveFocus?.observed, true);
    assert.equal(selected.saveFocus?.control?.processId, current.child.pid);
    assert.equal(selected.saveFocus?.control?.name, "Save");
    assert.equal(selected.saveFocus?.control?.hasKeyboardFocus, true);
    assert.equal(selected.filename?.exactDestinationAfterFocusChange, true);
    assert.equal(selected.invokePattern, true);
    assert.equal(selected.dialogClosed, true);
    await expect(current.page.locator("#saveState")).toHaveText("Verified backup saved safely.", { timeout: 30_000 });

    const metadata = await lstat(destination);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.size > 0 && metadata.size <= 16 * 1024 * 1024);
    // The installed helper independently authenticates the saved file's owner,
    // DACL, ancestry and single-link identity before returning its bounded bytes.
    const inspected = invokeWindowsNativeHelper({ operation: "backup.inspect", path: destination });
    assert.equal(inspected.exists, true);
    assert.match(inspected.identity, /^[a-f0-9]{64}$/);
    assert.equal(typeof inspected.contents, "string");
    savedBytes = Buffer.from(inspected.contents, "utf8");
    assert.equal(savedBytes.byteLength, metadata.size);
    assert.deepEqual(await readFile(destination), savedBytes, "The exact selected file contains the native-authenticated backup bytes");
    assert.deepEqual(await readFile(neighbour), neighbourBytes);
    assert.equal((await readdir(directory)).filter(name => name.endsWith(".tmp")).length, 0);
    proof.savedFile = { name: "Saved notebook proof.json", byteLength: savedBytes.byteLength,
      sha256: createHash("sha256").update(savedBytes).digest("hex"), privateSingleLinkAuthenticated: true,
      selectedPathContainsSpaces: true, unrelatedFileUnchanged: true, noTemporaryFiles: true };
    proof.nativeDialog = selected;
    proof.status = "passed";
  } catch (error) {
    operationFailure = error;
    proof.failure = String(error.message).slice(0, 2000);
    try {
      proof.applicationStatus = await bounded(current.page.locator("#saveState").evaluate(element => ({
        text: element.textContent?.slice(0, 512) ?? null,
        state: element.dataset.backupState ?? null, stage: element.dataset.backupStage ?? null,
        code: element.dataset.backupErrorCode ?? null
      })), 3000, "Backup failure status observation");
    } catch (statusError) { proof.statusObservationFailure = String(statusError.message).slice(0, 512); }
    // Preserve observations of the selected destination before fixture cleanup.
    // These read-only diagnostics never authorize or retry an application save.
    try {
      const metadata = await lstat(destination).catch(failure => {
        if (failure.code === "ENOENT") return null;
        throw failure;
      });
      proof.destinationAfterFailure = metadata === null ? { exists: false } : {
        exists: true, regularFile: metadata.isFile(), symbolicLink: metadata.isSymbolicLink(),
        links: metadata.nlink, byteLength: metadata.size
      };
      const inspected = invokeWindowsNativeHelper({ operation: "backup.inspect", path: destination });
      proof.nativeInspectionAfterFailure = { exists: inspected.exists,
        identity: typeof inspected.identity === "string" ? inspected.identity : null,
        byteLength: typeof inspected.contents === "string" ? Buffer.byteLength(inspected.contents, "utf8") : null,
        sha256: typeof inspected.contents === "string" ? createHash("sha256").update(inspected.contents).digest("hex") : null };
    } catch (inspectionError) {
      proof.nativeInspectionAfterFailure = { failed: true,
        code: typeof inspectionError.code === "string" ? inspectionError.code.slice(0, 100) : null,
        message: String(inspectionError.message).slice(0, 512) };
    }
  } finally {
    try { await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); proof.cleanupPassed = true; }
    catch (error) { operationFailure ??= error; proof.cleanupPassed = false; proof.cleanupFailure = error.message; }
    if (operationFailure) proof.status = "failed";
    await writeFile(join(output, "installed-native-save-dialog.json"), `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
  }
  if (operationFailure) throw operationFailure;
  return { bytes: savedBytes, evidence: { freshFileSavedThroughRealButtonAndDialog: true,
    processIdentityAuthenticated: true, staleProcessIdentityRejectedBeforeUiAction: true,
    filenameAndSaveFocusAuthenticated: true,
    filenameValuePatternAndSaveInvokePattern: true, savedFile: proof.savedFile, cleanupPassed: true,
    scope: proof.scope } };
}

async function restoreVerifiedNotebook(current) {
  const page = current.page;
  const before = await nativeSnapshot(page);
  assert.equal(before.workspaces.length, 1, "The fixture contains exactly the original notebook before restore");
  const original = before.documents[0];
  const saved = await saveNativeBackupThroughDialog(current);
  const serialized = saved.bytes.toString("utf8");
  assert.deepEqual(await nativeSnapshot(page), before, "Native Save As must preserve the entire original workspace and revision");
  const prepared = await bounded(page.evaluate(async serialized => {
    const { createMotionUiAdapter, decodeBinary } = await import(new URL("./app-adapter.js", location.href).href);
    const adapter = createMotionUiAdapter();
    if (adapter.kind !== "tauri") throw new Error("Expected the actual native adapter");
    const loaded = await adapter.load();
    const bundle = decodeBinary(JSON.parse(serialized));
    if (Object.values(bundle.files).some(bytes => !(bytes instanceof Uint8Array))) throw new Error("Native backup payloads were not decoded");
    const verification = await adapter.verifyBackup(bundle);
    const preview = await adapter.previewBackup(bundle);
    return { workspaceId: loaded.workspace.id, revision: loaded.revision, verification, preview };
  }, serialized), 30_000, "Verify and preview the actual native-saved backup");
  assert.equal(prepared.workspaceId, original.workspace.id);
  assert.equal(prepared.revision, original.revision);
  assert.deepEqual(prepared.verification, { valid: true, errors: [] });
  assert.equal(prepared.preview.valid, true);
  assert.deepEqual(prepared.preview.errors, []);
  assert.equal(prepared.preview.workspaceName, original.workspace.name);
  assert.equal(prepared.preview.pages, original.workspace.pages.length);
  assert.equal(prepared.preview.databases, original.workspace.databases.length);
  assert.equal(prepared.preview.records, 0);
  assert.equal(prepared.preview.attachments, 1);
  const encoded = JSON.parse(serialized);
  assert.equal(encoded.manifest.workspaceId, original.workspace.id);
  assert.equal(encoded.manifest.format, "motion-workspace-backup");
  assert.equal(encoded.manifest.files.length, 2, "The backup includes its canonical workspace and attachment bytes");
  for (const file of encoded.manifest.files) {
    assert.deepEqual(Object.keys(encoded.files[file.path]), ["$motionBytes"]);
    const bytes = Buffer.from(encoded.files[file.path].$motionBytes);
    assert.equal(bytes.length, file.byteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    if (file.path === "workspace.json") assert.deepEqual(JSON.parse(bytes.toString("utf8")), original.workspace);
    else assert.deepEqual(bytes, attachmentBytes, "The saved backup contains the exact original attachment bytes");
  }
  assert.equal(prepared.preview.totalBytes, encoded.manifest.files.reduce((sum, file) => sum + file.byteLength, 0));
  assert.deepEqual(await nativeSnapshot(page), before, "Backup creation, verification and preview do not mutate the original");

  // Preserve and restore the exact bytes written by Motion after the real native
  // Save As interaction. The controller never constructs the backup file.
  await writeFile(join(output, "installed-verified-backup.json"), saved.bytes, { flag: "wx" });
  const confirmation = { type: "confirm", observed: false,
    message: `Restore ${prepared.preview.workspaceName ?? "workspace"} with ${prepared.preview.pages} pages as a new workspace?` };
  current.expectedDialog = confirmation;
  await expect(page.locator("#restoreVerifiedBackup")).toBeEnabled();
  await page.locator("#verifiedBackupFile").setInputFiles({
    name: "installed-verified-backup.json", mimeType: "application/json", buffer: saved.bytes
  });
  await expect.poll(() => confirmation.observed, { timeout: 15_000, message: "The actual restore confirmation must be observed and accepted" }).toBe(true);
  await expect(page.locator("#saveState")).toHaveText("Verified backup restored.", { timeout: 30_000 });
  const after = await nativeSnapshot(page);
  const newWorkspaces = after.workspaces.filter(item => !before.workspaces.some(previous => previous.id === item.id));
  assert.equal(after.workspaces.length, before.workspaces.length + 1, "Restore adds exactly one workspace");
  assert.equal(newWorkspaces.length, 1);
  const restoredId = newWorkspaces[0].id;
  assert.notEqual(restoredId, original.workspace.id, "A verified backup restores into a new identity");
  assert.equal(after.selected.workspace.id, restoredId);
  assert.deepEqual(after.documents.filter(item => item.workspace.id !== restoredId), before.documents,
    "Restore leaves every original canonical value and revision unchanged");
  const restored = after.documents.find(item => item.workspace.id === restoredId);
  const baseline = { schemaVersion: 1, commit: process.env.GITHUB_SHA, selectedWorkspaceId: restoredId,
    activePageId: after.selected.activePageId, original, restored, workspaces: after.workspaces };
  await expectNotebook(current, baseline);
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  return { baseline, evidence: { nativeCreateVerifyPreview: true, nativeSaveAs: saved.evidence, exactEncodedFileRestore: true,
    confirmationObserved: true, newWorkspaceIdentity: true, originalSnapshotAndRevisionUnchanged: true,
    addedWorkspaces: 1, exactRestoredAttachmentBytes: true,
    scope: "Real Verified backup button and fresh-file native Save As, exact disk-byte verification/preview and UI confirmation/restore; native cancellation and overwrite remain untested." } };
}

async function exerciseSecondGui(owner, baseline) {
  const before = await expectNotebook(owner, baseline);
  const contender = await launch({ startup: "blocked", role: "contender" });
  assert.notEqual(contender.webviewProfile, owner.webviewProfile, "A separate browser profile excludes WebView profile-lock interference");
  assert.notEqual(contender.port, owner.port);
  assert.equal(owner.child.exitCode, null, "The original owner stays open during the contender attempt");
  const canaryName = `Rejected installed contender ${phase}`;
  const rejection = await bounded(contender.page.evaluate(async name => {
    try {
      await window.__TAURI__.core.invoke("app_dispatch", { request: {
        protocolVersion: 1, lane: "command", payload: { type: "workspace.create", name }
      } });
      return { rejected: false };
    } catch (error) {
      return { rejected: true, code: String(error?.code ?? "unknown") };
    }
  }, canaryName), 15_000, "Real contender mutation rejection");
  assert.equal(rejection.rejected, true, "The second installed GUI cannot mutate the owned notebook");
  assert.ok(["INTERNAL_ERROR", "STORAGE_FAILURE"].includes(rejection.code), "A valid canary reaches the native service boundary");
  assert.deepEqual(await nativeSnapshot(owner.page), before, "The owner list, selection, canonical values and revisions survive the rejected canary unchanged");
  await expect(contender.page.locator('[data-startup-state="error"]')).toBeVisible();
  await contender.page.screenshot({ path: join(output, `${phase}-second-gui-blocked.png`), fullPage: true, timeout: 5000 });

  await closeNormally(owner);
  const contenderPid = contender.child.pid;
  await contender.page.getByRole("button", { name: "Retry opening Motion" }).click();
  await expectReady(contender);
  assert.equal(contender.child.pid, contenderPid, "The same blocked GUI recovers through its existing Retry button");
  assert.equal(contender.child.exitCode, null);
  await expectNotebook(contender, baseline);
  await contender.page.screenshot({ path: join(output, `${phase}-second-gui-recovered.png`), fullPage: true, timeout: 5000 });
  return { current: contender, evidence: { separateWebViewProfiles: true, separateDebugPorts: true,
    visibleStartupFailure: true, mutationRejected: true, rejectionCode: rejection.code,
    ownerSnapshotAndListUnchanged: true, sameGuiRetryAfterOwnerCloses: true } };
}

async function cleanupInstances() {
  const failures = [];
  for (const driver of [...activeNativeDrivers]) {
    try { await driver.stop(); }
    catch (error) { failures.push({ operation: "native dialog helper cleanup", message: error.message }); }
  }
  for (const current of [...activeInstances]) {
    try {
      if (current.child.pid && current.child.exitCode === null && current.child.signalCode === null) {
        const exited = once(current.child, "exit");
        current.child.kill();
        await bounded(exited, 15_000, `Cleanup of ${current.label}`);
      }
    } catch (error) {
      failures.push({ instance: current.label, operation: "process exit", message: error.message });
    }
    try {
      if (current.browser) await bounded(current.browser.close(), 5000, `Disconnect ${current.label}`);
    } catch (error) {
      failures.push({ instance: current.label, operation: "browser disconnect", message: error.message });
    }
    activeInstances.delete(current);
  }
  return failures;
}

let acceptanceFailure, result;
try {
  let current = await launch();
  let baseline, backupEvidence;
  if (phase === "installed") {
    const initial = await nativeSnapshot(current.page);
    assert.equal(initial.selected.workspace, null, "Installed acceptance starts with an empty Motion profile");
    assert.deepEqual(initial.workspaces, []);
    await current.page.locator("#addRootPage").click();
    await current.page.getByRole("textbox", { name: "Page title" }).fill(notebookTitle);
    await expect(current.page.locator("#saveState")).toHaveText("Saved to Motion");
    // Native page.create starts with no blocks. Create the paragraph through
    // the actual UI instead of assuming the browser-development starter block.
    await current.page.getByRole("button", { name: "+ Add block", exact: true }).click();
    await expect(current.page.locator('[contenteditable="true"][data-block]')).toHaveCount(1);
    await current.page.locator('[contenteditable="true"][data-block]').first().fill(notebookText);
    await expect(current.page.locator("#saveState")).toHaveText("Saved to Motion");
    await current.page.locator("#attachmentFile").setInputFiles({ name: attachmentName, mimeType: "text/plain", buffer: attachmentBytes });
    await expect(current.page.locator(".block-input.file")).toContainText(attachmentName);
    ({ baseline, evidence: backupEvidence } = await restoreVerifiedNotebook(current));
  } else {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    assert.equal(baseline.schemaVersion, 1);
    assert.equal(baseline.commit, process.env.GITHUB_SHA, "Reinstallation compares against this exact candidate's installed fixture");
    assert.notEqual(baseline.selectedWorkspaceId, baseline.original.workspace.id);
    assert.equal(baseline.workspaces.length, 2);
    await expectNotebook(current, baseline);
    backupEvidence = { restoredNotebookSelectedAfterReinstall: true, originalAndRestoredSnapshotsUnchanged: true,
      exactRestoredAttachmentBytes: true, scope: "Reinstalled retention of the earlier UI restore; no additional restore or native Save As dialog is performed." };
  }
  await current.page.screenshot({ path: join(output, `${phase}-before-restart.png`), fullPage: true, timeout: 5000 });
  const exclusion = await exerciseSecondGui(current, baseline);
  current = exclusion.current;
  await closeNormally(current);

  current = await launch({ role: "restarted" });
  await expectNotebook(current, baseline);
  await current.page.locator("#openSearch").click();
  await current.page.getByRole("searchbox", { name: "Search workspace" }).fill("persists");
  await expect(current.page.locator("#searchResults")).toContainText(notebookTitle);
  await current.page.getByRole("button", { name: "Close search" }).click();
  await current.page.screenshot({ path: join(output, `${phase}-after-restart.png`), fullPage: true, timeout: 5000 });
  await closeNormally(current);
  assert.deepEqual(forbiddenRequests, [], "No external HTTP or WebSocket request was observed after connecting the test controller");
  assert.deepEqual(pageErrors, [], "Installed UI has no unhandled page errors");
  assert.deepEqual(unexpectedDialogs, [], "Only the explicitly checked restore confirmation may appear");
  result = { schemaVersion: 1, commit: process.env.GITHUB_SHA, phase, verdict: "PASS",
    checks: ["native adapter", ...(phase === "installed" ? ["empty profile", "page editing", "attachment ingest", "real Verified backup button and native Save As", "verified saved-backup bytes and preview", "UI confirmation and restore into new workspace"] : ["selected restored notebook after uninstall/reinstall"]),
      "unchanged original workspace and revision", "exact restored attachment bytes", "second installed GUI exclusion", "same GUI retry after owner closes",
      "normal window close", "selected restored notebook after restart", "native search", "no external renderer requests observed after CDP connection"],
    backup: backupEvidence, singleWriter: exclusion.evidence,
    networkBoundary: "Windows firewall blocks application, local service and WebView2 outbound traffic before launch" };
} catch (error) {
  acceptanceFailure = error;
  for (const current of [...activeInstances]) {
    try { await captureFailureDiagnostics(current); }
    catch (diagnosticError) { console.error(`Unable to save ${current.label} startup diagnostics: ${diagnosticError.message}`); }
  }
  await writeFile(join(output, `${phase}-ui-failure.txt`), `${error.stack ?? error}\n`);
} finally {
  const cleanupFailures = await cleanupInstances();
  if (cleanupFailures.length) {
    await writeFile(join(output, `${phase}-ui-cleanup-failures.json`), `${JSON.stringify(cleanupFailures, null, 2)}\n`);
    acceptanceFailure ??= new Error("An installed acceptance process failed bounded cleanup");
    console.error(`Installed acceptance cleanup failed: ${JSON.stringify(cleanupFailures)}`);
  }
}
if (acceptanceFailure) throw acceptanceFailure;
await writeFile(join(output, `${phase}-ui.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log("Installed Windows UI acceptance passed.");
