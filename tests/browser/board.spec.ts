import { test, expect, type Page } from "@playwright/test";
import { WIDGETS } from "../../src/widgets";

/* Arranging a board by hand.
 *
 * ⚠️ These have to be BROWSER tests. Every one of them is a pointer gesture
 * measured against real boxes — where a card lands, what the row does as the
 * pointer crosses a midpoint — and none of that exists in jsdom, which has no
 * layout at all and reports every rect as zero.
 *
 * ⚠️ `?agents` rather than `?quiet`: the preview's resting state has nothing
 * playing, and the Now playing card is then one line of text rather than a card
 * with a width worth aiming at. */
const HOME = "/tasks.html?agents";

test.use({ viewport: { width: 1280, height: 820 } });

/** Hovering the pill is how the island opens, and then Home has to be ASKED
 *  for.
 *
 * ⚠️ The island lands on the liveliest claim rather than on Home — under
 * `?agents` that is the agents screen, so every one of these measured an empty
 * board and read as the feature being broken. Through the palette rather than
 * the rail, for the reason `tasks.spec` gives: the rail clips most of its
 * stops, so pressing one by name works for whatever is near the middle. */
async function open(page: Page) {
  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Home");
  await page.locator(".palette-row .palette-title")
    .filter({ hasText: /^Home$/ }).first().click();
  await expect(page.locator('.screen[data-screen="home"]')).toBeVisible();
  await expect(page.locator('.screen.active .board-row .home-sec').first()).toBeVisible();
}

/** Press "Arrange the widgets" on the island's TOOLS arc.
 *
 * ⚠️ The tools arc — the far one — because that is where what the open
 * screen can do lives. It was a fifth control on the GLOBAL arc first, and
 * that broke the collapsed pill: every control lengthens the arc's line, and
 * the fifth brought its invisible reach band over the pill so that pressing
 * the pill hit the band. See AGENTS.
 *
 * ⚠️ The arc is bare until it is reached for, and its controls RIDE the line
 * outward as it opens — so a press has to wait for the line to stop moving or
 * it lands where the button was half a second ago. Same rule as tasks.spec. */
async function arrange(page: Page) {
  const at = await page.evaluate(() => {
    const host = document.getElementById("island-tools")!.getBoundingClientRect();
    const line = document.querySelector("#island-tools .arc-line") as unknown as SVGPathElement;
    const mid = line.getPointAtLength(line.getTotalLength() / 2);
    return { x: host.left + mid.x, y: host.top + mid.y };
  });
  await page.mouse.move(at.x, at.y);
  await expect(page.locator("#island-tools")).toHaveClass(/is-open/);
  let last = "";
  await expect.poll(async () => {
    const now = await page.locator("#island-tools .arc-line").getAttribute("d") ?? "";
    const same = now === last;
    last = now;
    return same;
  }, { timeout: 4000 }).toBe(true);
  await press(page, "Arrange the widgets", ".board-tray");
}

/** Press a control and wait for what it does, retrying the press.
 *
 * ⚠️ RETRIED, and not because the app is slow. The shell rebuilds the arc's
 * controls and the tray on every render — the pin has to be rebuilt with its
 * own pressed state, so the whole list is — and the beat is a second wide. A
 * button located and then pressed can therefore be a button that was replaced
 * in between, which Playwright reports as the arc's own transparent hit band
 * intercepting the click. Pressing until the thing it does has happened is the
 * honest way to wait for that. */
async function press(page: Page, label: string, until: string, within = "body") {
  await expect.poll(async () => {
    await page.locator(within).getByLabel(label)
      .click({ force: true, timeout: 1500 }).catch(() => {});
    return page.locator(until).count();
  }, { timeout: 12000 }).toBeGreaterThan(0);
}

/** The kinds on the board, in the order they are drawn. */
const order = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll('.screen.active .board-row .home-sec')]
    .map(el => (el as HTMLElement).dataset.widget));

/** Drag from one point to another in steps, so every pointermove the gesture
 *  depends on actually fires. ⚠️ A single `mouse.move` to the destination
 *  dispatches ONE move event — the drag never passes a midpoint, so nothing
 *  rearranges and the test reads as a broken feature rather than a broken
 *  gesture. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 18 });
  await page.waitForTimeout(160);
  await page.mouse.up();
}

const boxOf = async (page: Page, kind: string) =>
  (await page.locator(`.screen.active .home-sec[data-widget="${kind}"]`).boundingBox())!;

test("the board opens on its three cards and no tray", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  expect(await order(page)).toEqual(["media", "calendar", "today"]);
  await expect(page.locator(".board-tray")).toHaveCount(0);
});

test("arranging shows the tray, and every widget is offered in it", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  /* Every widget there is, with the three already on the board marked as such.
   * ⚠️ Counted against the registry rather than written down: adding a widget
   * is one entry in `WIDGETS`, and a hardcoded number here would turn that into
   * two edits with the second one failing a test that reads as unrelated. */
  await expect(page.locator(".board-tile")).toHaveCount(WIDGETS.length);
  await expect(page.locator(".board-tile.is-on")).toHaveCount(3);
  /* ⚠️ The cards stay LIVE while arranging — the whole argument for doing this
   * on the board rather than in a list. The transport is still drawn; what it
   * loses is the ability to take a press. */
  await expect(page.locator('.home-sec[data-widget="media"] .home-key')).not.toHaveCount(0);
  const takes = await page.evaluate(() => getComputedStyle(
    document.querySelector('.screen.active .home-sec[data-widget="media"] .home-body')!,
  ).pointerEvents);
  expect(takes).toBe("none");
});

test("pressing a tray tile puts the widget on the board, and pressing it again takes it off",
  async ({ page }) => {
    await page.goto(HOME);
    await open(page);
    await arrange(page);
    await page.locator('.board-tile[data-kind="clock"]').click();
    expect(await order(page)).toEqual(["media", "calendar", "today", "clock"]);
    await page.locator('.board-tile[data-kind="clock"]').click();
    expect(await order(page)).toEqual(["media", "calendar", "today"]);
  });

test("a card dragged past its neighbour changes places with it", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  const media = await boxOf(page, "media");
  const today = await boxOf(page, "today");
  await drag(page,
    { x: media.x + media.width / 2, y: media.y + media.height / 2 },
    { x: today.x + today.width - 12, y: today.y + today.height / 2 });
  expect(await order(page)).toEqual(["calendar", "today", "media"]);
});

test("a card dragged off the row is taken off the board", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  const row = (await page.locator(".screen.active .board-row").boundingBox())!;
  const media = await boxOf(page, "media");
  await drag(page,
    { x: media.x + media.width / 2, y: media.y + media.height / 2 },
    { x: media.x + media.width / 2, y: row.y - 110 });
  expect(await order(page)).toEqual(["calendar", "today"]);
});

test("discarding puts back everything the session changed", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  await page.locator('.board-tile[data-kind="clock"]').click();
  await page.locator('.board-tile[data-kind="weather"]').click();
  expect(await order(page)).toEqual(["media", "calendar", "today", "clock", "weather"]);
  /* ⚠️ The × is the whole reason arranging has a mode at all. Every edit is
   * written as it happens — there is no save button — so without something to
   * go back to, the only way out of a mistake is to remember what was there. */
  await press(page, "Discard the changes", ".board-row:not(.is-editing)", ".board-answers");
  await expect(page.locator(".board-tray")).toHaveCount(0);
  expect(await order(page)).toEqual(["media", "calendar", "today"]);
});

test("done keeps what is on screen, and the tray goes", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  await page.locator('.board-tile[data-kind="clock"]').click();
  await press(page, "Done arranging", ".board-row:not(.is-editing)", ".board-answers");
  await expect(page.locator(".board-tray")).toHaveCount(0);
  expect(await order(page)).toEqual(["media", "calendar", "today", "clock"]);
  // And the cards take presses again.
  const takes = await page.evaluate(() => getComputedStyle(
    document.querySelector('.screen.active .home-sec[data-widget="media"] .home-body')!,
  ).pointerEvents);
  expect(takes).not.toBe("none");
});

/** Open one block's settings panel in the tray.
 *
 * ⚠️ The gear, not a pill on the block. The pills used to sit in the block's
 * own flow — content, pushing the widget down and changing its layout while you
 * were choosing that layout — and could only ever offer the one setting that
 * fitted. The panel replaces the widget list in the tray, where there is room
 * for all of them and it is on top of nothing.
 *
 * ⚠️ Polled for the same reason `press` is: the block is rebuilt on the shell's
 * beat, so a control located and then clicked may already be gone. */
async function tune(page: Page, kind: string) {
  await expect.poll(async () => {
    await page.locator(`.home-sec[data-widget="${kind}"] .board-tune`)
      .click({ force: true, timeout: 1500 }).catch(() => {});
    return page.locator(".board-set").count();
  }, { timeout: 12000 }).toBeGreaterThan(0);
  await expect(page.locator(".board-set-name")).toBeVisible();
}

/** The rows of one group in the open panel. */
const rowsOf = (page: Page, group: string) =>
  page.locator(`.board-set-group[aria-label="${group}"] .board-set-row`);

/** Open a block's panel, choose a row, and wait for what it draws. */
async function pick(page: Page, kind: string, label: string, until: string) {
  await tune(page, kind);
  await expect.poll(async () => {
    await rowsOf(page, "View").filter({ hasText: label })
      .click({ force: true, timeout: 1500 }).catch(() => {});
    return page.locator(`.home-sec[data-widget="${kind}"] ${until}`).count();
  }, { timeout: 12000 }).toBeGreaterThan(0);
}

/** The size a block is drawn at, as the grid sees it. */
const sizeOf = (page: Page, kind: string) => page.evaluate(k => {
  const el = document.querySelector(`.screen.active .home-sec[data-widget="${k}"]`) as HTMLElement;
  return el?.dataset.size ?? "";
}, kind);

test("a block is drawn at the size the widget asks for", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  /* The built-in board: three blocks of two cells each, which on a six-column
   * grid is exactly one row. Home has been a BAR since the island had screens. */
  expect(await sizeOf(page, "media")).toBe("2x1");
  expect(await sizeOf(page, "calendar")).toBe("2x1");
  expect(await sizeOf(page, "today")).toBe("2x1");
});

test("only the widgets with more than one shape offer a corner", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  /* ⚠️ A grip that cannot change anything is a control that lies. Every
   * block on the default board has more than one size, so all three have one. */
  await expect(page.locator(".screen.active .board-grip")).toHaveCount(3);
});

test("pulling a corner snaps to a size the widget allows", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  const box = (await boxOf(page, "media"));
  const grip = (await page.locator('.home-sec[data-widget="media"] .board-grip')
    .boundingBox())!;
  /* One cell to the right. ⚠️ In steps, so the gesture passes the halfway
   * point where the snap happens — a single move dispatches one event and the
   * size never changes. */
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 40, grip.y + grip.height / 2, { steps: 4 });
  await page.mouse.move(grip.x + grip.width / 2 + box.width / 2 + 30,
    grip.y + grip.height / 2, { steps: 14 });
  await page.waitForTimeout(160);
  await page.mouse.up();
  await page.waitForTimeout(260);
  /* Media may be 2x1, 3x1 or 2x2 — a cell wider is the one it lands on, and
   * nothing it is not offered can ever be the answer. */
  expect(await sizeOf(page, "media")).toBe("3x1");
});

test("a resize survives being kept, and is undone by discarding", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  /* ⚠️ DOWNWARD, and on the calendar. The task list is the last block on
   * the row, so growing it sideways aims the pointer past the right edge of the
   * window and Playwright clamps the move — which reads as a resize that did
   * not happen. There is always room below. */
  const grip = (await page.locator('.home-sec[data-widget="calendar"] .board-grip')
    .boundingBox())!;
  const box = await boxOf(page, "calendar");
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 30, { steps: 4 });
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + box.height,
    { steps: 14 });
  await page.waitForTimeout(160);
  await page.mouse.up();
  await page.waitForTimeout(260);
  expect(await sizeOf(page, "calendar")).toBe("2x2");
  await press(page, "Discard the changes", ".board-row:not(.is-editing)", ".board-answers");
  // ⚠️ The × puts the SIZES back too, not just what is on the board.
  expect(await sizeOf(page, "calendar")).toBe("2x1");
});

test("a widget with more than one view offers them, and picking one sticks",
  async ({ page }) => {
    await page.goto(HOME);
    await open(page);
    await arrange(page);
    await tune(page, "calendar");
    const views = rowsOf(page, "View");
    // ⚠️ FOUR now: "Up next" was added beside "What is next" rather than
    // replacing it — one is a list, the other is one thing big, and which is
    // right is a taste question, so it is a setting.
    await expect(views).toHaveCount(4);
    await expect(views.filter({ hasText: "This week" })).toHaveAttribute("aria-pressed", "true");

    await views.filter({ hasText: "The month" }).click({ force: true });
    // The month grid is six weeks of cells, always — see `monthGrid`.
    await expect(page.locator('.home-sec[data-widget="calendar"] .home-month .home-day'))
      .toHaveCount(42);
    await expect(page.locator('.home-sec[data-widget="calendar"] .home-days')).toHaveCount(0);

    await press(page, "Done arranging", ".board-row:not(.is-editing)", ".board-answers");
    // ⚠️ It survives leaving the mode: the choice is stored on the board,
    // not held by the screen that drew the panel.
    await expect(page.locator('.home-sec[data-widget="calendar"] .home-month')).toBeVisible();
  });

test("a widget with one shape offers no view picker, and one with three does", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  /* ⚠️ A picker with a single option is a label. Today has one shape, so it
   * gets none — Now playing grew three layouts and now has one, which is what
   * makes this worth asserting rather than assuming. */
  /* ⚠️ A group of ONE is a label with a tick on it — the picker telling you it
   * had nothing to ask. Today has one shape, so its panel offers no View group
   * at all; Now playing has three layouts and offers them. */
  await tune(page, "today");
  await expect(rowsOf(page, "View")).toHaveCount(0);
  // ⚠️ …and every block has a Background, which is what the panel always has.
  await expect(rowsOf(page, "Background")).toHaveCount(4);

  await tune(page, "media");
  await expect(rowsOf(page, "View")).toHaveCount(3);
});

test("a run block opens the screen that manages it", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  await page.locator('.board-tile[data-kind="pomodoro"]').click();
  const block = page.locator('.home-sec[data-widget="pomodoro"]');
  await expect(block).toBeVisible();
  await press(page, "Done arranging", ".board-row:not(.is-editing)", ".board-answers");

  /* ⚠️ Not blank on a fresh install: `settle` keeps one pomodoro so the app
   * always has something to start, and the block names it. */
  await expect(block.locator(".w-lead")).toHaveText("Pomodoro");
  /* ⚠️ `force`, because the key ARRIVES: it is hidden inside the ring until
   * the pointer is on the block and animates in with a scale, so Playwright's
   * stability check sits waiting for a box that is still moving. A hand does
   * not have that problem — it reaches for a button that is already there by
   * the time it gets to it. */
  await block.locator(".home-key.is-main").click({ force: true });
  /* ⚠️ The PHASE, and nothing the circle already says. "Focus · round 1 of 4"
   * was a sentence over a ring that draws four rounds with one of them lit —
   * the same fact in more words, and the longest thing on the block. What the
   * ring cannot say is which phase you are in: the segments look identical
   * either way. */
  await expect(block.locator(".w-lead")).toHaveText("Focus");
  /* ⚠️ ONE key at a single cell, which is what the block defaults to. Three of
   * them are 89px in a block about 72px wide, and the row answered that by
   * wrapping into a vertical column of buttons down the side — which is not a
   * smaller transport, it is a broken one. The press everybody makes is start
   * and pause; skip and reset arrive with the second cell. */
  await expect(block.locator(".home-key")).toHaveCount(1);

  // And the run it started is a real one, on the screen that manages them.
  await block.locator(".home-go").click();
  await expect(page.locator('.screen[data-screen="timer"]')).toBeVisible();
  await expect(page.locator(".tm-go")).toHaveText("Pause");
});

test("a run block draws a ring or a number, and the choice sticks", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  /* ⚠️ The POMODORO block, because it is the one with a run already — `settle`
   * keeps one. A block with nothing of its kind yet is one button rather than a
   * ring, which is the right answer and the wrong fixture for this. */
  await page.locator('.board-tile[data-kind="pomodoro"]').click();
  const block = page.locator('.home-sec[data-widget="pomodoro"]');
  /* ⚠️ TWO views, not three. The dial lived here once and was removed: setting
   * a timer needs a ruler, a name and the list it joins, which is a screen. */
  await tune(page, "pomodoro");
  await expect(rowsOf(page, "View")).toHaveCount(2);
  await expect(block.locator(".w-ring-face")).toBeVisible();

  await pick(page, "pomodoro", "Numbers", ".w-figure");
  await expect(block.locator(".w-ring-face")).toHaveCount(0);
  await press(page, "Done arranging", ".board-row:not(.is-editing)", ".board-answers");
  await expect(block.locator(".w-figure")).toBeVisible();
});

test("a track is laid out as a row, a column or its cover", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  const block = page.locator('.home-sec[data-widget="media"]');
  const how = () => block.getAttribute("data-layout");
  expect(await how()).toBe("bar");

  await tune(page, "media");
  const pill = (label: string) => rowsOf(page, "View").filter({ hasText: label });

  /* ⚠️ A column asked for in a block one row tall is still a row — the
   * variant asks and the size answers, which is the same rule the weather
   * follows. */
  await pill("Column").click({ force: true });
  expect(await how()).toBe("bar");

  await pill("Cover").click({ force: true });
  expect(await how()).toBe("cover");
  // The cover layout is the artwork with the words over it, and no scrubber.
  await expect(block.locator(".home-cover-over")).toBeVisible();
  await expect(block.locator(".home-rail")).toHaveCount(0);

  await pill("Row").click({ force: true });
  expect(await how()).toBe("bar");
  await expect(block.locator(".home-rail")).toBeVisible();
});

test("the weather asks for the hours or the days, and gets what it asked for",
  async ({ page }) => {
    await page.goto(HOME);
    await open(page);
    await arrange(page);
    await page.locator('.board-tile[data-kind="weather"]').click();
    const block = page.locator('.home-sec[data-widget="weather"]');
    await expect(block).toBeVisible();
    /* ⚠️ FOUR views. "Forecast" used to mean whichever of the hours and the
     * days happened to fit, which is the thing a variant exists to stop. */
    await tune(page, "weather");
    // ⚠️ FIVE: "Hours, charted" is the same hours as a shape rather than a row
    // of numbers, offered beside them rather than instead of them.
    await expect(rowsOf(page, "View")).toHaveCount(5);
    for (const label of ["Now", "Hourly", "Daily", "Everything", "Hours, charted"]) {
      await expect(rowsOf(page, "View").filter({ hasText: label })).toHaveCount(1);
    }
  });

/** Width of the open panel, and of the board inside it. */
const islandWide = (page: Page) => page.evaluate(() => Math.round(
  document.getElementById("island-expanded")!.getBoundingClientRect().width));
const rowWide = (page: Page) => page.evaluate(() => Math.round(
  document.querySelector(".screen.active .board-row")!.getBoundingClientRect().width));

/** Wait for the island's width spring to stop. ⚠️ Opening goes through the
 *  palette, which is a different width from Home, so the panel is still moving
 *  when the first block appears — read once and the baseline is a number that
 *  was on its way somewhere. */
async function settled(page: Page) {
  let last = -1;
  let same = 0;
  /* ⚠️ THREE readings the same, not two. A spring slows as it arrives, so two
   * consecutive samples match well before it has stopped — this caught the
   * panel at 921 on its way from 909 to 1081 and reported the board as squeezed
   * when it was simply not there yet. */
  await expect.poll(async () => {
    const now = await islandWide(page);
    same = now === last ? same + 1 : 0;
    last = now;
    return same;
  }, { timeout: 10000, intervals: [120] }).toBeGreaterThanOrEqual(3);
}

test("the tray makes the ISLAND wider, it does not take the room from the board",
  async ({ page }) => {
    await page.goto(HOME);
    await open(page);
    await settled(page);
    const panel = await islandWide(page);
    const row = await rowWide(page);

    await arrange(page);
    /* ⚠️ The panel GREW. The tray asked for `min(WIDTH.home, board + tray)`,
     * and the default Home board already asks for the full width — so there was
     * nothing left to give and the tray's column came out of the grid instead:
     * every block on the board shrank the moment you started arranging it,
     * which is the one thing arranging must not do. A cap may now exceed the
     * default full body, up to `islandBodyMax`. */
    await expect.poll(() => islandWide(page), { timeout: 8000 }).toBeGreaterThan(panel);
    /* ⚠️ Compared once the spring has STOPPED. The panel is mid-travel the
     * instant it is wider than it was, and a board measured there is squeezed
     * by however much of the growth has not arrived yet — which reads exactly
     * like the bug this guards against. */
    await settled(page);
    // …and the board kept every pixel it had, so nothing on it moved.
    expect(await rowWide(page)).toBe(row);
    await expect(page.locator(".board-tray")).toBeVisible();

    // Leaving gives the width back.
    await press(page, "Done arranging", ".board-row:not(.is-editing)", ".board-answers");
    await expect.poll(() => islandWide(page), { timeout: 8000 }).toBe(panel);
  });

/** Put a widget on the board from the tray.
 *
 * ⚠️ RETRIED, like every other press in this file. Adding one re-renders the
 * tray and re-measures the panel twice — once for the widget and once for the
 * column beside it — so a tile located and then pressed can be a tile that was
 * replaced in between. */
async function add(page: Page, kind: string) {
  await expect.poll(async () => {
    await page.locator(`.board-tile[data-kind="${kind}"]`)
      .click({ force: true, timeout: 1500 }).catch(() => {});
    return page.locator(`.home-sec[data-widget="${kind}"]`).count();
  }, { timeout: 12000 }).toBeGreaterThan(0);
}

test("each kind of run gets its own block, and the ring says which", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  await add(page, "pomodoro");
  await add(page, "timer");
  await add(page, "stopwatch");
  await press(page, "Done arranging", ".board-row:not(.is-editing)", ".board-answers");

  const pom = page.locator('.home-sec[data-widget="pomodoro"]');
  const timer = page.locator('.home-sec[data-widget="timer"]');
  const watch = page.locator('.home-sec[data-widget="stopwatch"]');

  /* ⚠️ THREE blocks, each about its own kind. The one "countdown" block this
   * replaced showed whichever run was liveliest — so a pomodoro started on the
   * screen quietly took over the timer you had been watching, and two of them
   * on one board showed the same run twice. */
  await expect(pom.locator(".w-lead")).toContainText("Pomodoro");
  await expect(timer.locator(".w-lead")).toContainText("Timer");
  await expect(watch.locator(".w-lead")).toContainText("Stopwatch");

  /* ⚠️ A block with no run of its kind is ONE BUTTON, not a dead ring over
   * 00:00 — three controls that do nothing and no way to begin. Only the
   * pomodoro has one already, because `Runs.settle` keeps one so the app
   * always has something to start. */
  await expect(timer.locator(".home-key")).toHaveCount(1);
  await expect(timer.locator(".w-line")).toHaveText("Not started");
  await expect(timer.locator(".tm-arc")).toHaveCount(0);

  /* ⚠️ The ring is the SAME builder the screen draws from — `run-ring.ts` —
   * so a pomodoro is eight segments on a board exactly as it is on the screen.
   * The widget had a ring of its own, one plain arc whatever the kind, and the
   * two said different things about the same run. */
  await expect(pom.locator(".tm-seg")).toHaveCount(8);
  await expect(pom.locator(".tm-arc")).toHaveCount(0);

  // Start a timer from its own block, and it gets the unbroken circle.
  await timer.locator(".home-key").click();
  await expect(timer.locator(".tm-arc")).toHaveCount(1);
  await expect(timer.locator(".tm-seg")).toHaveCount(0);
  /* ⚠️ And it started a TIMER, not a pomodoro. The block's key makes a run of
   * the block's own kind — the one this replaced always made a pomodoro,
   * whichever block you pressed. */
  await expect(timer.locator(".w-lead")).toContainText("Timer");
  await expect.poll(async () => pom.locator(".w-ring-said").textContent(), { timeout: 4000 })
    .toBe("25:00");
  await expect.poll(async () => timer.locator(".w-ring-said").textContent(), { timeout: 5000 })
    .not.toBe("25:00");

  // The stopwatch is still its own, untouched by either.
  await expect(watch.locator(".w-line")).toHaveText("Not started");
});

test("the day is an arc with the sun on it", async ({ page }) => {
  /* ⚠️ `sky=day`, because without it this read the REAL clock: the fixture's
   * sunset is 19:34, so it passed all afternoon and drew the moon every
   * evening. A test whose answer depends on the hour it is run at is a test
   * that reports the time of day, not the code. */
  await page.goto(`${HOME}&sky=day`);
  await open(page);
  await arrange(page);
  await add(page, "daylight");
  await press(page, "Done arranging", ".board-row:not(.is-editing)", ".board-answers");
  const block = page.locator('.home-sec[data-widget="daylight"]');

  /* ⚠️ On the BLOCK, not on the body inside it. The wash is the widget and it
   * has to reach the block's own rounded edges — `screen-board.ts` lifts
   * `data-part` up for exactly that, the way it lifts the player's layout. */
  await expect(block).toHaveAttribute("data-part", /dawn|day|dusk|night/);

  // The arc — a soft wide stroke under the line itself — and one body on it.
  await expect(block.locator(".home-sky-glow")).toHaveCount(1);
  await expect(block.locator(".home-sky-line")).toHaveCount(1);
  await expect(block.locator(".home-sky-body")).toHaveCount(1);
  // Daytime, so it is the sun: no terminator to draw.
  await expect(block.locator(".home-sky-body.is-moon")).toHaveCount(0);
  await expect(block.locator(".home-sky-moon")).toHaveCount(0);
  // And the headline says what part of the day it is, at heading size.
  await expect(block.locator(".home-sky-part")).not.toBeEmpty();

  /* ⚠️ Both times, because an arc with a dot on it says "part-way" and nothing
   * else — the times are what make it a clock. They come from the weather
   * reading, so a fixture without them draws the arc and drops these. */
  const feet = block.locator(".home-sky-foot-when");
  await expect(feet).toHaveCount(2);
  /* ⚠️ Whatever the fixture says, not the two real times — `sky=day` moves
   * them to hold the widget in daylight at any hour, so hardcoding the
   * unflagged pair here would put the clock back into the test by the back
   * door. */
  await expect(feet.first()).toHaveText(/^\d\d:\d\d$/);
  await expect(feet.last()).toHaveText(/^\d\d:\d\d$/);

  /* ⚠️ The body sits ON the path and INSIDE the block. The arc runs off both
   * sides and below the frame on purpose, so a body placed at 0 or 1 of the
   * path's length is outside the crop — which is what happened, and it meant
   * the sun vanished for the half hour either side of sunrise and sunset. */
  const box = (await block.boundingBox())!;
  const body = (await block.locator(".home-sky-body").boundingBox())!;
  expect(body.x).toBeGreaterThan(box.x);
  expect(body.x + body.width).toBeLessThan(box.x + box.width);
  expect(body.y).toBeGreaterThan(box.y);
  expect(body.y + body.height).toBeLessThan(box.y + box.height);
  // Round, whatever shape the block is — it is laid over the stretched arc.
  expect(Math.round(body.width)).toBe(Math.round(body.height));
});

test("after dark it is the moon, with its phase", async ({ page }) => {
  /* ⚠️ `sky=night` moves SUNSET rather than the clock — Daylight decides which
   * body to draw from where "now" falls between the two times, so faking the
   * hour instead would have every other fixture on the page living in the
   * future. */
  await page.goto("/tasks.html?agents&sky=night");
  await open(page);
  await arrange(page);
  await add(page, "daylight");
  await press(page, "Done arranging", ".board-row:not(.is-editing)", ".board-answers");
  const block = page.locator('.home-sec[data-widget="daylight"]');

  await expect(block).toHaveAttribute("data-part", "night");
  await expect(block.locator(".home-sky-body.is-moon")).toHaveCount(1);
  /* ⚠️ A LIT LIMB and a rim, not a disc with a shadow laid over it: the unlit
   * half has to let the sky through, and a disc in the background colour is a
   * hole that goes the wrong colour the moment the wash changes. */
  await expect(block.locator(".home-sky-moon")).toHaveCount(1);
  await expect(block.locator(".home-sky-rim")).toHaveCount(1);
  // The headline is the phase, which is the interesting thing after dark.
  await expect(block.locator(".home-sky-note")).toHaveText(/moon|crescent|gibbous|quarter/i);
});

test("a block can be given a ground, and it sticks", async ({ page }) => {
  await page.goto(HOME);
  await open(page);
  await arrange(page);
  const block = page.locator('.home-sec[data-widget="today"]');

  /* ⚠️ `none` is the DEFAULT. The board lost its cards on purpose — ten
   * identical rounded rectangles is a wall saying the same nothing — so a
   * ground is something you reach for when one block should stand apart. */
  await expect(block).toHaveAttribute("data-ground", "none");

  await tune(page, "today");
  await rowsOf(page, "Background").filter({ hasText: "Raised" }).click({ force: true });
  await expect(block).toHaveAttribute("data-ground", "raised");

  await press(page, "Done arranging", ".board-row:not(.is-editing)", ".board-answers");
  // It is stored on the board, not held by the screen that drew the panel.
  await expect(block).toHaveAttribute("data-ground", "raised");
});

test("the settings panel makes the ISLAND wider, and the board keeps its room",
  async ({ page }) => {
    await page.goto(HOME);
    await open(page);
    await settled(page);
    const alone = await islandWide(page);

    await arrange(page);
    await settled(page);
    const listed = await islandWide(page);
    const row = await rowWide(page);
    expect(listed).toBeGreaterThan(alone);

    /* ⚠️ The panel is WIDER than the list, so the island grows again rather
     * than the panel wrapping inside the list's own column. Same rule the tray
     * itself follows: room for something beside the board is room ADDED. */
    await tune(page, "today");
    await settled(page);
    expect(await islandWide(page)).toBeGreaterThan(listed);
    expect(await rowWide(page)).toBe(row);

    // Backing out gives it back.
    await page.locator(".board-set-back").click({ force: true });
    await settled(page);
    expect(await islandWide(page)).toBe(listed);
  });
