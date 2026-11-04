import { test, expect, type Page } from "@playwright/test";

/* Gabi in the notch (4 Nov): gabi-feed.ts, the real island, staged with
 * `&gabi=reaction,note,photo,penalty,bonus,lock` (the preview's `gabi:notes`).
 * What the buttons asked for is read back from `window.__helmCalls`. */

async function calls(page: Page, command: string) {
  return page.evaluate(name => (window as unknown as { __helmCalls: { command: string; args: Record<string, unknown> }[] })
    .__helmCalls.filter(one => one.command === name).map(one => one.args), command);
}

async function picture(page: Page, name: string, margin = 90) {
  await page.waitForTimeout(700);
  const box = await page.locator("#island").boundingBox();
  if (!box) return;
  const dir = process.env.MOMENT_SHOTS ?? "test-results";
  await page.screenshot({ path: `${dir}/gabi-${name}.png`, clip: { x: Math.max(0, box.x - margin), y: 0, width: box.width + 2 * margin, height: box.y + box.height + 24 } });
}

const moment = (page: Page) => page.locator("#island-moment");
const pill = (page: Page) => page.locator("#island-collapsed");
const heart = (page: Page) => page.locator(".island-heart");
// Click mode (his, and the only one where a tap on the pill reaches it): hover mode opens the panel under the pointer.
const base = "/tasks.html?click&noagents&nocal";

test("a reaction plays over the screen, says so in the pill, and is seen", async ({ page }) => {
  await page.goto(`${base}&gabi=reaction`);
  await expect(pill(page)).toHaveAttribute("data-kind", "peek", { timeout: 6000 });
  await expect(pill(page)).toContainText("Serduszka");
  await expect(pill(page)).toHaveAttribute("data-tone", "gabi");
  await expect(moment(page)).toBeHidden();
  await picture(page, "reaction");
  const played = await calls(page, "gabi_fun");
  expect(played.length).toBe(1);
  expect(played[0]).toMatchObject({ fun: "hearts", count: 2, edge: "top" });
  expect(Number(played[0].x)).toBeGreaterThan(0);
  expect((await calls(page, "gabi_answer")).map(a => a.reply)).toEqual([null, null]);
});

test("a tap on the reaction sends a heart back", async ({ page }) => {
  await page.goto(`${base}&gabi=reaction`);
  await expect(pill(page)).toHaveAttribute("data-kind", "peek", { timeout: 6000 });
  await pill(page).click();
  await expect.poll(async () => (await calls(page, "gabi_answer")).filter(a => a.reply === "❤️").length).toBe(1);
  await expect(page.locator("#island-expanded")).toBeHidden();
});

test("a penalty borrows the pill with no buttons, a bonus throws confetti", async ({ page }) => {
  await page.goto(`${base}&gabi=penalty`);
  await expect(pill(page)).toContainText("−50 zł · Gabi", { timeout: 6000 });
  await expect(pill(page)).toHaveAttribute("data-tone", "hot");
  await expect(pill(page).locator(".pill-peek-act")).toHaveCount(0);
  await picture(page, "penalty");
  expect(await calls(page, "gabi_fun")).toEqual([]);

  await page.goto(`${base}&gabi=bonus`);
  await expect(pill(page)).toContainText("+100 zł · Gabi", { timeout: 6000 });
  expect((await calls(page, "gabi_fun"))[0]).toMatchObject({ fun: "confetti" });
});

test("a note opens the island; a chip answers it and it's gone", async ({ page }) => {
  await page.goto(`${base}&gabi=note`);
  await expect(moment(page)).toBeVisible({ timeout: 6000 });
  await expect(moment(page)).toHaveAttribute("data-kind", "gabi");
  await expect(moment(page).locator(".m-title")).toHaveText("Gabi");
  await expect(moment(page).locator(".m-line")).toContainText("dumna");
  await expect(moment(page).locator(".m-close")).toBeVisible();
  await expect(heart(page)).toBeHidden();
  await picture(page, "note");
  await moment(page).locator(".m-chip", { hasText: "Dzięki" }).click();
  await expect(moment(page)).toBeHidden();
  expect(await calls(page, "gabi_answer")).toEqual([{ id: 11, reply: "Dzięki! 😘", photo: null }]);
  await expect(heart(page)).toBeHidden();
  await expect(pill(page)).toContainText("Wysłane");
});

test("left alone it folds to the heart beside the notch, which brings it back", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${base}&gabi=note`);
  await expect(moment(page)).toBeVisible({ timeout: 6000 });
  await page.mouse.move(5, 700);
  // Real time: a faked clock makes the quiet reading look stale, which only holds it.
  await page.waitForTimeout(9000);
  await expect(moment(page)).toBeVisible();
  await expect(moment(page)).toBeHidden({ timeout: 8000 });
  await expect(heart(page)).toBeVisible();
  // Seen is what tells her: folding says nothing.
  expect(await calls(page, "gabi_answer")).toEqual([]);
  // It sits off the notch's start, level with its free edge, and is a real thing to press.
  const h = (await heart(page).boundingBox())!, island = (await page.locator("#island").boundingBox())!;
  expect(h.x + h.width).toBeLessThan(island.x + island.width / 2);
  await picture(page, "heart");
  await heart(page).click();
  await expect(moment(page)).toBeVisible();
  await expect(heart(page)).toBeHidden();
  // × says it was seen, and nothing stays.
  await moment(page).locator(".m-close").click();
  await expect(moment(page)).toBeHidden();
  expect(await calls(page, "gabi_answer")).toEqual([{ id: 11, reply: null, photo: null }]);
  await expect(heart(page)).toBeHidden();
});

test("Odpisz types an answer in place, and the island asks for the keyboard and gives it back", async ({ page }) => {
  await page.goto(`${base}&gabi=note`);
  await expect(moment(page)).toBeVisible({ timeout: 6000 });
  await moment(page).locator(".m-btn", { hasText: "Odpisz" }).click();
  const field = moment(page).locator(".m-reply");
  await expect(field).toBeFocused();
  await expect(page.locator("#island-expanded")).toBeHidden();
  expect(await calls(page, "set_task_input")).toEqual([{ active: true }]);
  // The island stays open under the field: typing must not count as busy.
  await page.waitForTimeout(1200);
  expect((await page.locator("#island").boundingBox())!.height).toBeGreaterThan(90);
  await page.keyboard.type("Już");
  await picture(page, "write");
  await field.fill("");
  // Escape puts the buttons back and doesn't close her note.
  await page.keyboard.press("Escape");
  await expect(field).toBeHidden();
  await expect(moment(page).locator(".m-chip").first()).toBeVisible();
  await expect(moment(page)).toBeVisible();
  await moment(page).locator(".m-btn", { hasText: "Odpisz" }).click();
  await moment(page).locator(".m-reply").fill("Już idę");
  await page.keyboard.press("Enter");
  await expect(moment(page)).toBeHidden();
  expect(await calls(page, "gabi_answer")).toEqual([{ id: 11, reply: "Już idę", photo: null }]);
  expect((await calls(page, "set_task_input")).at(-1)).toEqual({ active: false });
});

test("a photo: a thumbnail first, then the picture, a size up on a click, and answering marks it seen", async ({ page }) => {
  await page.goto(`${base}&gabi=photo`);
  await expect(pill(page).locator(".pill-art")).toBeVisible({ timeout: 6000 });
  await expect(moment(page)).toBeVisible({ timeout: 4000 });
  await expect(moment(page).locator(".m-photo")).toBeVisible();
  await picture(page, "photo");
  const small = (await moment(page).locator(".m-photo").boundingBox())!;
  const shallow = (await page.locator("#island").boundingBox())!;
  await moment(page).locator(".m-photo").click();
  await page.waitForTimeout(700);
  const big = (await moment(page).locator(".m-photo").boundingBox())!;
  const deep = (await page.locator("#island").boundingBox())!;
  expect(big.width).toBeGreaterThan(small.width * 1.8);
  expect(deep.height).toBeGreaterThan(shallow.height + 80);
  // ...and the whole picture is inside the island.
  expect(big.y + big.height).toBeLessThanOrEqual(deep.y + deep.height);
  await picture(page, "photo-big");
  await moment(page).locator(".m-chip").first().click();
  await expect(moment(page)).toBeHidden();
  expect(await calls(page, "gabi_answer")).toEqual([{ id: 12, reply: "❤️", photo: 77 }]);
});

test("the reactions themselves: out of the notch, on any edge, and they clean up after themselves", async ({ page }) => {
  await page.goto("/fun.html");
  await page.evaluate(() => { document.documentElement.style.background = "#1a2329"; document.body.style.background = "#1a2329"; });
  const dir = process.env.MOMENT_SHOTS ?? "test-results";
  const play = (fun: string, count: number, edge: string) => page.evaluate(
    ([f, c, e]) => { (window as unknown as { __done: Promise<unknown>; __fun: (f: string, c: number, e: string) => Promise<unknown> }).__done = (window as unknown as { __fun: (f: string, c: number, e: string) => Promise<unknown> }).__fun(f as string, c as number, e as string); },
    [fun, count, edge] as const,
  );
  const finish = () => page.evaluate(() => (window as unknown as { __done: Promise<unknown> }).__done);
  for (const fun of ["hearts", "confetti", "hug", "stars", "coffee"]) {
    await play(fun, 1, "top");
    await page.waitForTimeout(1000);
    expect(await page.locator("#fun > *").count()).toBeGreaterThan(0);
    await page.screenshot({ path: `${dir}/gabi-fun-${fun}.png` });
    await finish();
    expect(await page.locator("#fun > *").count()).toBe(0);
  }
  // More in a row, more in the air.
  await play("hearts", 1, "top");
  const one = await page.locator("#fun > *").count();
  await finish();
  await play("hearts", 5, "left");
  expect(await page.locator("#fun > *").count()).toBeGreaterThan(one * 2);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${dir}/gabi-fun-left.png` });
  await finish();
});

test("in a call nothing of hers shows; it plays when the call ends", async ({ page }) => {
  await page.goto(`${base}&gabi=note,reaction,penalty&call`);
  await page.waitForTimeout(4000);
  await expect(moment(page)).toBeHidden();
  await expect(pill(page)).not.toContainText("Serduszka");
  expect(await calls(page, "gabi_fun")).toEqual([]);
  expect(await calls(page, "gabi_answer")).toEqual([]);
});
