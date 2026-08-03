import { expect, test } from "@playwright/test";

test("local Web workspace persists, searches and exports without external network access", async ({ page, context, baseURL }) => {
  const localOrigin = new URL(baseURL!).origin;
  const externalRequests: string[] = [];
  const externalSockets: string[] = [];

  await context.route(/^https?:\/\//, async route => {
    const url = route.request().url();
    if (new URL(url).origin === localOrigin) await route.continue();
    else { externalRequests.push(url); await route.abort("blockedbyclient"); }
  });
  page.on("websocket", socket => {
    if (new URL(socket.url()).origin !== localOrigin) externalSockets.push(socket.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "Untitled page" })).toHaveCount(0);

  await page.getByRole("button", { name: "New page" }).click();
  const title = page.getByRole("textbox", { name: "Page title" });
  await title.fill("Pump commissioning notes");
  const body = page.locator('[contenteditable="true"][data-block]').first();
  await body.fill("Verified local pressure and flow before startup.");
  await expect(page.getByRole("status")).toHaveText(/Saved (?:in browser \(development mode\)|to Motion)/);
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map(database => database.name)))
    .toContain("motion-web-development");

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Pump commissioning notes");
  await expect(page.locator('[contenteditable="true"][data-block]').first()).toHaveText("Verified local pressure and flow before startup.");

  await page.getByRole("button", { name: /Search/ }).click();
  await page.getByRole("searchbox", { name: "Search workspace" }).fill("pressure");
  await expect(page.locator("#searchResults").getByRole("button", { name: /Pump commissioning notes/ })).toBeVisible();
  await page.getByRole("button", { name: "Close search" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^motion-(?:browser-development|canonical-export)-\d{4}-\d{2}-\d{2}\.json$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const pages = exported.workspace?.pages ?? JSON.parse(exported.files?.["workspace.json"] ?? "{}").pages;
  expect(pages[0]).toMatchObject({
    title: "Pump commissioning notes",
    blocks: [expect.objectContaining({ text: "Verified local pressure and flow before startup." })]
  });

  expect(externalRequests, `unexpected external HTTP(S) requests: ${externalRequests.join(", ")}`).toEqual([]);
  expect(externalSockets, `unexpected external WebSockets: ${externalSockets.join(", ")}`).toEqual([]);
});
