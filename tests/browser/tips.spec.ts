import { test, expect, type Page } from "@playwright/test";

/* Tooltips of our own, replacing the native `title`.
 *
 * ⚠️ The timing is the whole feature, so the timing is what is tested. A
 * tooltip that waits before the first one and then keeps up with the pointer
 * feels like one label following your hand; the same tooltip with either half
 * missing feels like either a lag or a strobe, and both are what `title` does. */
test.use({viewport: {width: 1400, height: 860}});

const lit = (page: Page) =>
  page.locator(".tip").evaluate(el => el.classList.contains("is-on")).catch(() => false);

test("a tip waits to appear, then keeps up", async ({page}) => {
  await page.goto("/tasks.html?agents&flat");
  const pill = (await page.locator("#island").boundingBox())!;
  await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();

  /* ⚠️ PINNED, and parked on the header. The island folds the moment the
   * pointer is off it, so there is nowhere neutral outside to wait — and the
   * header is the one part of the panel with nothing labelled in it. */
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.locator(".palette-row .palette-title")
    .filter({hasText: /^Keep the island open$/}).first().click();
  await expect(page.locator("#island-rail")).toBeVisible();

  const head = (await page.locator(".island-head").boundingBox())!;
  const park = async () => {
    await page.mouse.move(head.x + head.width - 30, head.y + head.height / 2);
    await page.waitForTimeout(900);
  };
  await park();
  expect(await lit(page)).toBe(false);

  const stops = page.locator(".rail-stop");
  const first = (await stops.nth(1).boundingBox())!;
  const other = (await stops.nth(4).boundingBox())!;

  /* ⚠️ Cold: it does NOT appear at once. Brushing along a row of nine buttons
   * on the way somewhere else must not light up four of them. */
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.waitForTimeout(150);
  expect(await lit(page)).toBe(false);

  await expect.poll(() => lit(page), {timeout: 2000}).toBe(true);
  const said = await page.locator(".tip").textContent();
  expect(said).toBeTruthy();

  /* ⚠️ Warm: moving to the next one changes it AT ONCE. This is the half that
   * makes it read as one label following the pointer rather than four tooltips
   * taking turns — and it is the half `title` has never had. */
  await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2);
  await page.waitForTimeout(70);
  expect(await lit(page)).toBe(true);
  expect(await page.locator(".tip").textContent()).not.toBe(said);

  /* ⚠️ And there is exactly ONE of them. A tooltip per control is a tooltip
   * that animates in from nothing every time it moves, which is the thing
   * being avoided. */
  await expect(page.locator(".tip")).toHaveCount(1);
});

test("nothing is left to the operating system to draw", async ({page}) => {
  await page.goto("/tasks.html?agents&flat");
  const pill = (await page.locator("#island").boundingBox())!;
  await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();

  /* ⚠️ A leftover `title` is not a harmless duplicate: the OS draws its own
   * tooltip a second later, in its own colours, over ours — so the control ends
   * up with two labels that disagree about when to appear. */
  for (const screen of ["home", "shelf", "notes", "system"]) {
    await page.locator(`.rail-stop[data-tab="${screen}"]`).click();
    await expect(page.locator(`.screen[data-screen="${screen}"]`)).toBeVisible();
    const left = await page.evaluate(() =>
      [...document.querySelectorAll("[title]")].map(el => el.getAttribute("title")));
    expect(left, `native titles on ${screen}`).toEqual([]);
  }
});
