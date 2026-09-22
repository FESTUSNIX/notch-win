import { test, expect, type Page } from "@playwright/test";

/* The timer screen: one face for three kinds, and a list of runs beside it.
 *
 * ⚠️ `?quiet` — the resting fixture. These press Start and watch a number
 * move, and a fixture with an agent waiting steers the island onto its screen
 * before any of them can begin. */
const HOME = "/tasks.html?quiet";

test.use({ viewport: { width: 1400, height: 900 } });

async function open(page: Page) {
  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Timer");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Timer$/ }).first().click();
  await expect(page.locator('.screen[data-screen="timer"]')).toBeVisible();
  await expect(page.locator(".tm-figure")).toBeVisible();
}

/** The two columns of the design frame, mirroring `TIMER_FACE` / `TIMER_LIST`
 *  in tasks.ts. ⚠️ Spelled out here rather than imported: tasks.ts is the app's
 *  entry point and importing it would run the whole shell inside the test. */
const FACE = 392;
const LIST = 275;
const RING = 200;

/** Switch to a kind by its position in the switcher. */
const kind = (page: Page, at: number) => page.locator(".tm-kind").nth(at);

test("the ring says which kind it is", async ({ page }) => {
  await page.goto(HOME);
  await open(page);

  /* ⚠️ A pomodoro is SEGMENTED — one arc per leg of the cycle — because what
   * a pomodoro is is a shape you move along. Eight legs: four work rounds and
   * the break after each. */
  await expect(page.locator(".tm-seg")).toHaveCount(8);
  await expect(page.locator(".tm-arc")).toHaveCount(0);
  /* ⚠️ "Ready", not "1 of 4". A pomodoro that has not been started is not on
   * round one — the ring is empty and the cycle has not begun, and saying it
   * has is the screen claiming credit for a round nobody worked. */
  await expect(page.locator(".tm-phase")).toHaveText("Ready");
  await page.locator(".tm-go").click();
  await expect(page.locator(".tm-phase")).toContainText("1 of 4");
  await page.locator(".tm-go").click();

  // A timer is one unbroken circle, and carries the ruler you wind it with.
  await kind(page, 1).click();
  await expect(page.locator(".tm-arc")).toHaveCount(1);
  await expect(page.locator(".tm-seg")).toHaveCount(0);
  await expect(page.locator(".tm-dial")).toBeVisible();

  // So is a stopwatch, and it has nothing to wind.
  await kind(page, 0).click();
  await expect(page.locator(".tm-arc")).toHaveCount(1);
  await expect(page.locator(".tm-dial")).toHaveCount(0);
  // ⚠️ And no phase line on either: only a pomodoro has legs to be part-way
  // through, so on the other two that line would have nothing to say.
  await expect(page.locator(".tm-phase")).toHaveCount(0);
});

test("one button starts, pauses and picks up again", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  const go = page.locator(".tm-go");
  const figure = page.locator(".tm-figure");

  /* ⚠️ ONE button whose word changes. Start, pause and resume are the same
   * press at three moments; three buttons would mean two are always wrong. */
  await expect(go).toHaveText("Start");
  await expect(figure).toHaveText("25:00");

  await go.click();
  await expect(go).toHaveText("Pause");
  // It counts. ⚠️ Polled rather than measured once: the shell ticks on its own
  // second, which does not line up with the click.
  await expect.poll(async () => figure.textContent(), { timeout: 4000 })
    .not.toBe("25:00");

  await go.click();
  await expect(go).toHaveText("Resume");
  const held = await figure.textContent();
  await page.waitForTimeout(1600);
  // ⚠️ Paused means STOPPED, not slowed: the figure must not move at all.
  await expect(figure).toHaveText(held!);
});

test("a stopwatch counts up from nothing", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await kind(page, 0).click();
  await expect(page.locator(".tm-figure")).toHaveText("00:00");
  await page.locator(".tm-go").click();
  /* ⚠️ UP. A stopwatch is not a countdown with the sign flipped — it has no
   * target, so it cannot end and there is no fraction of it to be through. */
  await expect.poll(async () => page.locator(".tm-figure").textContent(), { timeout: 4000 })
    .not.toBe("00:00");
});

test("there can be several of each, and the list holds them all", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  // One of each: switching to a kind with none makes one.
  await kind(page, 1).click();
  await kind(page, 0).click();
  // And the + makes another of whatever is on screen.
  await page.locator(".tm-add").click();

  await page.locator(".tm-foot .tm-round").nth(1).click();
  const rows = page.locator(".tm-row");
  await expect(rows).toHaveCount(4);
  // ⚠️ The one you are looking at is lit, so a list of four says which.
  await expect(page.locator(".tm-row.is-on")).toHaveCount(1);
  await expect(page.locator(".tm-row.is-on .tm-row-name")).toHaveText("Stopwatch");

  /* Pressing a row shows it. ⚠️ The whole row picks and only the button
   * controls — a row that does both depending on where you press is a row you
   * have to aim at. */
  await rows.first().locator(".tm-pick").click();
  await expect(page.locator(".tm-row").first()).toHaveClass(/is-on/);
  await expect(page.locator(".tm-kind.is-on")).toHaveText("Pomodoro");
});

test("a run can be controlled from the list without leaving the one you are on",
  async ({ page }) => {
    await page.goto(HOME);
    await open(page);
    await kind(page, 1).click();          // a timer, so there are two runs
    await page.locator(".tm-foot .tm-round").nth(1).click();

    const pom = page.locator(".tm-row").first();
    await expect(pom.locator(".tm-row-name")).toHaveText("Pomodoro");
    await pom.locator(".tm-row-go").click();

    /* ⚠️ Counting gets the WARM half of the palette, so a list of five says at
     * a glance which one is actually running. */
    await expect(pom.locator(".tm-row-go")).toHaveClass(/is-live/);
    // And the screen stayed on the timer: controlling is not selecting.
    await expect(page.locator(".tm-kind.is-on")).toHaveText("Timer");

    /* ⚠️ Every row ticks, not only the one on the face. The list is built once
     * when the panel opens, so without that a stopwatch you had just started
     * sat at 00:00 while the big figure counted. */
    await expect.poll(async () => pom.locator(".tm-row-time").textContent(),
      { timeout: 4000 }).not.toBe("25:00");
  });

test("clearing takes the lot, and leaves a way back", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await page.locator(".tm-foot .tm-round").nth(1).click();
  await page.locator(".tm-clear").click();
  /* ⚠️ A list is allowed to be empty; a SCREEN of controls with nothing to
   * control is not. What is left is the three ways to start one. */
  await expect(page.locator(".tm-empty")).toBeVisible();
  await expect(page.locator(".tm-empty-add")).toHaveCount(3);
  await page.locator(".tm-empty-add").first().click();
  await expect(page.locator(".tm-figure")).toBeVisible();
});

test("a run survives the window being reloaded", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await kind(page, 1).click();
  await page.locator(".tm-name").fill("Oven");
  await page.locator(".tm-name").blur();
  await page.locator(".tm-go").click();
  await expect(page.locator(".tm-go")).toHaveText("Pause");

  /* ⚠️ The state is an END TIME, never a remaining count — which is what lets
   * it survive a reload, the machine sleeping, and the window being closed. */
  await page.reload();
  await open(page);
  await expect(page.locator(".tm-name")).toHaveValue("Oven");
  await expect(page.locator(".tm-go")).toHaveText("Pause");
});

const wide = (page: Page) => page.evaluate(() =>
  Math.round(document.getElementById("island-expanded")!.getBoundingClientRect().width));
const boxOf = (page: Page, sel: string) => page.evaluate(s => {
  const el = document.querySelector(s) as HTMLElement;
  return el ? Math.round(el.getBoundingClientRect().width) : 0;
}, sel);

test("the list makes the ISLAND wider, it does not take the room from the face",
  async ({ page }) => {
    await page.goto(HOME);
    await open(page);
    /* ⚠️ POLLED, on the ISLAND rather than on the face. The panel is opened
     * through the palette, which is wider than this screen, so the island is
     * still springing down to its own width when the first control appears —
     * and the face cannot be used to wait for that, because the face is a fixed
     * track and reads its own width the whole way down. */
    await expect.poll(() => wide(page), { timeout: 4000 }).toBe(FACE);
    expect(await boxOf(page, ".tm-board")).toBe(FACE);

    await page.locator(".tm-foot .tm-round").nth(1).click();
    await expect(page.locator(".tm-list")).toBeVisible();

    /* ⚠️ The island grew by exactly the list's own column and the face is the
     * SAME WIDTH — `widthOf` returns a second, wider cap rather than one width
     * for both. Folded into a panel of fixed width the list took its 215px out
     * of the face, which shrank the ring and turned the ruler into a stub, and
     * that is what made it read as an add-on pinned inside the screen rather
     * than as one more column of it. */
    await expect.poll(() => wide(page), { timeout: 4000 }).toBe(FACE + LIST);
    expect(await boxOf(page, ".tm-board")).toBe(FACE);
    // And the ring did not pay for it either.
    expect(await boxOf(page, ".tm-ring")).toBe(RING);
  });

test("the ruler winds UP when it is dragged left", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await kind(page, 1).click();
  const rule = page.locator(".tm-rule");
  const figure = page.locator(".tm-figure");

  /* ⚠️ The shift is NEGATIVE — the ruler sits left of its own zero so that the
   * minute it is wound to is under the marker. It was negated a second time on
   * the way to the style, so a timer set to 25 put zero 375px to the RIGHT of
   * the mark with the rest of the ruler off the end of the fade, and every drag
   * moved the ruler away from the hand. */
  await expect(figure).toHaveText("25:00");
  await expect(rule).toHaveAttribute("style", /translate: -375px/);

  const strip = (await page.locator(".tm-strip").boundingBox())!;
  const mid = { x: strip.x + strip.width / 2, y: strip.y + strip.height / 2 };
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  // ⚠️ In steps: the gesture is read from a stream of moves, and one jump
  // dispatches one event.
  await page.mouse.move(mid.x - 5 * 15, mid.y, { steps: 10 });
  await page.mouse.up();
  await expect(figure).toHaveText("30:00");
});
