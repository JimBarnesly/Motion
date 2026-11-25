import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
const webviewProfile = await mkdtemp(join(tmpdir(), "motion-webview-acceptance-"));
const forbiddenRequests = [], pageErrors = [];
const localOrigins = new Set(["http://tauri.localhost", "https://tauri.localhost", "http://ipc.localhost", "https://ipc.localhost"]);
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

async function captureFailureDiagnostics() {
  const current = running;
  if (!current) return;
  const diagnostics = {
    schemaVersion: 1, commit: process.env.GITHUB_SHA, phase,
    process: { exitCode: current.child.exitCode, signalCode: current.child.signalCode, stderr: current.stderr, stdout: current.stdout },
    console: current.console, browserLog: current.browserLog,
    failedRequests: current.failedRequests, failedResponses: current.failedResponses,
    pageErrors, forbiddenRequests
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
      await page.screenshot({ path: join(output, `${phase}-ui-failure.png`), fullPage: true, timeout: 5000 });
    } catch (error) {
      diagnostics.screenshotFailure = error.message;
    }
  }
  diagnostics.process = { exitCode: current.child.exitCode, signalCode: current.child.signalCode, stderr: current.stderr, stdout: current.stdout };
  await writeFile(join(output, `${phase}-startup-diagnostics.json`), `${JSON.stringify(diagnostics, null, 2)}\n`);
  console.error(`Installed startup diagnostic: ${JSON.stringify(diagnostics.startup ?? diagnostics.probeFailure ?? diagnostics.process)}`);
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

async function launch() {
  const port = await freePort();
  const child = spawn(executable, [], { windowsHide: false, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    WEBVIEW2_USER_DATA_FOLDER: webviewProfile
  } });
  let launchError;
  const current = { child, browser: null, page: null, stderr: "", stdout: "", console: [], browserLog: [], failedRequests: [], failedResponses: [] };
  child.stderr.on("data", bytes => { current.stderr = `${current.stderr}${bytes}`.slice(-12_000); });
  child.stdout.on("data", bytes => { current.stdout = `${current.stdout}${bytes}`.slice(-12_000); });
  child.on("error", error => { launchError = error; });
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
    forbiddenRequests.push(url.origin);
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", socket => {
    forbiddenRequests.push(new URL(socket.url()).origin);
    socket.close({ code: 1008, reason: "External networking is disabled during installed acceptance" });
  });
  const page = context.pages().find(candidate => candidate.url().includes("tauri.localhost")) ?? context.pages()[0] ?? await context.waitForEvent("page");
  current.page = page;
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => record(current.console, { type: message.type(), text: message.text().slice(0, 2000), location: message.location() }));
  page.on("requestfailed", request => record(current.failedRequests, { url: request.url(), failure: request.failure()?.errorText }));
  page.on("response", response => {
    if (response.status() >= 400) record(current.failedResponses, { url: response.url(), status: response.status() });
  });
  page.on("dialog", dialog => dialog.accept());
  // CDP Log.enable replays retained browser entries, including CSP/module errors
  // that occurred before this controller connected. Do not reload past a failure.
  const logs = await context.newCDPSession(page);
  logs.on("Log.entryAdded", ({ entry }) => record(current.browserLog, {
    level: entry.level, source: entry.source, text: entry.text.slice(0, 2000), url: entry.url, lineNumber: entry.lineNumber
  }));
  await logs.send("Log.enable");
  await expect(page.locator("#saveState")).toHaveText("Connected to Motion", { timeout: 30_000 });
  await expect(page.locator("#content")).not.toBeEmpty({ timeout: 30_000 });
  assert.equal(await page.evaluate(() => typeof window.__TAURI__?.core?.invoke), "function");
  return page;
}

async function closeNormally() {
  const current = running;
  if (!current) return;
  const exit = once(current.child, "exit");
  const powershellRoot = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
  const powershell = join(powershellRoot, "powershell.exe");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  assert.ok(Number.isSafeInteger(current.child.pid) && current.child.pid > 0);
  execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${current.child.pid}).CloseMainWindow()`], {
    windowsHide: true, timeout: 15_000, env: { ...environment, PSModulePath: join(powershellRoot, "Modules") }
  });
  const ended = await Promise.race([exit.then(() => true), delay(15_000).then(() => false)]);
  assert.ok(ended, "The installed window closes normally and releases its service");
  await current.browser.close();
  running = undefined;
}

try {
  let page = await launch();
  const initial = await page.evaluate(() => window.__TAURI__.core.invoke("motion_ui_load", { request: { schemaVersion: 2 } }));
  if (phase === "installed") {
    assert.equal(initial.workspace, null, "Installed acceptance starts with an empty Motion profile");
    await page.locator("#addRootPage").click();
    await page.getByRole("textbox", { name: "Page title" }).fill("Windows acceptance notebook");
    await expect(page.locator("#saveState")).toHaveText("Saved to Motion");
    await page.locator('[contenteditable="true"][data-block]').first().fill("Local notebook persists after the installed application closes.");
    await expect(page.locator("#saveState")).toHaveText("Saved to Motion");
    await page.locator("#attachmentFile").setInputFiles({ name: "offline-proof.txt", mimeType: "text/plain", buffer: Buffer.from("Motion installed attachment proof") });
  } else {
    assert.ok(initial.workspace?.pages.some(item => item.title === "Windows acceptance notebook"), "Reinstallation retains the canonical notebook");
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Windows acceptance notebook");
    await expect(page.locator('[contenteditable="true"][data-block]').first()).toHaveText("Local notebook persists after the installed application closes.");
  }
  await expect(page.locator(".block-input.file")).toContainText("offline-proof.txt");
  await page.screenshot({ path: join(output, `${phase}-before-restart.png`), fullPage: true });
  await closeNormally();

  page = await launch();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Windows acceptance notebook");
  await expect(page.locator('[contenteditable="true"][data-block]').first()).toHaveText("Local notebook persists after the installed application closes.");
  await expect(page.locator(".block-input.file")).toContainText("offline-proof.txt");
  await page.locator("#openSearch").click();
  await page.getByRole("searchbox", { name: "Search workspace" }).fill("persists");
  await expect(page.locator("#searchResults")).toContainText("Windows acceptance notebook");
  await page.getByRole("button", { name: "Close search" }).click();
  await page.screenshot({ path: join(output, `${phase}-after-restart.png`), fullPage: true });
  assert.deepEqual(forbiddenRequests, [], "No external HTTP or WebSocket request was observed after connecting the test controller");
  assert.deepEqual(pageErrors, [], "Installed UI has no unhandled page errors");
  await closeNormally();
  await writeFile(join(output, `${phase}-ui.json`), `${JSON.stringify({ schemaVersion: 1, commit: process.env.GITHUB_SHA, phase, verdict: "PASS", checks: ["native adapter", ...(phase === "installed" ? ["empty profile", "page editing", "attachment ingest"] : ["retained notebook after uninstall/reinstall"]), "normal close", "restart persistence", "native search", "no external renderer requests observed after CDP connection"], networkBoundary: "Windows firewall blocks application, local service and WebView2 outbound traffic before launch" }, null, 2)}\n`);
  console.log("Installed Windows UI acceptance passed.");
} catch (error) {
  try { await captureFailureDiagnostics(); }
  catch (diagnosticError) { console.error(`Unable to save installed startup diagnostics: ${diagnosticError.message}`); }
  await writeFile(join(output, `${phase}-ui-failure.txt`), `${error.stack ?? error}\n`);
  throw error;
} finally {
  if (running) {
    running.child.kill();
    await running.browser?.close();
  }
}
