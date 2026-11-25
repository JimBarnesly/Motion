import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

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
          scripts: [...document.scripts].map(script => ({ type: script.type, src: script.src })),
          invokeAvailable: typeof window.__TAURI__?.core?.invoke === "function"
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
  const child = spawn(executable, [], { windowsHide: false, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    WEBVIEW2_USER_DATA_FOLDER: webviewProfile
  } });
  let launchError;
  const current = { child, port, webviewProfile, label: `${role}-${++instanceSequence}`,
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

async function restoreVerifiedNotebook(current) {
  const page = current.page;
  const before = await nativeSnapshot(page);
  assert.equal(before.workspaces.length, 1, "The fixture contains exactly the original notebook before restore");
  const original = before.documents[0];
  const prepared = await bounded(page.evaluate(async () => {
    const { createMotionUiAdapter, encodeBinary } = await import(new URL("./app-adapter.js", location.href).href);
    const adapter = createMotionUiAdapter();
    if (adapter.kind !== "tauri") throw new Error("Expected the actual native adapter");
    const loaded = await adapter.load();
    const bundle = await adapter.createBackup();
    if (Object.values(bundle.files).some(bytes => !(bytes instanceof Uint8Array))) throw new Error("Native backup payloads were not decoded");
    const verification = await adapter.verifyBackup(bundle);
    const preview = await adapter.previewBackup(bundle);
    return { workspaceId: loaded.workspace.id, revision: loaded.revision, verification, preview,
      serialized: JSON.stringify(encodeBinary(bundle)) };
  }), 30_000, "Create, verify and preview the real native backup");
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
  const encoded = JSON.parse(prepared.serialized);
  assert.equal(encoded.manifest.workspaceId, original.workspace.id);
  assert.equal(encoded.manifest.format, "motion-workspace-backup");
  assert.equal(encoded.manifest.files.length, 2, "The backup includes its canonical workspace and attachment bytes");
  for (const file of encoded.manifest.files) {
    assert.deepEqual(Object.keys(encoded.files[file.path]), ["$motionBytes"]);
    const bytes = Buffer.from(encoded.files[file.path].$motionBytes);
    assert.equal(bytes.length, file.byteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  assert.equal(prepared.preview.totalBytes, encoded.manifest.files.reduce((sum, file) => sum + file.byteLength, 0));
  assert.deepEqual(await nativeSnapshot(page), before, "Backup creation, verification and preview do not mutate the original");

  // This proves the real adapter's backup codec and the UI file/confirmation
  // restore path. The native Save As dialog is deliberately outside this check.
  await writeFile(join(output, "installed-verified-backup.json"), prepared.serialized);
  const confirmation = { type: "confirm", observed: false,
    message: `Restore ${prepared.preview.workspaceName ?? "workspace"} with ${prepared.preview.pages} pages as a new workspace?` };
  current.expectedDialog = confirmation;
  await expect(page.locator("#restoreVerifiedBackup")).toBeEnabled();
  await page.locator("#verifiedBackupFile").setInputFiles({
    name: "installed-verified-backup.json", mimeType: "application/json", buffer: Buffer.from(prepared.serialized)
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
  return { baseline, evidence: { nativeCreateVerifyPreview: true, exactEncodedFileRestore: true,
    confirmationObserved: true, newWorkspaceIdentity: true, originalSnapshotAndRevisionUnchanged: true,
    addedWorkspaces: 1, exactRestoredAttachmentBytes: true,
    scope: "Installed adapter backup creation/verification/preview and UI file-input confirmation/restore; native Save As dialog is not automated." } };
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
    checks: ["native adapter", ...(phase === "installed" ? ["empty profile", "page editing", "attachment ingest", "verified backup create/verify/preview", "UI confirmation and restore into new workspace"] : ["selected restored notebook after uninstall/reinstall"]),
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
