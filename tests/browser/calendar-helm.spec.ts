import { test, expect, type Page } from "@playwright/test";

/* The calendar read and written through Helm: blocks, markers, free time, the To
 * plan rail, prep notes and quick add. `&helmcal` stages Helm's reading, at fixed
 * hours today, and every write lands in `__helmActs`. */

async function openWeek(page: Page, flags = "helmcal") {
  await page.goto(`/tasks.html?click&noagents&nofollow&${flags}`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Calendar");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Calendar$/ }).first().click();
  await expect(page.locator('.screen[data-screen="calendar"]')).toBeVisible();
  await page.locator(".cal-view", { hasText: "Week" }).click();
  await expect(page.locator(".cal-weekgrid")).toBeVisible();
  await page.waitForTimeout(700);
}

const acts = (page: Page) => page.evaluate(() => (window as unknown as { __helmActs?: Record<string, unknown>[] }).__helmActs ?? []);

async function boxOf(page: Page, id: string) {
  const block = page.locator(`.cal-block[data-cal-id="${id}"]`);
  await block.evaluate(one => {
    const host = document.querySelector("#calendar-body") as HTMLElement;
    host.scrollTop += one.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientHeight / 2;
  });
  await page.waitForTimeout(150);
  return (await block.boundingBox())!;
}

test("Helm's events, blocks and markers are on the grid", async ({ page }) => {
  await openWeek(page);
  await expect(page.locator('.cal-block[data-cal-id="prim:g1"]')).toContainText("Esono call");
  await expect(page.locator('.cal-block[data-cal-id="block:7"]')).toContainText("Repricer: import");
  await expect(page.locator(".cal-block.is-focus.is-done")).toContainText("Finished thing");
  await expect(page.locator(".cal-chip.is-marker").first()).toContainText("1 200 zł");
  await expect(page.locator(".cal-chip.is-marker").nth(1)).toContainText("Repricer");
});

test("a meeting moved on the grid goes through Helm, in minutes", async ({ page }) => {
  await openWeek(page);
  const box = await boxOf(page, "prim:g1");
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const [one] = await acts(page);
  expect(one).toMatchObject({ action: "moveEvent", calendarId: "prim", eventId: "g1", start: 12 * 60, end: 13 * 60 });
});

test("a meeting with guests can't be dragged, but opens", async ({ page }) => {
  await openWeek(page);
  const box = await boxOf(page, "prim:g3");
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await acts(page)).toEqual([]);
  await page.mouse.click(x, y);
  await expect(page.locator(".cal-panel .cal-panel-title")).toHaveText("Guests meeting");
});

test("a block resizes, up to three hours", async ({ page }) => {
  await openWeek(page);
  const box = await boxOf(page, "block:7");
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height - 2);
  await page.mouse.down();
  await page.mouse.move(x, box.y + box.height + 400, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const [one] = await acts(page);
  expect(one).toMatchObject({ action: "moveBlock", blockId: 7, start: 9 * 60, end: 12 * 60 });
});

test("a block's panel renames it and sends it back to the rail", async ({ page }) => {
  await openWeek(page);
  const box = await boxOf(page, "block:7");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const name = page.locator(".cal-panel .cal-panel-name");
  await expect(name).toHaveValue("Repricer: import");
  await name.fill("Repricer: export");
  await name.press("Enter");
  await page.waitForTimeout(250);
  await expect(page.locator('.cal-block[data-cal-id="block:7"]')).toContainText("Repricer: export");
  await page.locator(".cal-panel-open", { hasText: "Back to To plan" }).click();
  await page.waitForTimeout(250);
  await expect(page.locator('.cal-block[data-cal-id="block:7"]')).toHaveCount(0);
  const done = await acts(page);
  expect(done.map(one => one.action)).toEqual(["renameBlock", "unscheduleBlock"]);
});

test("the prep note shows, or can be written", async ({ page }) => {
  await openWeek(page);
  let box = await boxOf(page, "prim:g2");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".cal-prep")).toContainText("Close the review");
  await page.keyboard.press("Escape");
  box = await boxOf(page, "prim:g1");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".cal-prep")).toHaveCount(0);
  await page.locator(".cal-panel-open", { hasText: "Prep note" }).click();
  await expect(page.locator(".cal-prep")).toContainText("Written just now");
  const done = await acts(page);
  expect(done[0]).toMatchObject({ action: "prep", eventId: "prim:g1" });
});

test("the rail lists what isn't planned, and a drop plans it", async ({ page }) => {
  await openWeek(page);
  // On the arc, which only opens to a real hover; the press is what's being tested.
  await page.getByRole("button", { name: "Show To plan" }).dispatchEvent("click");
  await page.waitForTimeout(500);
  await expect(page.locator(".cal-plan")).toHaveCount(2);
  await expect(page.locator(".cal-plan").first()).toContainText("Fix the checkout");
  const target = await boxOf(page, "prim:g1");
  const row = (await page.locator(".cal-plan").first().boundingBox())!;
  await page.mouse.move(row.x + 30, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 10, row.y + 20, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2 + 200, target.y - 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const [one] = await acts(page);
  expect(one).toMatchObject({ action: "scheduleBlock", title: "Fix the checkout", workItemId: 5, projectId: 1 });
  expect(Number(one.end) - Number(one.start)).toBe(60);
  await expect(page.locator(".cal-plan")).toHaveCount(1);
});

test("a line in plain words is added, and says where", async ({ page }) => {
  await openWeek(page);
  const field = page.locator(".cal-quick-field");
  await field.fill("gym at 18");
  await field.press("Enter");
  await expect(page.locator('.cal-block[data-cal-id="block:200"]')).toBeVisible();
  await expect(page.locator(".cal-quick-field")).toHaveAttribute("placeholder", /Added Gym/);
  expect((await acts(page))[0]).toMatchObject({ action: "quickAdd", text: "gym at 18" });
});

test("a range drawn becomes an event, or a block with one press", async ({ page }) => {
  await openWeek(page);
  const box = await boxOf(page, "prim:g1");
  const free = page.locator(".cal-wkcol").nth(0);
  const col = (await free.boundingBox())!;
  const x = col.x + col.width / 2 === box.x + box.width / 2 ? col.x + col.width * 2 : col.x + col.width / 2;
  await page.mouse.click(x, box.y + 3);
  const draft = page.locator(".cal-draft");
  await expect(draft).toBeVisible();
  await draft.locator(".cal-draft-kind").click();
  await expect(draft.locator(".cal-draft-kind")).toHaveText("Block");
  await draft.locator("input").fill("Deep work");
  await draft.locator("input").press("Enter");
  await page.waitForTimeout(250);
  expect((await acts(page))[0]).toMatchObject({ action: "scheduleBlock", title: "Deep work" });
});

test("Helm losing Google offers its own sign-in, not the app's", async ({ page }) => {
  await openWeek(page, "helmcal=expired");
  const bar = page.locator(".cal-signin");
  await expect(bar).toContainText("Helm's calendar");
  await expect(page.locator('.cal-block[data-cal-id="block:7"]')).toBeVisible();
});

test("a write Helm refuses puts the grid back and says why", async ({ page }) => {
  await openWeek(page, "helmcal=refuse");
  const box = await boxOf(page, "prim:g1");
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const top = await page.locator('.cal-block[data-cal-id="prim:g1"]').evaluate(one => (one as HTMLElement).style.top);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".screen-error")).toContainText("Helm said no");
  expect(await page.locator('.cal-block[data-cal-id="prim:g1"]').evaluate(one => (one as HTMLElement).style.top)).toBe(top);
});

test("without Helm the app's own events still draw", async ({ page }) => {
  await openWeek(page, "calwrite");
  await expect(page.locator('.cal-block[data-cal-id="f1"]')).toBeVisible();
  await expect(page.locator(".cal-quick")).toHaveCount(0);
});
