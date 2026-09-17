import { test, expect, type Page } from "@playwright/test";

async function open(page: Page) {
  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();
}

/** Run a palette row by NAME, never Enter on whatever ranked first — the
 *  palette searches tasks too, and "pomodoro" can match one. */
async function run(page: Page, typed: string, row: string) {
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill(typed);
  await page.locator(".palette-row", { hasText: row }).first().click();
}

test("the bell is there when something is waiting, and gone when nothing is", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  /* ⚠️ Hidden at zero rather than showing a 0. A permanent bell reading
   * nothing is furniture on a line that only has room because it was empty. */
  await expect(page.locator("#head-bell")).toBeHidden();

  await page.goto("/tasks.html?notices&quiet");
  await open(page);
  await expect(page.locator("#head-bell")).toBeVisible();
  await expect(page.locator("#head-bell .head-count")).toHaveText("4");
});

test("the header counts them and never quotes them", async ({ page }) => {
  await page.goto("/tasks.html?notices&quiet");
  await open(page);
  /* ⚠️ The island is on screen all day, including while its owner is sharing
   * it — the same argument that keeps an address out of a call's title. The
   * header may say HOW MANY; the words are on a screen you have to open. */
  const header = await page.locator(".island-head").innerText();
  for (const secret of ["Marek", "PR before standup", "Norton", "Design Sync"]) {
    expect(header).not.toContain(secret);
  }
  expect(header).toContain("4");
});

test("the bell opens the notices, and the rail agrees about where you are", async ({ page }) => {
  await page.goto("/tasks.html?notices&quiet");
  await open(page);
  await page.locator("#head-bell").click();

  await expect(page.locator("#island-where")).toHaveText("Notices");
  await expect(page.locator(".notice-row")).toHaveCount(4);
  await expect(page.locator(".notice-row").first().locator(".notice-title"))
    .toHaveText("Marek Nowak");
  await expect(page.locator(".notice-row").first().locator(".notice-app")).toHaveText("Slack");
  /* ⚠️ The stop appears while you are ON the screen, the way the player's
   * does. Off the rail it stayed off while you stood on it, so the rail
   * highlighted Home and claimed you were somewhere you were not. */
  await expect(page.locator('.rail-stop[data-tab="notices"]')).toHaveAttribute("aria-selected", "true");
});

test("dismissing one takes it off the screen and out of the count", async ({ page }) => {
  await page.goto("/tasks.html?notices&quiet");
  await open(page);
  await page.locator("#head-bell").click();
  await expect(page.locator(".notice-row")).toHaveCount(4);

  await page.locator('.notice-row[data-notice="2"] .notice-shut').click({ force: true });
  await expect(page.locator(".notice-row")).toHaveCount(3);
  await expect(page.locator('.notice-row[data-notice="2"]')).toHaveCount(0);
  await expect(page.locator("#head-bell .head-count")).toHaveText("3");
});

test("clear all empties it, and the card offers the app it came from", async ({ page }) => {
  await page.goto("/tasks.html?notices&quiet");
  await open(page);
  await page.locator("#head-bell").click();

  /* \u26a0\ufe0f A button on the screen as well as on the arc. Clearing is the one
   * thing you come here to do when there are fifty of them, and a control you
   * have to reach a bare line for is one you do not know is there. */
  await expect(page.locator(".notice-count")).toHaveText("4 notifications");
  /* The quick action is OPEN THE APP, and it is named for exactly that. A
   * notification carries no way to activate itself from outside, so pressing
   * a row can open Slack and never the thread \u2014 see `notices.rs`. */
  await expect(page.locator(".notice-row").first().locator(".notice-open"))
    .toHaveAttribute("data-tip", "Open Slack");

  await page.locator(".notice-all").click();
  await expect(page.locator(".notice-row")).toHaveCount(0);
  await expect(page.locator("#head-bell")).toBeHidden();
  await expect(page.locator('[data-screen="notices"] .home-empty'))
    .toHaveText("Nothing in the notification centre.");
});

test("an empty screen says WHY it is empty", async ({ page }) => {
  /* ⚠️ "Nothing has happened" and "Windows will not let this app look" draw
   * the same empty screen and want different words — and only one of them is
   * something the reader can do anything about. */
  await page.goto("/tasks.html?notices=denied&quiet");
  await open(page);
  await run(page, "Notices", "Notices");
  await expect(page.locator("#island-where")).toHaveText("Notices");
  /* ⚠️ Scoped to the screen. Six screens draw an empty line with this class —
   * Home, Call, Agents, Shelf, System — and a bare selector matches all of
   * them, which Playwright refuses rather than guessing. */
  await expect(page.locator('[data-screen="notices"] .home-empty'))
    .toHaveText("Windows will not let Codenotch read notifications.");
  // And with nothing waiting there is no bell to press.
  await expect(page.locator("#head-bell")).toBeHidden();
});

test("the timer chip is always there, and it opens the screen", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  /* \u26a0\ufe0f Visible with NOTHING running. Hidden when idle it was a control with
   * no way in: the only way to start a pomodoro was to know the palette
   * command, and a feature you have to be told about is one nobody uses. */
  const chip = page.locator("#head-timer");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveClass(/is-idle/);
  await expect(chip.locator(".head-text")).toHaveText("");

  await chip.click();
  await expect(page.locator("#island-where")).toHaveText("Timer");
  await expect(page.locator(".timer-say")).toHaveText("Nothing running");
  // Every preset is a real countdown, and the lead button is the pomodoro.
  await expect(page.locator(".timer-preset")).toHaveCount(5);
  await expect(page.locator(".timer-key.is-lead")).toContainText("pomodoro");
});

test("the screen starts it, pauses it and stops it", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  await page.locator(".timer-key.is-lead").click();

  const chip = page.locator("#head-timer");
  await expect(chip).toHaveAttribute("data-phase", "work");
  await expect(chip).not.toHaveClass(/is-idle/);
  await expect(chip.locator(".head-text")).toHaveText(/^2[45]:\d\d$/);
  await expect(page.locator(".timer-clock")).toHaveText(/^2[45]:\d\d$/);
  await expect(page.locator(".timer-say")).toHaveText("Focus");

  // It is really counting, not sitting there.
  const first = await page.locator(".timer-clock").textContent();
  await expect.poll(async () => page.locator(".timer-clock").textContent()).not.toBe(first);

  await page.locator('.timer-key:has-text("Pause")').click();
  await expect(page.locator(".timer-say")).toHaveText("Focus \u00b7 paused");
  await expect(chip).toHaveClass(/is-held/);
  const held = await page.locator(".timer-clock").textContent();
  await page.waitForTimeout(1200);
  await expect(page.locator(".timer-clock")).toHaveText(held!);

  await page.locator('.timer-key:has-text("Stop")').click();
  await expect(page.locator(".timer-say")).toHaveText("Nothing running");
  await expect(chip).toHaveClass(/is-idle/);
});

test("a plain timer is one press, and it is not a pomodoro", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  await page.locator('.timer-preset:has-text("10m")').click();
  await expect(page.locator(".timer-clock")).toHaveText(/^(10:00|09:5\d)$/);
  /* \u26a0\ufe0f "Timer", not "Focus": a plain countdown has nothing after it, and
   * calling it a pomodoro would promise a break that never comes. */
  await expect(page.locator(".timer-say")).toHaveText("Timer");
  await expect(page.locator("#head-timer")).toHaveAttribute("data-phase", "plain");
});

test("a running countdown says so on the collapsed pill", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  await page.locator('.timer-preset:has-text("15m")').click();

  /* Off the island, so it folds. \u26a0\ufe0f The whole point of the claim: the
   * countdown has to be readable with the panel shut, which is how it spends
   * almost all of its fifteen minutes. */
  await page.mouse.move(10, 700);
  await expect(page.locator("#island-expanded")).not.toBeVisible();
  const pill = page.locator("#island-collapsed");
  await expect(pill).toHaveAttribute("data-kind", "focus");
  await expect(pill.locator(".pill-label")).toHaveText("Timer");
  await expect(pill.locator(".pill-value")).toHaveText(/^\d?\d:\d\d$/);
});
