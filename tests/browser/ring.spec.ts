import { test, expect, type Page } from "@playwright/test";

/* The ring is its own window and its own page, so it is driven directly.
 * ⚠️ The viewport must be the window's real size — the geometry is in absolute
 * pixels against a 420 square, not in percentages, so a different viewport
 * would be testing a ring that does not exist. */
test.use({ viewport: { width: 420, height: 420 } });

const MIDDLE = 210;

/** Aim at the middle of segment `index` of `count`, the way a hand would. */
async function aim(page: Page, index: number, count: number, radius = 97) {
  const turn = index / count;
  const angle = (turn - 0.25) * Math.PI * 2;
  await page.mouse.move(MIDDLE + Math.cos(angle) * radius, MIDDLE + Math.sin(angle) * radius);
}

const lit = (page: Page) => page.locator(".ring-wedge.is-at");

test("the ring is every screen at a direction, with the palette in the middle", async ({ page }) => {
  await page.goto("/ring.html");
  await expect(page.locator(".ring-wedge")).toHaveCount(8);
  // ⚠️ Eight at most: past that a segment is thinner than the hand is accurate.
  await expect(page.locator(".ring-heart-say")).toHaveText("Search");
  // Straight up is Home, which is what a hand finds without looking.
  await expect(page.locator('.ring-wedge[data-screen="home"]')).toHaveCount(1);
  await aim(page, 0, 8);
  await expect(lit(page)).toHaveAttribute("data-screen", "home");
});

test("aiming follows the ANGLE, including over the labels", async ({ page }) => {
  await page.goto("/ring.html");
  const names = await page.locator(".ring-wedge").evaluateAll(
    all => all.map(one => (one as HTMLElement).dataset.screen));

  for (let index = 0; index < names.length; index++) {
    await aim(page, index, names.length);
    await expect(lit(page)).toHaveAttribute("data-screen", names[index]!);
  }

  /* ⚠️ Out where the LABEL is drawn, which is on top of its own wedge. Hit
   * testing the element under the pointer would report the text and light
   * nothing — a menu that goes dead where its own labels are. */
  await aim(page, 2, names.length, 152);
  await expect(lit(page)).toHaveAttribute("data-screen", names[2]!);
});

test("the middle lights the search, and the corners light nothing", async ({ page }) => {
  await page.goto("/ring.html");
  await page.mouse.move(MIDDLE, MIDDLE);
  await expect(page.locator(".ring-heart")).toHaveClass(/is-at/);
  await expect(lit(page)).toHaveCount(0);

  /* The window is a square holding a circle, so its corner is part of it —
   * and aiming there means "put this away", not "the nearest screen to my
   * mistake". */
  await page.mouse.move(6, 6);
  await expect(lit(page)).toHaveCount(0);
  await expect(page.locator(".ring-heart")).not.toHaveClass(/is-at/);
});

test("nothing is loud until it is aimed at", async ({ page }) => {
  await page.goto("/ring.html");
  await page.mouse.move(6, 6);
  /* ⚠️ The first version mixed each wedge's own colour into its fill, which on
   * the default accent made a ring of eight green slices — eight things all
   * saying "here", which is the same as none of them saying it. Every wedge is
   * the same dark until the pointer picks one. */
  const fills = await page.locator(".ring-wedge").evaluateAll(
    all => all.map(one => getComputedStyle(one).fill));
  expect(new Set(fills).size).toBe(1);

  await aim(page, 3, 8);
  const after = await page.locator(".ring-wedge").evaluateAll(
    all => all.map(one => getComputedStyle(one).fill));
  expect(new Set(after).size).toBe(2);
});
