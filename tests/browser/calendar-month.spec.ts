import { test, expect, type Page } from "@playwright/test";

/* The true month: every day with what's on it, and Right Alt typing Polish. */

async function openMonth(page: Page, flags = "helmcal") {
  await page.goto(`/tasks.html?click&noagents&nofollow&${flags}`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Calendar");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Calendar$/ }).first().click();
  await page.locator(".cal-view", { hasText: "Month" }).click();
  await expect(page.locator(".cal-mgrid")).toBeVisible();
  await page.waitForTimeout(600);
}

const acts = (page: Page) => page.evaluate(() => (window as unknown as { __helmActs?: Record<string, unknown>[] }).__helmActs ?? []);

test("a day lists what's on it, and says how many more", async ({ page }) => {
  await openMonth(page);
  const today = page.locator(".cal-mcell.is-today");
  await expect(today.locator(".cal-mnum")).toHaveText(String(new Date().getDate()));
  await expect(today.locator(".cal-mmore")).toContainText("+");
  // Nothing spills out of the room it has.
  expect(await today.evaluate(cell => cell.scrollHeight <= cell.clientHeight + 1)).toBe(true);
});

test("the agenda is its own view", async ({ page }) => {
  await openMonth(page);
  await page.locator(".cal-view", { hasText: "Agenda" }).click();
  await expect(page.locator(".cal-agenda")).toBeVisible();
  await expect(page.locator(".cal-mgrid")).toHaveCount(0);
});

test("pressing a day opens its card, and everything is on it", async ({ page }) => {
  await openMonth(page);
  await page.locator(".cal-mcell.is-today .cal-mmore").click();
  const card = page.locator(".cal-daycard");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Esono call");
  await expect(card).toContainText("Kowalski review");
  await expect(card).toContainText("1 200 zł");
  await card.locator(".cal-mchip", { hasText: "Esono call" }).click();
  await expect(page.locator(".cal-panel .cal-panel-name")).toHaveValue("Esono call");
});

test("the date opens the day", async ({ page }) => {
  await openMonth(page);
  await page.locator(".cal-mcell.is-today .cal-mnum").click();
  await expect(page.locator('.cal-view[aria-pressed="true"]')).toHaveText("Day");
  await expect(page.locator(".cal-wkcol")).toHaveCount(1);
});

test("a meeting dragged to another day keeps its time, through Helm", async ({ page }) => {
  await openMonth(page, "helmcal&calmonthsolo");
  const box = (await page.locator('.cal-mchip[data-cal-id="prim:g1"]').boundingBox())!;
  const index = await page.locator(".cal-mcell.is-today").evaluate(cell => [...cell.parentElement!.children].indexOf(cell));
  const target = page.locator(".cal-mcell").nth(index + (index % 7 < 6 ? 1 : -1));
  const key = await target.getAttribute("data-day");
  const to = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + 8, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
  await expect(target).toHaveClass(/is-drop/);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const [one] = await acts(page);
  expect(one).toMatchObject({ action: "moveEvent", eventId: "g1", day: key, start: 11 * 60, end: 12 * 60 });
  await expect(page.locator(`.cal-mcell[data-day="${key}"] .cal-mchip[data-cal-id="prim:g1"]`)).toBeVisible();
});

test("Escape calls a month drag off", async ({ page }) => {
  await openMonth(page, "helmcal&calmonthsolo");
  const box = (await page.locator('.cal-mchip[data-cal-id="prim:g1"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 80, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await acts(page)).toEqual([]);
  await expect(page.locator('.screen[data-screen="calendar"]')).toBeVisible();
});

test("paging moves the month, and Today comes back", async ({ page }) => {
  await openMonth(page);
  const shown = page.locator(".cal-nav-label");
  const now = await shown.textContent();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(shown).not.toHaveText(now!);
  await expect(page.locator(".cal-mcell.is-today")).toHaveCount(0);
  await page.locator(".cal-today").click();
  await expect(shown).toHaveText(now!);
});

test("Right Alt and a letter types the Polish letter in a field", async ({ page }) => {
  await page.goto(`/tasks.html?click&noagents&nofollow`);
  await page.keyboard.press("Control+k");
  const field = page.locator(".palette-field");
  await field.focus();
  await page.keyboard.down("AltRight");
  for (const key of ["KeyL", "KeyO", "KeyS"]) await page.keyboard.press(key);
  await page.keyboard.up("AltRight");
  await page.keyboard.press("KeyA");
  await expect(field).toHaveValue("łóśa");
});
