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

test("a pomodoro runs in the header, and the press pauses it", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await expect(page.locator("#head-timer")).toBeHidden();

  await run(page, "pomodoro", "Start a pomodoro");
  await open(page);
  const chip = page.locator("#head-timer");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-phase", "work");
  // 25 minutes, counting down rather than sitting there.
  await expect(chip.locator(".head-text")).toHaveText(/^2[45]:\d\d$/);
  const first = await chip.locator(".head-text").textContent();
  await expect.poll(async () => chip.locator(".head-text").textContent()).not.toBe(first);

  /* ⚠️ The press PAUSES; stopping is in the palette. A countdown you cannot
   * get back does not belong under the same press that pauses it. */
  await chip.click();
  await expect(chip).toHaveClass(/is-held/);
  const held = await chip.locator(".head-text").textContent();
  await page.waitForTimeout(1200);
  await expect(chip.locator(".head-text")).toHaveText(held!);

  await chip.click();
  await expect(chip).not.toHaveClass(/is-held/);

  // And the palette is where it can be stopped outright.
  await run(page, "stop", "Stop the focus");
  await open(page);
  await expect(page.locator("#head-timer")).toBeHidden();
});
