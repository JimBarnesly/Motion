import { expect, test } from "./fixtures";

test("database title preserves slow sequential typing across canonical saves", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("motion-web-development");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }));
  await page.reload();

  await page.getByRole("navigation", { name: "Workspace pages" }).getByRole("button", { name: "New table", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Database title" });
  await expect(title).toBeFocused();
  await title.pressSequentially("Todo", { delay: 250 });
  await expect(title).toHaveValue("Todo");
  await expect(page.getByRole("navigation", { name: "Workspace pages" }).getByText("Todo", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Saved");

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Database title" })).toHaveValue("Todo");
});
