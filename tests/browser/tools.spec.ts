import { test, expect } from "@playwright/test";

/* The tab under the island: what the open screen can do.
 *
 * Three things have to hold or it is worse than the header row it replaced —
 * it has to be welded to the island rather than floating below it, it has to
 * follow the screen, and it has to be clickable, which on Windows means it
 * reports a mask of its own or the pointer passes straight through it. */
test("the tool tab hangs off the island and follows the screen", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  /* ⚠️ Not `?quiet`. That is the preview's RESTING state — nothing playing,
   * no calendar — and the media tab only exists while something is playing, so
   * under it the tab this is checking has no screen to change to. */
  await page.goto("/tasks.html?agents");

  const tab = page.locator("#island-tools");
  await expect(tab).toBeHidden();

  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();

  await page.locator('[data-tab="calendar"]').click();
  await expect(tab).toBeVisible();
  await expect(tab.locator(".screen-tool")).toHaveCount(2);

  /* ⚠️ Welded, not merely nearby. The tab is a SIBLING of `#island` — the
   * island is `overflow: clip` — so nothing in the layout keeps the two
   * touching; it is positioned from the island's own measured box every frame,
   * and a fault there shows up as a shape floating in the wrong place rather
   * than as an error. */
  const seam = await page.evaluate(() => {
    const island = document.getElementById("island")!.getBoundingClientRect();
    const tools = document.getElementById("island-tools")!.getBoundingClientRect();
    return {
      drop: tools.top - island.bottom,
      inside: tools.left > island.left && tools.right <= island.right + 1,
      deep: Math.round(tools.height),
    };
  });
  // Within a pixel: both boxes are laid out in fractional CSS pixels off a
  // design-pixel grid, so an exact seam is not a thing that can be asserted.
  expect(Math.abs(seam.drop)).toBeLessThanOrEqual(1);
  expect(seam.inside).toBe(true);
  expect(seam.deep).toBeGreaterThan(20);

  /* It follows the screen. Home has nothing to do, so the tab is not drawn at
   * all rather than drawn empty. */
  await page.locator('[data-tab="media"]').click();
  await expect(tab.getByRole("button", {name: "Show what is next"})).toBeVisible();
  await page.locator('[data-tab="home"]').click();
  await expect(tab).toBeHidden();

  /* ⚠️ And the header does not keep a copy. The row used to live beside the
   * pin and the close; two homes for one control is how one of them goes
   * stale. */
  await expect(page.locator("#screen-tools")).toHaveCount(0);
});

/* ⚠️ The left edge, because the tab was horizontal-only for a while and the
 * failure was silent: the tools simply were not on the screen. */
test("on a side edge the tab turns with the island", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto("/tasks.html?agents&edge=left");

  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();
  await page.locator('[data-tab="calendar"]').click();

  const tab = page.locator("#island-tools");
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute("data-edge", "left");

  const seam = await page.evaluate(() => {
    const island = document.getElementById("island")!.getBoundingClientRect();
    const tools = document.getElementById("island-tools")!.getBoundingClientRect();
    return {
      gap: tools.left - island.right,
      // Taller than it is wide: the tab runs DOWN the island's inner edge.
      upright: tools.height > tools.width,
      inside: tools.top > island.top && tools.bottom <= island.bottom + 1,
    };
  });
  expect(Math.abs(seam.gap)).toBeLessThanOrEqual(1);
  expect(seam.upright).toBe(true);
  expect(seam.inside).toBe(true);
  await page.screenshot({path: "test-results/tools-left.png"});
});
