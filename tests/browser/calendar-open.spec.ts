import { test, expect, type Page } from "@playwright/test";

/* The week opens on the now line, whatever the hour, and the grids get more height. */

async function openAt(page: Page, hour: number, minute = 30) {
  const at = new Date();
  at.setHours(hour, minute, 0, 0);
  await page.clock.install({ time: at });
  await page.goto(`/tasks.html?click&noagents&nofollow&calwrite`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Calendar");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Calendar$/ }).first().click();
  await expect(page.locator(".cal-weekgrid")).toBeVisible();
  await page.clock.runFor(1500);
  await page.waitForTimeout(800);
}

/** Where the now line is in what can be seen under the head, 0 at the top and 1 at the bottom. */
const lineAt = (page: Page) => page.evaluate(() => {
  const host = document.querySelector("#calendar-body") as HTMLElement;
  const box = host.getBoundingClientRect();
  const under = document.querySelector(".cal-wkstick")!.getBoundingClientRect().bottom;
  const line = document.querySelector(".cal-wknow")!.getBoundingClientRect().top;
  return (line - under) / (box.bottom - under);
});

for (const hour of [9, 14, 20, 22]) {
  test(`at ${hour}:30 the week opens with the now line in view`, async ({ page }) => {
    await openAt(page, hour);
    const at = await lineAt(page);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(0.9);
  });
}

test("an hour otherwise folded away stays open for the line", async ({ page }) => {
  await openAt(page, 22);
  const shut = await page.evaluate(() => {
    const line = document.querySelector(".cal-wknow") as HTMLElement;
    const y = parseFloat(line.style.top);
    const rows = [...document.querySelectorAll<HTMLElement>(".cal-wkband")];
    return rows.some(one => { const top = parseFloat(one.style.top); return y >= top && y < top + parseFloat(one.style.height); });
  });
  expect(shut).toBe(false);
});

test("the grids are taller than the other screens, and the agenda isn't", async ({ page }) => {
  await openAt(page, 14);
  const week = (await page.locator("#island-expanded").boundingBox())!.height;
  expect(week).toBeGreaterThan(560);
  await page.locator(".cal-view", { hasText: "Agenda" }).click();
  await page.clock.runFor(1500);
  await page.waitForTimeout(800);
  expect((await page.locator("#island-expanded").boundingBox())!.height).toBeLessThan(530);
});

test("scrolling stays put across a redraw", async ({ page }) => {
  await openAt(page, 14);
  await page.clock.runFor(1500);
  await page.locator("#calendar-body").evaluate(one => { one.scrollTop = 40; });
  await page.waitForTimeout(100);
  await page.evaluate(() => (window as unknown as { __calRefresh: () => void }).__calRefresh());
  await page.waitForTimeout(150);
  expect(await page.locator("#calendar-body").evaluate(one => one.scrollTop)).toBe(40);
});
