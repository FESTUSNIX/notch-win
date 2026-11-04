import { test, expect, type Page } from "@playwright/test";

/* A to-do renamed from Today, without a browser. */

async function openToday(page: Page) {
  await page.goto(`/tasks.html?click&noagents&nofollow&helm`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Today");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Today$/ }).first().click();
  await expect(page.locator(".helm-row").first()).toBeVisible();
  await page.waitForTimeout(500);
}

const queued = (page: Page) => page.evaluate(() =>
  (window as unknown as { __helmCalls: { command: string; args: { action: Record<string, unknown> } }[] }).__helmCalls
    .filter(one => one.command === "helm_queue").map(one => one.args.action));

const NAME = "Napisać post na blog HADA";

test("Enter keeps the new name and sends it", async ({ page }) => {
  await openToday(page);
  await page.getByRole("button", { name: `Rename: ${NAME}` }).click({ force: true });
  const field = page.locator(".helm-rename");
  await expect(field).toHaveValue(NAME);
  await field.fill("Post na blog: wycena sklepu");
  await field.press("Enter");
  await expect(page.locator(".helm-rename")).toHaveCount(0);
  await expect(page.locator(".helm-row", { hasText: "Post na blog: wycena sklepu" })).toBeVisible();
  expect(await queued(page)).toContainEqual({ act: "rename", key: "todo:1", title: "Post na blog: wycena sklepu" });
});

test("Escape puts it back and sends nothing", async ({ page }) => {
  await openToday(page);
  await page.getByRole("button", { name: `Rename: ${NAME}` }).click({ force: true });
  const field = page.locator(".helm-rename");
  await field.fill("Coś innego");
  await field.press("Escape");
  await expect(page.locator(".helm-row", { hasText: NAME })).toBeVisible();
  expect((await queued(page)).filter(one => one.act === "rename")).toEqual([]);
});

test("what doesn't have a name of its own offers no rename", async ({ page }) => {
  await openToday(page);
  const names = await page.getByRole("button", { name: /^Rename:/ }).evaluateAll(all => all.map(one => one.getAttribute("aria-label")));
  expect(names.length).toBeGreaterThan(0);
  expect(await page.locator(".helm-row", { hasText: "Faktura" }).getByRole("button", { name: /^Rename:/ }).count()).toBe(0);
});
