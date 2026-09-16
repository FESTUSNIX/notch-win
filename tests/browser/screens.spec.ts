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
  await expect(rows).toHaveCount(10);

  const order = () => rows.evaluateAll(all => all.map(r => (r as HTMLElement).dataset.screen));
  expect(await order()).toEqual([
    "home", "call", "today", "media", "agents", "shelf", "notes", "calendar", "system", "review",
  ]);

  /* ⚠️ Home's switch is disabled, and the row says why rather than just
   * refusing. It is where the island opens and where a screen that disappears
   * sends you — hidden, neither has anywhere to land. */
  const homeBox = rows.filter({has: page.locator('[aria-label="Show Home on the rail"]')});
  /* ⚠️ `input.switch`, not `input`. Every row also carries a colour swatch,
   * which is an input too — a bare `input` matches both and the assertion reads
   * whichever came first. */
  await expect(homeBox.locator("input.switch")).toBeDisabled();
  await expect(homeBox.locator("small")).toHaveText("Always on the rail");

  // Any other one comes off the rail.
  const shelf = page.locator('.screen-row[data-screen="shelf"] input.switch');
  await expect(shelf).toBeChecked();
  /* ⚠️ `click`, not `uncheck`. The switch is a styled checkbox — the input
   * itself is painted over by its own pseudo-element — and Playwright's
   * `uncheck` waits for the input to be hittable, which it never is. */
  await shelf.click({force: true});
  await expect(shelf).not.toBeChecked();
  // ... and back on, which must not leave it listed as hidden twice.
  await shelf.click({force: true});
  await expect(shelf).toBeChecked();

  /* Reordering, with the POINTER. ⚠️ Not `dragTo`, which drives HTML5 drag and
   * drop — that works in a browser and not in the app at all, because Tauri
   * intercepts drag events at the window to implement file drop. Testing it
   * the platform's way would have passed on a feature that never worked. */
  const grab = (await page.locator('.screen-row[data-screen="review"]').boundingBox())!;
  const drop = (await page.locator('.screen-row[data-screen="today"]').boundingBox())!;
  await page.mouse.move(grab.x + 30, grab.y + grab.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const y = grab.y + grab.height / 2
      + (drop.y + drop.height / 2 - (grab.y + grab.height / 2)) * (i / 8);
    await page.mouse.move(grab.x + 30, y);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  const moved = await order();
  expect(moved.indexOf("review")).toBeLessThan(moved.indexOf("today"));
  expect(moved).toHaveLength(10);
  expect(new Set(moved).size).toBe(10);
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

test("a screen can have its own colour, and the one you are on wears it", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  const tint = encodeURIComponent("today:#ff8a3d,shelf:#4db4ff");
  await page.goto(`/tasks.html?agents&flat&tint=${tint}`);
  const pill = (await page.locator("#island").boundingBox())!;
  await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await expect(page.locator("#island-rail")).toBeVisible();

  /* ⚠️ The selection used to be a slightly lighter grey disc among grey
   * discs, which is not a selection — it is the same thing very slightly more
   * so, and on a row of nine it takes a second look to find. */
  await page.locator('.rail-stop[data-tab="today"]').click();
  await expect.poll(() => page.locator(".rail-stop.is-here").getAttribute("data-tab"))
    .toBe("today");

  const worn = await page.locator('.rail-stop[data-tab="today"]').evaluate(el => ({
    stop: getComputedStyle(el).getPropertyValue("--stop").trim(),
    ring: getComputedStyle(el).boxShadow,
  }));
  expect(worn.stop).toBe("#ff8a3d");
  // Orange, in whatever notation the engine reports it.
  expect(worn.ring).toMatch(/1 0\.5|255, ?138|ff8a3d/i);

  /* ⚠️ A screen nobody has coloured falls through to the ACCENT rather than
   * to a palette entry somebody has to maintain alongside the screens — which
   * is why the stored map is partial on purpose. */
  const plain = await page.locator('.rail-stop[data-tab="agents"]')
    .evaluate(el => getComputedStyle(el).getPropertyValue("--stop").trim());
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(plain).toBe(accent);
});
