import { test, expect, type Page } from "@playwright/test";

/* A press lands on what was pressed (click-target.ts, `landOn` and `goTo` in
 * tasks.ts). Click mode, his, where a press reaches the pill. `&peek=` and
 * `&hmoment=` are task-client.ts's staged readings. */

const pill = (page: Page) => page.locator("#island-collapsed");
const moment = (page: Page) => page.locator("#island-moment");
const screen = (page: Page, name: string) => page.locator(`.screen[data-screen="${name}"]`);
const panel = (page: Page) => page.locator("#island-expanded");



test("a song's peek opens Playing, not the screen that was open", async ({ page }) => {
  await page.goto("/tasks.html?click&helm&running&noagents&nocal&peek=music&peekat=1500");
  await expect(pill(page)).toHaveAttribute("data-kind", "peek", { timeout: 5000 });
  await pill(page).click();
  await expect(screen(page, "media")).toHaveClass(/active/);
});

test("a meeting's peek without a link opens that event on the calendar", async ({ page }) => {
  await page.goto("/tasks.html?click&noagents&peek=leave&peekat=1500");
  await expect(pill(page)).toHaveAttribute("data-kind", "peek", { timeout: 8000 });
  await expect(pill(page)).toContainText("Czas wyjść");
  await pill(page).click();
  await expect(screen(page, "calendar")).toHaveClass(/active/);
  await expect(page.locator(".cal-panel-title")).toHaveText("Dentysta");
});

test("pressing the pill opens what it is showing", async ({ page }) => {
  await page.goto("/tasks.html?click&helm&running&noagents&nocal");
  await expect(pill(page)).toHaveAttribute("data-kind", "focus");
  await pill(page).click();
  await expect(screen(page, "helm")).toHaveClass(/active/);
});

test("her fund note has no screen yet, so a press opens nothing", async ({ page }) => {
  await page.goto("/tasks.html?click&noagents&nocal&gabi=penalty");
  await expect(pill(page)).toContainText("−50 zł", { timeout: 6000 });
  await pill(page).click();
  await page.waitForTimeout(400);
  await expect(panel(page)).toBeHidden();
});

test("a payment's moment stays up with its buttons when its body is pressed", async ({ page }) => {
  await page.goto("/tasks.html?click&helm&noagents&nocal&hmoment=remind");
  await expect(moment(page)).toBeVisible({ timeout: 8000 });
  await moment(page).locator(".m-line").click();
  await page.waitForTimeout(400);
  await expect(moment(page)).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await expect(moment(page).locator(".m-btn", { hasText: "Wyślij" })).toBeVisible();
});

test("Helm's prep opens that meeting, finding it through the calendar's name on the id", async ({ page }) => {
  await page.goto("/tasks.html?click&helm&noagents&hmoment=prep&prepevent");
  await expect(moment(page)).toBeVisible({ timeout: 8000 });
  await moment(page).locator(".m-title").click();
  await expect(screen(page, "calendar")).toHaveClass(/active/);
  await expect(page.locator(".cal-panel-title")).toContainText("Esono");
});

