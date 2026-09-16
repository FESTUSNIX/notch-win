import { test, expect } from "@playwright/test";

/* Which screens are on the rail, and in what order.
 *
 * ⚠️ Tested in the SETTINGS window, which is where the list lives. The island
 * reads the result; it does not own it. */
test.use({viewport: {width: 900, height: 950}});

test("the screens can be reordered and switched off, except the one you land on", async ({page}) => {
  await page.goto("/task-editor.html");
  /* ⚠️ The Island pane has to be OPENED first. The window is a sidebar and a
   * stack of panes, only one of which is on screen — so every control in the
   * others is present, addressable and `hidden`, and a click on one times out
   * against a perfectly correct page. */
  await page.getByRole("tab", {name: "Island"}).click();
  const rows = page.locator(".screen-row");
  await expect(rows).toHaveCount(9);

  const order = () => rows.evaluateAll(all => all.map(r => (r as HTMLElement).dataset.screen));
  expect(await order()).toEqual([
    "home", "today", "media", "agents", "shelf", "notes", "calendar", "system", "review",
  ]);

  /* ⚠️ Home's switch is disabled, and the row says why rather than just
   * refusing. It is where the island opens and where a screen that disappears
   * sends you — hidden, neither has anywhere to land. */
  const homeBox = rows.filter({has: page.locator('[aria-label="Show Home on the rail"]')});
  await expect(homeBox.locator("input")).toBeDisabled();
  await expect(homeBox.locator("small")).toHaveText("Always on the rail");

  // Any other one comes off the rail.
  const shelf = page.locator('.screen-row[data-screen="shelf"] input');
  await expect(shelf).toBeChecked();
  /* ⚠️ `click`, not `uncheck`. The switch is a styled checkbox — the input
   * itself is painted over by its own pseudo-element — and Playwright's
   * `uncheck` waits for the input to be hittable, which it never is. */
  await shelf.click({force: true});
  await expect(shelf).not.toBeChecked();
  // ... and back on, which must not leave it listed as hidden twice.
  await shelf.click({force: true});
  await expect(shelf).toBeChecked();

  /* Reordering. ⚠️ The drop is only accepted because `dragover` calls
   * `preventDefault` — without it the platform refuses every drop and the row
   * springs back, which looks exactly like a list that cannot be reordered. */
  await page.locator('.screen-row[data-screen="review"]')
    .dragTo(page.locator('.screen-row[data-screen="today"]'));
  const moved = await order();
  expect(moved.indexOf("review")).toBeLessThan(moved.indexOf("today"));
  expect(moved).toHaveLength(9);
  expect(new Set(moved).size).toBe(9);
});

test("the rail obeys the order, drops what is hidden, and keeps what it has not heard of", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto("/tasks.html?agents&flat&order=review,notes&hide=system,calendar");
  const pill = (await page.locator("#island").boundingBox())!;
  await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await expect(page.locator("#island-rail")).toBeVisible();

  const on = await page.locator(".rail-stop").evaluateAll(all =>
    all.map(s => (s as HTMLElement).dataset.screen ?? (s as HTMLElement).dataset.tab));

  /* ⚠️ Named screens lead, in the order given — and everything the list has
   * NOT heard of keeps its built-in place behind them rather than vanishing. A
   * preferences file written before a screen existed must not hide it, which
   * is what rebuilding the rail from the saved order would do. */
  expect(on.slice(0, 2)).toEqual(["review", "notes"]);
  expect(on).toContain("home");
  expect(on).toContain("today");

  // What is switched off is not there at all.
  expect(on).not.toContain("system");
  expect(on).not.toContain("calendar");
});

test("Home cannot be hidden, whatever the preferences say", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  /* ⚠️ Not merely disabled in the settings window — refused HERE too. The
   * preferences are a file anybody can edit, and Home is where the island
   * opens and where a screen that disappears sends you: hidden, neither has
   * anywhere to land. */
  await page.goto("/tasks.html?agents&flat&hide=home,shelf");
  const pill = (await page.locator("#island").boundingBox())!;
  await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await expect(page.locator("#island-rail")).toBeVisible();

  const on = await page.locator(".rail-stop").evaluateAll(all =>
    all.map(s => (s as HTMLElement).dataset.tab));
  expect(on).toContain("home");
  expect(on).not.toContain("shelf");
});
