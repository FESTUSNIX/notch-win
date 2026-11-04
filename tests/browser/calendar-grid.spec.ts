import { test, expect, type Page } from "@playwright/test";

/* The week grid's gestures, each one a bug found by driving it (4 Nov). `calwrite`
 * makes the demo events writable and records every write in `__calWrites`. */

async function openWeek(page: Page, flags = "") {
  await page.goto(`/tasks.html?click&noagents&nofollow&calwrite&${flags}`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Calendar");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Calendar$/ }).first().click();
  await expect(page.locator('.screen[data-screen="calendar"]')).toBeVisible();
  await page.locator(".cal-view", { hasText: "Week" }).click();
  await expect(page.locator(".cal-weekgrid")).toBeVisible();
  await page.waitForTimeout(700);
}

const writes = (page: Page) => page.evaluate(() => (window as unknown as { __calWrites?: Record<string, string>[] }).__calWrites ?? []);

async function blockBox(page: Page, id: string) {
  const block = page.locator(`.cal-block[data-cal-id="${id}"]`);
  // In the middle of the view: the sticky head covers the top of the scroller.
  await block.evaluate(one => {
    const host = document.querySelector("#calendar-body") as HTMLElement;
    host.scrollTop += one.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientHeight / 2;
  });
  await page.waitForTimeout(150);
  return (await block.boundingBox())!;
}

const columnsOf = (page: Page) => page.locator(".cal-wkcol").evaluateAll(list => list.map(one => {
  const box = one.getBoundingClientRect();
  return { x: box.x, w: box.width };
}));

test("a fast drag across days lands where the pointer ended, and saves", async ({ page }) => {
  await openWeek(page);
  const box = await blockBox(page, "f1");
  const cols = await columnsOf(page);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const from = cols.findIndex(k => x >= k.x && x < k.x + k.w);
  const to = from + 2 < cols.length ? from + 2 : from - 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 12, y + 8);
  await page.mouse.move(cols[to].x + cols[to].w / 2, y + 40);
  await page.waitForTimeout(80);
  const live = await page.evaluate(() => {
    const block = document.querySelector('.cal-block[data-cal-id="f1"]') as HTMLElement;
    return { column: [...document.querySelectorAll(".cal-wkcol")].indexOf(block.parentElement!), dragging: block.classList.contains("is-dragging") };
  });
  expect(live).toEqual({ column: to, dragging: true });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const done = await writes(page);
  expect(done).toHaveLength(1);
  expect(done[0].command).toBe("move_event");
  await expect(page.locator(".cal-block.is-dragging")).toHaveCount(0);
  const landed = await page.evaluate(() => {
    const block = document.querySelector('.cal-block[data-cal-id="f1"]') as HTMLElement;
    return [...document.querySelectorAll(".cal-wkcol")].indexOf(block.parentElement!);
  });
  expect(landed).toBe(to);
});

test("Escape calls a drag off: nothing saved, the island stays", async ({ page }) => {
  await openWeek(page);
  const box = await blockBox(page, "f1");
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const top = await page.locator('.cal-block[data-cal-id="f1"]').evaluate(one => (one as HTMLElement).style.top);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 60, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await expect(page.locator('.screen[data-screen="calendar"]')).toBeVisible();
  await expect(page.locator(".cal-block.is-dragging")).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect(await writes(page)).toEqual([]);
  expect(await page.locator('.cal-block[data-cal-id="f1"]').evaluate(one => (one as HTMLElement).style.top)).toBe(top);
});

test("the top edge moves the start and keeps the end", async ({ page }) => {
  await openWeek(page);
  const box = await blockBox(page, "f1");
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(x, box.y - 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const [one] = await writes(page);
  expect(one.command).toBe("move_event");
  expect(new Date(one.start).getHours()).toBeLessThan(14);
  expect(new Date(one.end).getHours()).toBe(15);
});

test("the bottom edge moves the end and keeps the start", async ({ page }) => {
  await openWeek(page);
  const box = await blockBox(page, "f1");
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height - 2);
  await page.mouse.down();
  await page.mouse.move(x, box.y + box.height + 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const [one] = await writes(page);
  expect(new Date(one.start).getHours()).toBe(14);
  expect(new Date(one.end).getTime()).toBeGreaterThan(new Date(one.start).getTime() + 60 * 60_000);
});

test("a drag held near the edge scrolls the grid", async ({ page }) => {
  await openWeek(page);
  const box = await blockBox(page, "f1");
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const scrolled = () => page.locator("#calendar-body").evaluate(one => one.scrollTop);
  const edge = await page.locator("#calendar-body").evaluate(one => {
    const rect = one.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, room: one.scrollHeight - one.clientHeight, at: one.scrollTop };
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  const down = edge.room - edge.at > 20;
  await page.mouse.move(x, down ? edge.bottom - 4 : edge.top + 60, { steps: 4 });
  await page.waitForTimeout(500);
  const after = await scrolled();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  if (down) expect(after).toBeGreaterThan(edge.at + 20);
  else expect(after).toBeLessThan(edge.at - 20);
});

test("clicking away closes the panel and starts nothing", async ({ page }) => {
  await openWeek(page);
  const box = await blockBox(page, "f1");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".cal-panel")).toBeVisible();
  const cols = await columnsOf(page);
  const other = cols.find(k => k.x + k.w < box.x || k.x > box.x + box.width)!;
  await page.mouse.click(other.x + other.w / 2, box.y + 3);
  await expect(page.locator(".cal-panel")).toHaveCount(0);
  await expect(page.locator(".cal-draft")).toHaveCount(0);
  await page.mouse.click(other.x + other.w / 2, box.y + 3);
  await expect(page.locator(".cal-draft")).toBeVisible();
});

test("the panel opens beside the event and edits it in place", async ({ page }) => {
  await openWeek(page);
  const box = await blockBox(page, "f1");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const sheet = page.locator(".cal-panel");
  await expect(sheet).toBeVisible();
  const at = (await sheet.boundingBox())!;
  // Beside it, not across it, and not the width of the week.
  expect(at.width).toBeLessThan(320);
  expect(at.x >= box.x + box.width || at.x + at.width <= box.x).toBe(true);

  const name = sheet.locator(".cal-panel-name");
  await expect(name).toHaveValue("Lunch with Ada");
  await name.fill("Lunch with Grace");
  await name.press("Enter");
  await page.waitForTimeout(150);
  await expect(page.locator('.cal-block[data-cal-id="f1"]')).toContainText("Lunch with Grace");

  const place = page.locator(".cal-panel .cal-panel-place");
  await expect(place).toHaveValue("Cafe Mistral");
  await place.fill("Hala Koszyki");
  await place.press("Enter");
  await page.waitForTimeout(150);

  const end = page.locator(".cal-panel .cal-panel-time").nth(1);
  await expect(end).toHaveValue("15:00");
  await end.fill("16:00");
  await end.press("Enter");
  await page.waitForTimeout(200);

  const done = await writes(page);
  expect(done.map(one => one.command)).toEqual(["update_event", "update_event", "move_event"]);
  expect(done[0].title).toBe("Lunch with Grace");
  expect(done[1].location).toBe("Hala Koszyki");
  expect(new Date(done[2].end).getTime() - new Date(done[2].start).getTime()).toBe(2 * 3600_000);
});

test("Escape closes the panel before the island", async ({ page }) => {
  await openWeek(page);
  const box = await blockBox(page, "f1");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".cal-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-panel")).toHaveCount(0);
  await expect(page.locator('.screen[data-screen="calendar"]')).toBeVisible();
});

test("overlaps sit side by side and each can be pressed", async ({ page }) => {
  await openWeek(page, "caloverlap");
  const a = await blockBox(page, "x1");
  const b = await blockBox(page, "x2");
  expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1).toBe(true);
  await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2);
  await expect(page.locator(".cal-panel .cal-panel-name")).toHaveValue("Overlap one");
  await page.keyboard.press("Escape");
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.locator(".cal-panel .cal-panel-name")).toHaveValue("Overlap two");
});

test("an all-day item opens its panel", async ({ page }) => {
  await openWeek(page, "caloverlap");
  await page.locator(".cal-chip", { hasText: "Holiday" }).first().click();
  await expect(page.locator(".cal-panel .cal-panel-name")).toHaveValue("Holiday");
  await expect(page.locator(".cal-panel .cal-panel-time")).toHaveCount(0);
});

test("the day view draws one column, and a heading goes there", async ({ page }) => {
  await openWeek(page);
  await expect(page.locator(".cal-wkcol")).toHaveCount(7);
  await page.locator(".cal-wkday").nth(2).click();
  await expect(page.locator(".cal-wkcol")).toHaveCount(1);
  await expect(page.locator('.cal-view[aria-pressed="true"]')).toHaveText("Day");
  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page.locator(".cal-wkcol")).toHaveCount(1);
  await page.locator(".cal-wkday").click();
  await expect(page.locator(".cal-wkcol")).toHaveCount(7);
});

test("a click that stays put opens, a redraw during the press doesn't lose it", async ({ page }) => {
  await openWeek(page);
  const box = await blockBox(page, "f1");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  /* A poll landing mid-press: the preview bus is reachable through a write. */
  await page.evaluate(() => (window as unknown as { __calRefresh?: () => void }).__calRefresh?.());
  await page.mouse.up();
  await expect(page.locator(".cal-panel")).toBeVisible();
  expect(await writes(page)).toEqual([]);
});
