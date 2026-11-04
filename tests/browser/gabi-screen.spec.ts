import { test, expect, type Page } from "@playwright/test";

/* Gabi's screen: `&gabithread` stages the thread, and what's sent lands in `__gabiSent`. */

async function openGabi(page: Page, flags = "") {
  await page.goto(`/tasks.html?click&noagents&nofollow&helm&gabithread&${flags}`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Gabi");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Gabi$/ }).first().click();
  await expect(page.locator('.screen[data-screen="gabi"]')).toBeVisible();
  await page.waitForTimeout(500);
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as { __gabiSent?: Record<string, unknown>[] }).__gabiSent ?? []);

test("the conversation reads back, hers and his on their own sides", async ({ page }) => {
  await openGabi(page);
  await expect(page.locator(".gabi-note.is-hers").first()).toContainText("Dasz radę");
  await expect(page.locator(".gabi-note.is-mine").first()).toContainText("Dzięki");
  await expect(page.locator(".gabi-event")).toContainText("−50 zł");
  await expect(page.locator(".gabi-day").last()).toHaveText("Dziś");
  const thread = page.locator(".gabi-thread");
  // Opens on the newest.
  expect(await thread.evaluate(one => one.scrollHeight - one.scrollTop - one.clientHeight)).toBeLessThan(4);
});

test("opening it tells her what was seen, once", async ({ page }) => {
  await openGabi(page);
  await expect.poll(() => sent(page)).toContainEqual(expect.objectContaining({ seen: [33] }));
  await page.waitForTimeout(300);
  expect((await sent(page)).filter(one => "seen" in one && (one.seen as number[]).length)).toHaveLength(1);
});

test("a typed answer goes to her and shows at once", async ({ page }) => {
  await openGabi(page);
  const field = page.locator(".gabi-composer textarea");
  await field.fill("Już kończę");
  await field.press("Enter");
  await expect(page.locator(".gabi-note.is-mine").last()).toContainText("Już kończę");
  await expect(field).toHaveValue("");
  await expect.poll(() => sent(page)).toContainEqual(expect.objectContaining({ text: "Już kończę", replyTo: 33 }));
});

test("the quick answers are there while she's waiting, and go when pressed", async ({ page }) => {
  await openGabi(page);
  await page.locator(".gabi-reply").first().click();
  await expect.poll(() => sent(page)).toContainEqual(expect.objectContaining({ text: "❤️", replyTo: 33 }));
  await expect(page.locator(".gabi-quick")).toBeHidden();
});

test("a surprise goes by itself", async ({ page }) => {
  await openGabi(page);
  await page.locator(".gabi-surprise").nth(1).click();
  await expect.poll(() => sent(page)).toContainEqual(expect.objectContaining({ fun: "confetti", text: null }));
  await expect(page.locator(".gabi-note.is-mine.is-reaction").last()).toContainText("🎉");
});

test("what doesn't reach her comes back to the field", async ({ page }) => {
  await openGabi(page, "gabisend=fail");
  const field = page.locator(".gabi-composer textarea");
  await field.fill("Nie dojdzie");
  await field.press("Enter");
  await expect(field).toHaveValue("Nie dojdzie");
  await expect(page.locator(".gabi-note.is-mine", { hasText: "Nie dojdzie" })).toHaveCount(0);
});

test("the fund, her lock and the day's photos are beside it", async ({ page }) => {
  await openGabi(page);
  await expect(page.locator(".gabi-fund")).toHaveText("1 240 zł");
  await expect(page.locator(".gabi-fact.is-lock")).toContainText("Blokada");
  await expect(page.locator(".gabi-photo")).toHaveCount(1);
  await page.locator(".gabi-photo").click();
  await expect(page.locator(".gabi-viewer img")).toBeVisible();
  await expect(page.locator(".gabi-viewer")).toContainText("Obiad czeka");
  await page.keyboard.press("Escape");
  await expect(page.locator(".gabi-viewer")).toBeHidden();
  // Escape took the picture, not the island.
  await expect(page.locator('.screen[data-screen="gabi"]')).toBeVisible();
});

test("what's being typed survives a new reading", async ({ page }) => {
  await openGabi(page);
  const field = page.locator(".gabi-composer textarea");
  await field.fill("W połowie");
  await page.evaluate(() => (window as unknown as { __gabiNew: () => void }).__gabiNew());
  await page.waitForTimeout(500);
  await expect(field).toHaveValue("W połowie");
});

test("no companion, no stop on the rail", async ({ page }) => {
  await page.goto(`/tasks.html?click&noagents&nofollow&helm`);
  await page.waitForTimeout(500);
  await expect(page.locator('.island-tab[data-screen="gabi"], [role="tab"][aria-label="Gabi"]')).toHaveCount(0);
});

test("pressing her fund note opens her screen", async ({ page }) => {
  await page.goto("/tasks.html?click&noagents&nocal&helm&gabithread&gabi=penalty");
  await expect(page.locator("#island-collapsed")).toContainText("−50 zł", { timeout: 6000 });
  await page.locator("#island-collapsed").click();
  await expect(page.locator('.screen[data-screen="gabi"]')).toBeVisible();
});
