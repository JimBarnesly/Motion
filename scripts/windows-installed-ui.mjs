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
  let stderr = "", launchError;
  child.stderr.on("data", bytes => { stderr = `${stderr}${bytes}`.slice(-12_000); });
  child.stdout.resume();
  child.on("error", error => { launchError = error; });
  running = { child, browser: null };
  let browser, lastConnectionError;
  const deadline = Date.now() + 60_000;
  while (!browser && Date.now() < deadline) {
    if (launchError || child.exitCode !== null) throw new Error(`Installed application did not stay running: ${launchError?.message ?? stderr}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 }); }
    catch (error) { lastConnectionError = error; await delay(200); }
  }
  if (!browser) throw new Error(`Installed WebView2 did not become available: ${lastConnectionError?.message ?? stderr}`);
  running.browser = browser;
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
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  await expect(page.locator("#content")).not.toBeEmpty({ timeout: 30_000 });
  assert.equal(await page.evaluate(() => typeof window.__TAURI__?.core?.invoke), "function");
  return page;
}

async function closeNormally() {
  const current = running;
  if (!current) return;
  const exit = once(current.child, "exit");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  assert.ok(Number.isSafeInteger(current.child.pid) && current.child.pid > 0);
  execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${current.child.pid}).CloseMainWindow()`], { windowsHide: true, timeout: 15_000 });
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
  await writeFile(join(output, `${phase}-ui-failure.txt`), `${error.stack ?? error}\n`);
  throw error;
} finally {
  if (running) {
    running.child.kill();
    await running.browser?.close();
  }
}
