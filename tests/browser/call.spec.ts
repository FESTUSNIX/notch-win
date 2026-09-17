import { test, expect, type Page } from "@playwright/test";

/** Hovering the pill is how the island opens; aim at the shape it reports. */
async function open(page: Page) {
  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();
}

/** The labels under the round controls, which is what a person reads. */
const labels = (page: Page) => page.locator(".call-act-say");

test("a call takes the strip's sides and leaves the clock where it was", async ({ page }) => {
  /* ⚠️ `?quiet` as well, in both. The default fixture has something playing,
   * and the player claims the strip at 40 — so without it the "before"
   * picture is a track, not a clock, and this would be comparing a call
   * against the wrong thing rather than against rest. */
  await page.goto("/tasks.html?quiet&click");
  const collapsed = page.locator("#island-collapsed");
  await expect(collapsed).toHaveAttribute("data-kind", "clock");
  /* ⚠️ The SHAPE of the resting clock, not the string it happened to show.
   * This compared the text across two page loads for a while, which fails
   * whenever the minute rolls between them — about once an hour, in a suite
   * that takes five minutes, which looks exactly like an intermittent bug in
   * the pill and is a bug in the test. */
  const looksLikeAClock = /^\d?\d:\d\d$/;
  expect((await page.locator(".pill-clock").textContent())!.trim())
    .toMatch(looksLikeAClock);

  await page.goto("/tasks.html?call&quiet&click");
  await expect(collapsed).toHaveAttribute("data-kind", "call");
  /* ⚠️ The time is still there, and still says the time. Every other claim
   * takes the strip over and puts its own words on it; a call lasts forty
   * minutes, and a notch that could not tell you the time for forty minutes
   * would be trading the thing you look at it for against a title you already
   * know. */
  expect((await page.locator(".pill-clock").textContent())!.trim())
    .toMatch(looksLikeAClock);
  /* And it is the WALL clock rather than anything the call made up: the same
   * minute the page itself is in. */
  const both = await page.evaluate(() => {
    const now = new Date();
    return {
      shown: document.querySelector(".pill-clock")!.textContent!.trim(),
      minute: `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`,
    };
  });
  expect(both.shown).toBe(both.minute);
  /* And it is in the same PLACE, not merely present: both layouts are
   * `1fr auto 1fr` so the digits do not slide sideways when a call starts. */
  const middle = await page.evaluate(() => {
    const box = document.querySelector(".pill-clock")!.getBoundingClientRect();
    const pill = document.getElementById("island-collapsed")!.getBoundingClientRect();
    return Math.round((box.left + box.width / 2) - (pill.left + pill.width / 2));
  });
  expect(Math.abs(middle)).toBeLessThanOrEqual(1);

  // Two controls, no more: the third is what turns a strip into a toolbar.
  await expect(page.locator(".pill-act")).toHaveCount(2);
  await expect(page.locator(".pill-act").first()).toHaveAttribute("aria-label", "Mute");
  await expect(page.locator(".pill-act").last()).toHaveAttribute("aria-label", "Leave");
  // The pill is still a pill: nothing opened by itself.
  await expect(page.locator("#island-expanded")).not.toBeVisible();
});

test("muting from the strip mutes, and does not open the island", async ({ page }) => {
  await page.goto("/tasks.html?call&click");
  const collapsed = page.locator("#island-collapsed");
  await expect(collapsed).not.toHaveClass(/is-muted/);

  await page.locator('.pill-act[data-act="mute"]').click();
  /* ⚠️ The muted state is on the STRIP, not only on the button. In hover mode
   * the button cannot be pointed at without opening the panel, so a mute drawn
   * only there would be a mute you cannot see — the one state that must never
   * be in doubt. */
  await expect(collapsed).toHaveClass(/is-muted/);
  await expect(page.locator('.pill-act[data-act="unmute"]')).toBeVisible();
  /* ⚠️ And the press must not reach the pill underneath. Muting must not also
   * open the island — which is exactly what you do not want to happen while
   * somebody is looking at your shared screen. */
  await expect(page.locator("#island-expanded")).not.toBeVisible();

  await page.locator('.pill-act[data-act="unmute"]').click();
  await expect(collapsed).not.toHaveClass(/is-muted/);
});

test("the panel offers what the app can really do, and nothing else", async ({ page }) => {
  await page.goto("/tasks.html?call");
  await open(page);
  /* The island is already ON the call — a call starting puts it there, so
   * opening it during one shows the call rather than wherever you left it. */
  await expect(page.locator("#island-where")).toHaveText("Call");
  await expect(labels(page)).toHaveText(["Mute", "Video", "Share", "Hand", "Open", "Leave"]);
  await expect(page.locator(".call-title")).toHaveText("Design Sync");
  // The app, and how long you have been in it. Not how many people are in it:
  // nothing on Windows will say, and a number nobody can check is worse.
  await expect(page.locator(".call-where")).toHaveText(/^Zoom · \d+:\d\d$/);

  /* ⚠️ Google Meet has no keyboard way to hang up or to share, so those are
   * ABSENT rather than greyed out — the list comes from the shortcut table in
   * Rust, and a button that does nothing is worse than no button. */
  await page.goto("/tasks.html?call=meet");
  await open(page);
  await expect(labels(page)).toHaveText(["Mute", "Video", "Hand", "Open"]);
  await expect(page.locator(".call-key.is-danger")).toHaveCount(0);
});

test("the call's stop is on the rail only while there is a call", async ({ page }) => {
  await page.goto("/tasks.html");
  await open(page);
  await expect(page.locator('.rail-stop[data-tab="call"]')).toHaveCount(0);

  await page.goto("/tasks.html?call");
  await open(page);
  await expect(page.locator('.rail-stop[data-tab="call"]')).toHaveCount(1);
});

test("a call that ends hands the island and the strip back", async ({ page }) => {
  // ⚠️ `?quiet`, so what the strip goes back to is REST rather than the
  // player taking over — see the note in the first test.
  await page.goto("/tasks.html?call&quiet");
  await open(page);
  await expect(page.locator("#island-where")).toHaveText("Call");

  await page.locator('.call-key[data-act="leave"]').click();
  /* ⚠️ The rail works out for itself that the stop has gone. What it cannot
   * handle is the call ending while you are LOOKING at it, which would leave
   * the island on a screen saying nothing with no way to tell what happened. */
  await expect(page.locator("#island-where")).toHaveText("Home");
  await expect(page.locator('.rail-stop[data-tab="call"]')).toHaveCount(0);
  // And the strip goes back to being a clock, with no controls left on it.
  await expect(page.locator("#island-collapsed")).toHaveAttribute("data-kind", "clock");
  await expect(page.locator(".pill-act")).toHaveCount(0);
});
