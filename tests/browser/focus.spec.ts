import { test, expect, type Page } from "@playwright/test";

/** Go to a screen.
 *
 * ⚠️ Through the palette rather than by pressing the stop on the rail. The
 * rail shows five of the nine and CLIPS the rest, so pressing one by name works
 * for whatever happens to be near the middle and silently does not for the
 * others — which would make these tests pass or fail on where the previous one
 * left the rail. Pressing a stop is the rail's own business and has a spec of
 * its own. */
const SCREENS: Record<string, string> = {
  home: "Home", today: "Today", media: "Playing", agents: "Agents",
  shelf: "Shelf", notes: "Notes", calendar: "Calendar", system: "System",
  review: "Review",
};
async function goTo(page: Page, screen: string) {
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill(SCREENS[screen]);
  /* ⚠️ The row by NAME, not Enter on whatever ranked first. The palette
   * searches tasks and sessions as well as screens, so "Home" can rank a task
   * above the screen depending on the fixture — and then the test fails with
   * the island sitting on some other screen entirely, which reads as the
   * feature being broken rather than the helper being sloppy. */
  await page.locator(".palette-row .palette-title")
    .filter({hasText: new RegExp(`^${SCREENS[screen]}$`)}).first().click();
  /* ⚠️ Waits on the SCREEN, not on the rail. The rail is the thing under
   * test in its own spec; here it is only the road, and asserting on it makes
   * every one of these fail for a reason that has nothing to do with them. */
  await expect(page.locator(`.screen[data-screen="${screen}"]`)).toBeVisible();
  /* ⚠️ And waits for the island to STOP. Going through the palette narrows
   * the panel and hands the width back, so for half a second afterwards every
   * measurement of the island is of a shape on its way somewhere — which shows
   * up as a test comparing two heights and finding the later one smaller. */
  let last = -1;
  await expect.poll(async () => {
    const now = await page.locator("#island").evaluate(el =>
      Math.round(el.getBoundingClientRect().height));
    const same = now === last;
    last = now;
    return same;
  }, {timeout: 5000}).toBe(true);
}

test("a focus session survives a reload and takes over the collapsed island", async ({page}) => {
  await page.clock.install({time: new Date("2026-09-08T10:00:00Z")});
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto("/tasks.html?single&quiet");

  const open = async () => {
    const pill = await page.locator("#island").boundingBox();
    await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
    await expect(page.locator("#island-expanded")).toBeVisible();
  };
  // The island opens on Home; the focus controls live on the day screen, and
  // the header controls the edge loop uses are on every screen.
  const openToday = async () => {
    await open();
    await goTo(page, "today");
    await expect(page.locator("#inline-composer")).toBeVisible();
  };
  await openToday();

  await page.getByRole("button", {name: "Focus Get outside for a walk", exact: true}).click();
  await expect(page.locator("#focus-task-title")).toHaveText("Get outside for a walk");
  await expect(page.locator("#task-list")).toBeHidden();

  await page.clock.fastForward(65_000);
  await expect(page.locator("#focus-elapsed")).toHaveText("01:05");
  await page.getByRole("button", {name: "Pause focus timer", exact: true}).click();
  await page.clock.fastForward(60_000);
  await expect(page.locator("#focus-elapsed")).toHaveText("01:05");

  await page.reload();
  await openToday();
  await expect(page.locator("#focus-elapsed")).toHaveText("01:05");
  await page.getByRole("button", {name: "Resume focus timer", exact: true}).click();
  await page.clock.fastForward(1_500_000);
  await expect(page.locator("#focus-state")).toContainText("25 minutes reached");
  await expect(page.locator("#focus-pause svg")).toHaveCount(1);
  await page.screenshot({path: "test-results/focus-panel.png"});

  // Collapsed, a running timer outranks the day: the pill names the task and
  // counts, on every edge, without a second control of its own.
  /* ⚠️ One load per edge, with the pointer parked in the middle of the screen.
     The island's own edge control is gone — it lives in the settings window,
     which is a different page and cannot reach this one in the preview — so
     the edge is staged from the query string. The timer is read back from disk
     on every load, which is the same thing this test opened by proving. */
  for (const edge of ["left", "top", "bottom", "right"]) {
    await page.goto(`/tasks.html?single&quiet&edge=${edge}`);
    await page.mouse.move(450, 350);
    await expect(page.locator("#island-expanded")).toBeHidden();
    const vertical = edge === "left" || edge === "right";
    if (vertical) {
      // 35px across: the ring carries it, the words wait for the panel.
      await expect(page.locator(".pill-copy")).toBeHidden();
      await expect(page.locator(".pill-lead")).toBeVisible();
    } else {
      await expect(page.locator(".pill-label")).toHaveText("Get outside for a walk");
      await expect(page.locator(".pill-value")).toHaveText(/^\d+:\d{2}$/);
    }
    await expect.poll(() => page.locator("#island").evaluate(el => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll("#island-collapsed *")].every(child => {
        const r = child.getBoundingClientRect();
        return !r.width || (r.left >= box.left - 1 && r.right <= box.right + 1
          && r.top >= box.top - 1 && r.bottom <= box.bottom + 1);
      });
    })).toBe(true);
    await page.screenshot({path: `test-results/focus-${edge}.png`});
  }

  await openToday();
  await page.getByRole("button", {name: "End focus session", exact: true}).click();
  await expect(page.locator("#focus-session")).toBeHidden();
  await expect(page.locator("#task-list")).toBeVisible();
  // Back to the clock once nothing is running.
  await expect(page.locator("#island-collapsed")).toHaveAttribute("data-kind", "clock");
});
