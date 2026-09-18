import { test, expect, type Page } from "@playwright/test";
import { FRAME, cpx } from "../../src/layout";

/** What the island measures when something has capped its body, curls included.
 *  ⚠️ Derived from the app's own constants rather than written down here: every
 *  screen asks for its own width now, so "about 910px" is no longer true of
 *  anything and a hardcoded margin rots the moment a width is tuned. */
const capped = (design: number) => cpx(design) + 2 * cpx(FRAME.islandCurl);

/** Hovering the pill is how the island opens; the surface reports its own rect
 *  as the hot zone, so aim at the shape rather than at a fixed point. */
async function open(page: Page) {
  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();
}

/** The island opens on Home now, so the day screen has to be asked for. */
async function openToday(page: Page) {
  await open(page);
  await goTo(page, "today");
  await expect(page.locator("#inline-composer")).toBeVisible();
}

/** ⚠️ Scope day assertions to the Today screen. Home lists the same tasks, so
 *  a bare getByText matches twice and Playwright refuses in strict mode. */
const day = (page: Page) => page.locator('[data-screen="today"]');

/** The island's own four controls — search, pin, settings, collapse — sit on a
 *  line struck off its NEAR corner, and that line is bare until you reach for
 *  it. So a test that presses one has to reach first.
 *
 * ⚠️ A point ON the curve, not the host's centre. The host is the whole
 * quadrant outside the corner and is `pointer-events: none` everywhere except
 * an invisible band along the line — hovering its middle dispatches into empty
 * space and nothing opens. */
async function reachIsland(page: Page) {
  const at = await page.evaluate(() => {
    const host = document.getElementById("island-global")!.getBoundingClientRect();
    const line = document.querySelector("#island-global .arc-line") as unknown as SVGPathElement;
    const mid = line.getPointAtLength(line.getTotalLength() / 2);
    return {x: host.left + mid.x, y: host.top + mid.y};
  });
  await page.mouse.move(at.x, at.y);
  await expect(page.locator("#island-global")).toHaveClass(/is-open/);
  /* ⚠️ And wait for it to STOP. Opening springs the line outward and the
   * controls ride it, so for about half a second every one of them is at a
   * position it is about to leave — Playwright measures a button, the button
   * moves, and the click lands on the invisible hit band behind it. Settled is
   * two identical measurements in a row. */
  let last = "";
  await expect.poll(async () => {
    const now = await page.locator("#island-global .arc-line").getAttribute("d") ?? "";
    const same = now === last;
    last = now;
    return same;
  }, {timeout: 4000}).toBe(true);
}

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
async function goTo(page: Page, screen: string, settle = true) {
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
  if (!settle) return;
  let last = -1;
  await expect.poll(async () => {
    const now = await page.locator("#island").evaluate(el =>
      Math.round(el.getBoundingClientRect().height));
    const same = now === last;
    last = now;
    return same;
  }, {timeout: 5000}).toBe(true);
}

test("the island morphs from one pill into one panel, and the tabs switch screens", async ({page}) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/tasks.html");

  // Collapsed: one shape, short, hugging the top edge.
  const pill = await page.locator("#island").boundingBox();
  expect(pill!.y).toBeLessThanOrEqual(1);
  expect(pill!.height).toBeLessThan(50);
  await expect(page.locator("#island-expanded")).toBeHidden();

  await open(page);
  // Polled: the spring is still travelling when the layer first shows. It is a
  // BAR — wide and shallow — so the threshold is deliberately low.
  await expect.poll(() => page.locator("#island").evaluate(el => el.getBoundingClientRect().height))
    .toBeGreaterThan(120);
  const panel = await page.locator("#island").boundingBox();
  expect(panel!.y).toBeLessThanOrEqual(1);        // still welded to the edge
  // The panel is the island, not a second box floating beside it.
  expect(await page.locator("#task-panel").count()).toBe(0);
  expect(await page.locator("#task-rail").count()).toBe(0);

  // The expanded layer is centred in the shape, not half a width off it.
  const layer = await page.locator("#island-expanded").boundingBox();
  expect(Math.abs((layer!.x + layer!.width / 2) - (panel!.x + panel!.width / 2))).toBeLessThan(2);

  // The date line separator is a real middle dot, not a mangled CSS escape.
  await goTo(page, "today");
  await expect(page.locator("#day-date")).toHaveText(/\w/);
  await expect(page.locator(".day-meta")).not.toContainText("00b7");
  await goTo(page, "home");
  // Home is the default: three sections on one row, one per other screen.
  await expect(page.locator(".home-sec")).toHaveCount(3);
  await expect(page.locator(".home-month")).toBeVisible();
  await goTo(page, "calendar");
  // The month grid and the agenda beside it — one view, not two.
  await expect(page.locator(".cal-grid")).toBeVisible();
  await goTo(page, "today");
  await expect(day(page).getByText("Get outside for a walk", {exact: true})).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({path: "test-results/island-today.png"});
});

/* ⚠️ `noagents` on the three tests below, and it is not a fixture tidy-up.
 * A session that is WORKING claims the strip at 46 — over a track at 40 —
 * because a phrase that changes every few seconds is more live than one that
 * has been the same song for three minutes. The default fixture has a working
 * session in it, so without the flag these tests would be reading the agent
 * claim and calling it a media bug. */
test("the collapsed pill shows whatever is most live, and opens that screen", async ({page}) => {
  await page.goto("/tasks.html?noagents");
  // Something playing outranks the day's tally.
  await expect(page.locator(".pill-label")).toHaveText(/potion shop/);
  await expect(page.locator(".pill-eq.on")).toBeVisible();
  /* ⚠️ Nothing raises a dot for the player, and that is deliberate rather
   * than a consequence of it losing its tab: a dot means "this screen has
   * something you have not seen", and the track is already named on the pill
   * with its equaliser running. The same claim twice is worse than once. */
  await expect(page.locator('[data-tab="home"]')).not.toHaveClass(/live/);
  await expect(page.locator('[data-tab="today"]')).not.toHaveClass(/live/);
  await page.locator("#island-collapsed").click();
  await expect(page.locator("#island-expanded")).toBeVisible();

  // With nothing live the pill is a clock, and ONLY a clock. This is the state
  // it sits in for most of the day, so everything that is not the time was
  // taken off it: no ring, no date, no tally.
  await page.goto("/tasks.html?quiet");
  await expect(page.locator("#island-collapsed")).toHaveClass(/is-clock/);
  await expect(page.locator(".pill-clock")).toHaveText(/^\d{1,2}:\d{2}$/);
  for (const gone of [".pill-ring", ".pill-value", ".pill-label", ".pill-lead", ".pill-eq"]) {
    await expect(page.locator(gone)).toHaveCount(0);
  }
});

test("at rest the pill is a date, a centred clock, and one module", async ({page}) => {
  await page.clock.install({time: new Date("2026-09-14T14:53:00")});
  await page.goto("/tasks.html?quiet");
  await expect(page.locator("#island-collapsed")).toHaveClass(/is-clock/);
  await expect(page.locator(".pill-date-day")).toHaveText("14");
  await expect(page.locator(".pill-date-month")).toHaveText("SEP");

  /* ⚠️ The clock must sit dead centre of the pill whatever the two sides
   * weigh. A clock that slides as the module changes from "22°" to "3 tasks
   * left" is one the eye has to find before it can read, which is the whole
   * job it has. This is the assertion that catches `auto auto auto`. */
  const pill = (await page.locator("#island-collapsed").boundingBox())!;
  const clock = (await page.locator(".pill-clock").boundingBox())!;
  expect(Math.abs((clock.x + clock.width / 2) - (pill.x + pill.width / 2))).toBeLessThan(2);

  /* A glyph and one token, never a sentence. The strip is on screen all day;
   * after a week you are reading the icon and the colour, and the words are
   * only costing width. The demo machine reports a disk at 97%. */
  const slot = page.locator(".pill-module");
  await expect(slot).toHaveAttribute("data-module", "disk");
  await expect(slot).toHaveAttribute("data-tone", "hot");
  await expect(slot.locator(".pill-module-text")).toHaveText("97%");
  await expect(slot.locator(".pill-module-mark svg")).toHaveCount(1);
  await expect(page.locator(".pill-module-note")).toHaveCount(0);

  // News holds the slot rather than taking its turn behind the weather...
  await page.clock.fastForward(30_000);
  await expect(slot).toHaveAttribute("data-module", "disk");
  /* ...but a STANDING condition rejoins the rotation. A disk at 97% until
   * someone buys a new one is a fact about the machine, not an alert, and a
   * permanent red warning is exactly the warning you stop seeing. */
  await page.clock.fastForward(150_000);
  await expect(slot).not.toHaveAttribute("data-module", "disk");

  // The whole pill stays narrow: a notch, not a toolbar someone left open.
  expect(pill.width).toBeLessThan(300);
});

test("the clock is 24-hour by default, switches to 12, and pops only the digits that moved", async ({page}) => {
  await page.clock.install({time: new Date("2026-09-14T14:32:00")});
  await page.goto("/tasks.html?quiet");
  const clock = page.locator(".pill-clock");
  await expect(clock).toHaveText("14:32");

  // A minute later only the units digit is new, so only it carries the pop.
  // Re-animating all five characters once a minute is the twitch-in-the-corner
  // problem the "no seconds" rule already solved once.
  await page.clock.fastForward(60_000);
  await expect(clock).toHaveText("14:33");
  expect(await clock.locator("[data-pop]").allTextContents()).toEqual(["3"]);

  // An hour rollover moves three of them, and the colon is never one of them.
  await page.clock.setFixedTime(new Date("2026-09-14T15:00:00"));
  await expect(clock).toHaveText("15:00");
  expect(await clock.locator("[data-pop]").allTextContents()).toEqual(["5", "0", "0"]);

  /* ⚠️ Through the PALETTE. The island's gear used to drop a popover holding
     the edge, the clock and the task view; those live in the settings window
     now, and the command is what is left on the island itself. */
  await open(page);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("12-hour");
  await page.keyboard.press("Enter");
  // 3 PM, not 15:00 and not 03 PM: the 12-hour cycle drops the leading zero in
  // every engine, so the two formats are different lengths.
  await expect(clock).toHaveText(/^3:00\s?[AaPp]\.?[Mm]\.?$/);
  // And back, through the same command — which now offers the other format,
  // because a command that said "12-hour" twice would be a dead end.
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("24-hour");
  await page.keyboard.press("Enter");
  await expect(clock).toHaveText("15:00");
});

test("a player left paused hands the pill back to the clock", async ({page}) => {
  // nocal, not quiet: the demo meeting is 18 minutes out and a *paused* player
  // ranks below an imminent one, so it would win this contest legitimately.
  await page.goto("/tasks.html?nocal&nofollow&noagents");
  await expect(page.locator("#island-collapsed")).toHaveAttribute("data-kind", "media");
  await open(page);
  // The transport lives on Home now, which is the screen the island opens on.
  await page.getByRole("button", {name: "Pause", exact: true}).click();
  // Paused is still a claim at first — the controls stay one glance away.
  await expect(page.locator("#island-collapsed")).toHaveAttribute("data-kind", "media");
  // ...but not for long. 30s in the app; the clock is what it falls back to.
  await page.clock.install();
  await page.clock.fastForward(35_000);
  await expect(page.locator("#island-collapsed")).toHaveAttribute("data-kind", "clock");
});

/* ⚠️ The Media SCREEN's two tests are gone with the screen, and that is the
 * honest accounting rather than an oversight: the scrubber and the waveform
 * were the only things it had that Home does not, and deleting a feature
 * deletes what covered it. What survives is tested where it now lives — the
 * pill's claim and hand-back above, and the transport on Home below. */
test("the player is on Home, and the transport there is the whole control", async ({page}) => {
  await page.goto("/tasks.html?nofollow");
  await open(page);
  await expect(page.locator(".home-track-title")).toHaveText(/potion shop/);
  await expect(page.locator(".home-media")).toBeVisible();

  const pause = page.getByRole("button", {name: "Pause", exact: true});
  await expect(pause).toBeVisible();
  await pause.click();
  // Optimistic: the button flips without waiting for Windows to answer.
  await expect(page.getByRole("button", {name: "Play", exact: true})).toBeVisible();
  await expect(page.locator(".pill-eq.on")).toHaveCount(0);

  /* ⚠️ And no chevron. Every other Home column is a summary with a fuller
   * screen behind it; this one has no screen behind it any more, so an arrow
   * promising one would be a control that goes nowhere. */
  await expect(page.locator(".home-media .home-go")).toHaveCount(0);
  await expect(page.locator(".home-sec .home-go")).toHaveCount(2);
  await page.screenshot({path: "test-results/island-media.png"});
});

test("the agenda groups by day and offers a link only where there is one", async ({page}) => {
  await page.goto("/tasks.html");
  await open(page);
  await goTo(page, "calendar");
  /* ⚠️ No "next up" banner any more. It named the event that is already the
     first row of the agenda underneath it, and the pill says the same thing
     again when it is close — three places for one fact. */
  await expect(page.locator(".cal-next")).toHaveCount(0);
  await expect(page.locator(".cal-row").first()).toContainText("Design review");
  /* Grouped by day, with the ISO week beside the heading. Not asserted as
     "Today": the demo's next event is minutes away, which after 23:40 is
     tomorrow. That a heading is printed is the point, not which one. */
  await expect(page.locator(".cal-day").first()).toHaveText(/\S/);
  await expect(page.locator(".cal-wk").first()).toHaveText(/^WK\. \d+$/);
  // Two of the three demo events are calls; the lunch is not.
  await expect(page.locator(".cal-join")).toHaveCount(2);
  /* The location is in the PANEL now, not on the row. A row is a title and a
     time; everything else about an event is one press away and does not have
     to be squeezed into a list. */
  await page.locator(".cal-row").filter({hasText: "Lunch"}).click();
  await expect(page.getByText("Cafe Mistral")).toBeVisible();
  await page.screenshot({path: "test-results/island-calendar.png"});
});

test("day screen: overdue in place, nesting, and a completion that settles into the drawer", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await openToday(page);
  /* ⚠️ The count is read off the day screen, not off the pill. The resting
   * pill carries the time and nothing else now — see the clock test above — so
   * `#day-left` is the live readout these completions have to move. */
  await expect(page.locator("#day-left")).toHaveText("4 left");

  await expect(day(page).getByText("Book a haircut", {exact: true})).toBeVisible();
  // Capped, so a task forgotten for two years is not the widest thing in the row.
  await expect(page.locator(".day-chip").first()).toHaveText(/^(\d{1,2}|99\+)d$/);

  await expect(day(page).getByText("Polish the task panel", {exact: true})).toBeVisible();
  await expect(page.getByLabel("Check nested tasks", {exact: true})).toBeHidden();
  await page.getByLabel("Expand Polish the task panel").click();
  await page.getByLabel("Check nested tasks", {exact: true}).check();
  await expect(page.locator("#day-left")).toHaveText("3 left");
  await page.getByLabel("Collapse Build a calmer workspace").click();
  await expect(day(page).getByText("Polish the task panel", {exact: true})).toBeHidden();
  await page.getByLabel("Expand Build a calmer workspace").click();

  await day(page).getByLabel("Complete Get outside for a walk", {exact: true}).check();
  await expect(page.locator("#day-left")).toHaveText("2 left");
  await expect(day(page).getByText("Get outside for a walk", {exact: true})).toBeHidden();

  /* ⚠️ Finished work is behind the header's switch, not a drawer under the
   * list. The drawer put "1 done today" in the one place nobody looks — below
   * everything else — and opening it made a long list longer, which is the
   * opposite of what looking back over the day is for. */
  const done = page.getByRole("tab", {name: "Done 1"});
  await expect(done).toBeVisible();
  await done.click();
  await expect(day(page).getByText("Get outside for a walk", {exact: true})).toBeVisible();
  await expect(day(page).getByText("Book a haircut", {exact: true})).toBeHidden();
  await page.getByRole("tab", {name: "Open"}).click();
  await expect(day(page).getByText("Book a haircut", {exact: true})).toBeVisible();
});

test("the composer is a live field: no reveal, and Enter leaves it ready for the next", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await openToday(page);
  const field = page.getByRole("textbox", {name: "Task name"});
  await expect(field).toBeVisible();
  await field.click();
  await field.fill("Write a quiet interface");
  await page.keyboard.press("Enter");
  await expect(day(page).getByText("Write a quiet interface", {exact: true})).toBeVisible();
  await expect(page.locator("#day-left")).toHaveText("5 left");
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  await field.fill("And then a second");
  await page.keyboard.press("Enter");
  await expect(page.locator("#day-left")).toHaveText("6 left");
  expect(page.context().pages()).toHaveLength(1);
});

test("the composer is one row, and says where a task will go only while typing", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await openToday(page);
  const chips = page.locator(".composer-chips");
  const field = page.getByRole("textbox", {name: "Task name"});

  /* ⚠️ Only while the field has focus. Where a task goes is a decision you make
   * while typing, not a permanent fixture — on a screen you look at all day two
   * chips sitting there saying nothing is two more things to read past. */
  expect(await chips.evaluate(el => getComputedStyle(el).opacity)).toBe("0");
  await field.click();
  await expect.poll(() => chips.evaluate(el => getComputedStyle(el).opacity)).toBe("1");

  /* ⚠️ Not a native `<select>` or `<input type=date>`. Windows paints those,
   * not us, and a second row of them was the single biggest reason this screen
   * looked like a different application below the fold. */
  await expect(page.locator("#inline-composer select, #inline-composer input[type=date]")).toHaveCount(0);
  await expect(page.locator("#chip-day")).toHaveText("Today");

  // The day is a name, never an ISO date: a chip is read at a glance or not read.
  await page.locator("#chip-day").click();
  const options = page.locator(".chip-menu .chip-option");
  await expect(options).toHaveCount(7);
  await expect(options.nth(1)).toHaveText("Tomorrow");
  await options.nth(1).click();
  await expect(page.locator("#chip-day")).toHaveText("Tomorrow");
  await expect(page.locator(".chip-menu")).toHaveCount(0);
  await page.screenshot({path: "test-results/island-composer.png"});
});

test("a draft survives the island folding, and renaming happens in place", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await openToday(page);
  const field = page.getByRole("textbox", {name: "Task name"});
  await field.click();
  await field.fill("Half a thought");
  /* ⚠️ BELOW the island, measured rather than guessed. A fixed (0, 400) used
   * to be off the panel and is not any more: the island measures itself to its
   * content now and a full day is 436px tall, so the old "away" point is inside
   * it and the pointer never left. */
  const box = (await page.locator("#island").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 60);
  await expect(field).toBeVisible();            // a live field holds it open
  await page.keyboard.press("Escape");          // releases the field, keeps the draft
  await expect(page.locator("#island-expanded")).toBeHidden();
  await open(page);
  await expect(field).toHaveValue("Half a thought");

  await day(page).getByRole("button", {name: "Rename Get outside for a walk"}).click();
  const rename = page.locator(".day-field");
  await expect(rename).toBeFocused();
  await rename.fill("Get outside twice");
  await page.keyboard.press("Enter");
  await expect(day(page).getByText("Get outside twice", {exact: true})).toBeVisible();

  await reachIsland(page);
  await page.getByRole("button", {name: "Collapse the island", exact: true}).click();
  await expect(page.locator("#island-expanded")).toBeHidden();
});

test("finishing the last task clears the day", async ({page}) => {
  await page.goto("/tasks.html?single&quiet");
  await openToday(page);
  await expect(page.locator("#day-left")).toHaveText("1 left");
  await day(page).getByLabel("Complete Get outside for a walk", {exact: true}).check();
  await expect(page.locator("#day-left")).toHaveText("all done");
  await expect(page.getByRole("heading", {name: "Day clear"})).toBeVisible();
  // Both parts of the mark draw themselves; this catches the day the dash
  // lengths in the stylesheet stop matching the geometry.
  for (const part of [".arc", ".mark"]) {
    await expect.poll(() => page.locator(`.clear-ring ${part}`)
      .evaluate(el => getComputedStyle(el).strokeDashoffset)).toBe("0px");
  }
  await page.screenshot({path: "test-results/island-clear.png"});
});

test("settings: one window, seven pages, and nothing that can show a token", async ({page}) => {
  await page.setViewportSize({width: 900, height: 640});
  await page.goto("/task-editor.html");

  // ⚠️ The page that replaced this one. A quick-add form and a task list
  // lived here; they live on the island now, and a test that only checked the
  // new page would not notice them coming back.
  await expect(page.locator("#task-form")).toHaveCount(0);
  await expect(page.locator("#editor-list")).toHaveCount(0);

  await expect(page.getByRole("tab")).toHaveCount(7);
  await expect(page.getByRole("tab", {name: "General"})).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", {name: "General"})).toBeVisible();
  await page.screenshot({path: "test-results/settings-general.png"});

  // The accent is one variable, and picking it has to paint the window it was
  // picked in — a colour you have to restart to see is a colour nobody trusts.
  await page.getByRole("tab", {name: "Appearance"}).click();
  await page.locator('[data-accent="#a78bfa"]').click();
  await expect.poll(() => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#a78bfa");
  await page.screenshot({path: "test-results/settings-appearance.png"});

  /* ⚠️ Settled, not clicked-and-shot. A pane arrives on an animation from
     opacity 0, and a screenshot taken on the click catches its first frame —
     which looks exactly like a pane that rendered nothing. */
  await page.getByRole("tab", {name: "Island"}).click();
  await expect(page.locator("#pane-island")).toHaveCSS("opacity", "1");
  await page.screenshot({path: "test-results/settings-island.png"});
  await page.getByRole("tab", {name: "The pill"}).click();
  await expect(page.locator("#pane-pill")).toHaveCSS("opacity", "1");
  await expect(page.locator("#modules .set-row")).toHaveCount(7);
  await page.screenshot({path: "test-results/settings-pill.png"});

  /* The recorder takes a key press, not typing. ⚠️ `Ctrl+Alt+J` rather than
     a letter AltGr claims — see the guard checked below. */
  await page.getByRole("tab", {name: "Shortcuts"}).click();
  await page.locator("#key-toggle").click();
  await expect(page.locator("#key-toggle")).toHaveClass(/is-listening/);
  await page.keyboard.press("Control+Alt+J");
  await expect(page.locator("#key-toggle")).toHaveText("CtrlAltJ");
  await expect(page.locator("#altgr-note")).toBeHidden();

  /* ⚠️ Ctrl+Alt IS AltGr on Windows, and on a Polish layout `Ctrl+Alt+N`
     takes `ń` away everywhere on the machine. The warning is the only thing
     connecting the two, since neither Windows nor Tauri says a word. */
  await page.locator("#key-capture").click();
  await page.keyboard.press("Control+Alt+N");
  await expect(page.locator("#altgr-note")).toContainText("AltGr+N");
  await page.screenshot({path: "test-results/settings-keys.png"});

  // Nothing here may display a secret, and the fields that take one say so.
  await page.getByRole("tab", {name: "Connections"}).click();
  await expect(page.locator("#token")).toHaveAttribute("type", "password");
  await expect(page.locator("#google-secret")).toHaveAttribute("type", "password");
  await page.screenshot({path: "test-results/settings-accounts.png"});

  // Back to a normal viewport: the island is ~970px wide.
  await page.setViewportSize({width: 1200, height: 700});
  await page.goto("/tasks.html?empty&quiet");
  await open(page);
  await goTo(page, "today");
  await expect(page.getByRole("button", {name: "Connect TickTick", exact: true})).toBeVisible();
  // Nothing connected means nothing countable: the line is empty rather than
  // claiming a zero it cannot stand behind.
  await expect(page.locator("#day-left")).toHaveText("");
});

test("the day can be scoped to one TickTick list, and says which", async ({page}) => {
  await page.goto("/tasks.html?nocal");
  await openToday(page);

  const rail = page.locator("#day-lists");
  const chips = rail.locator(".list-chip");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText("All");

  /* ⚠️ The count on a chip is ROWS, not tasks: the day folds subtasks into
     their parent, so a chip wearing the task count would promise rows it does
     not open. All is the sum of the others. */
  /* ⚠️ Direct children. `.day-row` matches subtask rows too — they are drawn
     INSIDE their parent's slot — so counting all of them compares six rows
     against a chip that correctly says four. */
  const rows = day(page).locator("#task-list-content > .slot");
  const before = await rows.count();
  await expect(chips.nth(0).locator(".list-chip-count")).toHaveText(String(before));

  const first = await chips.nth(1).locator(".list-chip-name").textContent();
  const mine = Number(await chips.nth(1).locator(".list-chip-count").textContent());
  await chips.nth(1).click();
  await expect(chips.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows).toHaveCount(mine);

  /* The header counts what it sits above, so it follows the filter. ⚠️ It no
   * longer NAMES the list: the chip rail three millimetres below is the
   * control that chose it and wears it lit, and saying it twice spent the one
   * line that carries the date and what is left on the fact people read last. */
  await expect(page.locator("#day-list")).toHaveCount(0);
  /* ⚠️ And what is left is counted on the FILTER, not on the day: it sits
   * directly above these rows. The number is not the chip's, which counts
   * visible root rows — this one counts open tasks, children included. */
  await expect(page.locator("#day-left")).not.toHaveText("");

  // A new task files into the list you are looking at, not into whichever one
  // happens to be first — otherwise it lands somewhere the rail hides.
  await expect(page.locator("#chip-list")).toContainText(first);

  await page.screenshot({path: "test-results/island-lists.png"});

  // The choice survives a reload: the rail is always on screen with the chosen
  // chip lit, so remembering it is not a filter anyone can forget.
  await page.reload();
  await openToday(page);
  await expect(page.locator("#day-lists .list-chip").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(day(page).locator("#task-list-content > .slot")).toHaveCount(mine);

  await page.locator("#day-lists .list-chip").first().click();
  await expect(day(page).locator("#task-list-content > .slot")).toHaveCount(before);
  await expect(page.locator("#day-list")).toHaveCount(0);
});

test("long titles stay inside the island", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await openToday(page);
  await day(page).locator(".task-title").first().evaluate(label => {
    label.textContent = "A very long nested task title ".repeat(12);
  });
  // Polled: the island is still springing to its new height when the title
  // changes, and a plain expect on an evaluate result does not retry.
  await expect.poll(() => page.locator("#island")
    .evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
});

test("all four edges keep the island upright and inside its window", async ({page}) => {
  await page.setViewportSize({width: 1000, height: 850});
  /* ⚠️ One load per edge. The island has no edge control any more — it is in
     the settings window, which is a different page — so the preview stages the
     edge from the query string instead. This also covers something the old
     loop did not: BOOTING on each edge, rather than only arriving there. */
  for (const edge of ["left", "top", "bottom", "right"]) {
    await page.goto(`/tasks.html?quiet&edge=${edge}`);
    await open(page);
    /* Through the palette. ⚠️ Not the control on the arc: that is bare
     * until it is reached for, and these tests are not about reaching for
     * it — they only need the island held open while they poke at it. */
    await page.keyboard.press("Control+k");
    await page.locator(".palette-field").fill("Keep the island open");
    await page.keyboard.press("Enter");
    await expect(page.locator("#notch-shell")).toHaveAttribute("data-edge", edge);
    await expect.poll(() => page.locator("#notch-shell").evaluate(shell => {
      const outer = shell.getBoundingClientRect();
      const island = document.getElementById("island")!.getBoundingClientRect();
      return island.left >= outer.left - 1 && island.right <= outer.right + 1
        && island.top >= outer.top - 1 && island.bottom <= outer.bottom + 1;
    })).toBe(true);
    /* ⚠️ And the header controls stay inside it. On a vertical edge the
     * panel is only ~270px wide; a tab strip that refused to shrink laid
     * `.panel-actions` out past the island's right edge, where the clip
     * erased them — pin, settings and collapse were simply absent, with
     * nothing in the DOM saying so.
     *
     * ⚠️ `.panel-actions` and its buttons, NOT every descendant of the header.
     * The tab strip is a horizontal scroller, so a tab scrolled out of view
     * legitimately reports a rect outside the island — asserting over all of
     * them tests the scroller, not the bug this is here for. */
    await expect.poll(() => page.locator("#island").evaluate(el => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll(".panel-actions, .panel-actions > *")].every(part => {
        const r = part.getBoundingClientRect();
        return !r.width || (r.left >= box.left - 1 && r.right <= box.right + 1);
      });
    })).toBe(true);
    await page.screenshot({path: `test-results/island-${edge}.png`});
  }
});

test("a short day uses a shorter island and reduced motion still folds", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto("/tasks.html?single&quiet");
  await open(page);
  await goTo(page, "today");
  await expect(page.locator("#task-list .task-title")).toHaveCount(1);
  // A one-task day is markedly shorter than the 527px the island can reach.
  const island = await page.locator("#island").boundingBox();
  expect(island!.height).toBeLessThan(360);
  await page.mouse.move(0, 400);
  await expect(page.locator("#island-expanded")).toBeHidden();
});

test("the selection travels, and lands exactly where it is going", async ({page}) => {
  await page.setViewportSize({width: 1060, height: 560});
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  /* Through the palette. ⚠️ Not the control on the arc: that is bare
   * until it is reached for, and these tests are not about reaching for
   * it — they only need the island held open while they poke at it. */
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");

  /* ⚠️ The rail's equivalent of the old sliding pill. There is no pill any
   * more — the selection is the MIDDLE of the rail, and a stop is selected by
   * being under it. So the thing that can go wrong is the same thing and the
   * assertion is the same shape: the chosen stop has to land exactly there,
   * not near there. */
  const sits = () => page.evaluate(() => {
    const rail = document.getElementById("island-rail")!.getBoundingClientRect();
    const here = document.querySelector(".rail-stop.is-here");
    if (!here) return 99;
    const box = here.getBoundingClientRect();
    return Math.abs((box.left + box.width / 2) - (rail.left + rail.width / 2));
  });

  for (const tab of ["shelf", "review", "today", "home"]) {
    await goTo(page, tab);
    await expect.poll(sits, {timeout: 4000}).toBeLessThan(1.5);
  }

  /* ⚠️ Exactly one stop is the one you are on. `is-here` is computed per
   * frame from a distance, not toggled by a class on the neighbours, so an
   * off-by-one in that sum shows up as two stops captioned at once or none —
   * and both of those still LOOK like a working carousel in a screenshot. */
  await page.mouse.move(520, 520);
  await expect(page.locator(".rail-stop.is-here")).toHaveCount(1);
  // And the header names it — the one place a screen is spelled out.
  await expect(page.locator("#island-where")).toHaveText("Home");
  await page.screenshot({path: "test-results/island-rail.png"});
});

test("Home gathers the other three onto one row, and opens into them", async ({page}) => {
  await page.goto("/tasks.html?nofollow");
  await open(page);
  // Media: the track and working transport, without leaving Home.
  await expect(page.locator(".home-track-title")).toHaveText(/potion shop/);
  // exact: the column heading "Open Now playing" also contains "Play".
  await page.getByRole("button", {name: "Pause", exact: true}).click();
  await expect(page.getByRole("button", {name: "Play", exact: true})).toBeVisible();
  // Calendar: a date strip with today marked, and what is next.
  await expect(page.locator(".home-day.is-today .home-day-num")).toHaveText(String(new Date().getDate()));
  await expect(page.locator(".home-next-when")).toHaveText(/^(All day|now|in \d+ (min|h|d))$/);
  /* Today: the next few tasks, completable in place. ⚠️ No progress ring here
   * any more — it cost a third of the section to say "1/1", which the resting
   * pill already says and the Today screen says properly. */
  await expect(page.locator(".home-tally")).toHaveCount(0);
  await expect(page.locator(".home-task")).toHaveCount(4);
  const late = page.locator(".home-task").filter({hasText: "Book a haircut"});
  // click(), not check(): the row is disabled the instant it is completed, and
  // check() waits for a checkbox it can still toggle.
  await late.getByLabel("Complete Book a haircut", {exact: true}).click();
  // It stays a moment, struck through, before it leaves — the same settle beat
  // as the day screen, so the tick is seen rather than the row just vanishing.
  await expect(late).toHaveClass(/is-done/);
  /* The tally is not asserted here: the pill is showing the meeting 18 minutes
   * away, which outranks the clock that carries it. The day screen's own test
   * covers the counting, under `?quiet`. */
  // The island is a BAR: one row, wider than it is tall.
  const bar = await page.locator("#island").boundingBox();
  expect(bar!.width).toBeGreaterThan(bar!.height * 3);
  // Each section opens the screen it summarises.
  await page.getByRole("button", {name: "Open Calendar"}).click();
  await expect(page.locator('[data-tab="calendar"]')).toHaveAttribute("aria-selected", "true");
  await page.screenshot({path: "test-results/island-home.png"});
});

test("Agents lists every session, whoever wants you first, and goes to it", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  /* The pill: the WAITING one, over the two that are working. Something
   * working needs nothing from you — but it is the only thing happening on
   * the machine, so it claims the strip when nothing is waiting, which a
   * later test covers. ⚠️ Not under `?quiet` — that fixture has no sessions
   * at all, on purpose, so the resting-clock tests are not competing with an
   * agent for the same strip. */
  await expect(page.locator(".pill-label")).toHaveText("akcesfonia");
  await expect(page.locator(".pill-value")).toHaveText(/waiting \d+m/);
  // What it has spent, quietly, where a countdown would be. See `Activity.count`.
  await expect(page.locator(".pill-count")).toHaveText("1.3M");

  await open(page);
  await goTo(page, "agents");

  /* ── A card each, in a grid ───────────────────────────────────────────
   * ⚠️ Cards in a COLUMN layout, not rows. A session's facts are short — a
   * name, a model, one figure — and a row each left two thirds of the width
   * empty while making the screen a line taller per session. */
  const cards = page.locator(".agent-card");
  await expect(cards).toHaveCount(4);
  // Ordered by who wants you, not by name, by agent, or by when they started.
  await expect(cards.nth(0)).toHaveClass(/is-waiting/);
  await expect(cards.nth(1)).toHaveClass(/is-working/);
  await expect(cards.nth(2)).toHaveClass(/is-working/);
  await expect(cards.nth(3)).toHaveClass(/is-idle/);

  await expect(cards.nth(0).locator(".agent-card-name")).toHaveText("akcesfonia");
  await expect(cards.nth(0).locator(".agent-model")).toHaveText("Opus 5");
  await expect(cards.nth(0).locator(".agent-branch")).toHaveText("master");
  // Every card wears its own agent's mark.
  await expect(page.locator(".agent-card-mark svg")).toHaveCount(4);

  /* ⚠️ No stage on this screen at all. The running session's details are what
   * the strip expands into; repeated here they pushed everything else — the
   * other sessions, the usage — below the fold of a screen whose job is the
   * overview. */
  await expect(page.locator(".agent-detail")).toHaveCount(0);

  /* A card opens the DETAIL rather than raising a window: on a tile this
   * small the whole thing is the target, and a tile that throws you into
   * another application is one you learn not to touch. */
  await cards.nth(0).click();
  const detail = page.locator(".agent-detail");
  await expect(detail).toHaveCount(1);
  await expect(detail.locator(".agent-detail-name")).toHaveText("akcesfonia");
  await expect(page.locator(".agent-card")).toHaveCount(0);

  // Going there is the second, deliberate step, and it is labelled.
  const go = detail.locator(".agent-detail-head");
  await expect(go).toHaveAttribute("aria-label", /Go to akcesfonia, waiting for you/);
  await go.click();
  await expect(page.locator(".screen-error")).toHaveCount(0);

  /* And back is back to the overview — from the ISLAND'S arrow, beside the
   * screen's name. ⚠️ Not a second arrow inside the panel: two of them four
   * millimetres apart are two answers to "how do I get out of this", and the
   * one in the header is where every other screen has already taught you to
   * look. */
  const arrow = page.locator("#island-back");
  await expect(arrow).toBeVisible();
  await expect(arrow).toHaveAttribute("aria-label", "All sessions");
  await arrow.click();
  await expect(page.locator(".agent-card")).toHaveCount(4);
  // And with nothing open it goes back to meaning nothing.
  await expect(arrow).toBeHidden();

  /* Snoozing is offered on the waiting session and NOT on the quiet one:
   * muting something that is already saying nothing is a control that does
   * nothing but make you wonder later what you switched off. */
  await cards.nth(0).click();
  await expect(detail.locator(".agent-snooze")).toHaveCount(1);
  await detail.locator(".agent-snooze").click();
  await expect(page.locator(".agent-detail.is-quiet")).toHaveCount(1);
  /* The pill goes to whatever it would otherwise show. ⚠️ Which is now the
   * OTHER agent — two of them are working — rather than the player: snoozing
   * one session does not snooze the rest of the machine. */
  await expect(page.locator(".pill-label")).toHaveText("2 agents working");
  await expect(page.locator(".pill-value")).toHaveText("codenotch-win");
  /* ⚠️ Said out loud, with a way back. The failure mode of a mute button is
     forgetting you pressed it and wondering for a week why the app went quiet.
     The palette command carries the count, and the settings window says it. */
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("snoozed");
  const back = page.locator(".palette-row").first();
  await expect(back.locator(".palette-title")).toHaveText("Bring back what is snoozed");
  await expect(back.locator(".palette-note")).toHaveText("1 quiet");
  await page.keyboard.press("Enter");
  await expect(page.locator(".agent-detail.is-quiet")).toHaveCount(0);
  await page.screenshot({path: "test-results/island-agents.png"});
});

test("a workspace is made from a row that is already on screen", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await page.keyboard.press("Control+k");
  const field = page.locator(".palette-field");
  const rows = page.locator(".palette-row");
  const titles = () => rows.locator(".palette-title").allTextContents();

  /* ⚠️ There is no workspace editor, and that is the design: a screen with a
   * folder picker and an app list is a form to fill in before the feature does
   * anything. The session already carries its own `cwd`, so making one is a
   * Tab and an Enter on a row that was going to be there anyway. */
  await field.fill("codenotch-win");
  await expect.poll(async () => (await titles())[0]).toBe("codenotch-win");
  await page.keyboard.press("Tab");
  expect(await titles()).toContain("Save as a workspace");
  await page.getByRole("option", {name: /Save as a workspace/}).click();
  await expect(page.locator(".palette")).toBeHidden();

  // It is then a thing you can reach by name.
  await page.keyboard.press("Control+k");
  await field.fill("codenotch-win");
  await expect.poll(async () => (await titles()).includes("codenotch-win")).toBe(true);
  const space = rows.filter({has: page.locator(".palette-note", {hasText: "workspace"})}).first();
  await expect(space).toHaveCount(1);

  /* An application is filed into it from the row that launches it — one row per
   * workspace rather than a picker, because a dialog to choose from a list
   * inside a list is the form this exists to avoid. */
  await field.fill("a Brave");
  await expect(page.locator(".palette-crumb")).toHaveText("Apps");
  await expect(rows.first().locator(".palette-title")).toHaveText("Brave");
  await page.keyboard.press("Tab");
  expect(await titles()).toContain("Add to codenotch-win");
  await page.getByRole("option", {name: /Add to codenotch-win/}).click();

  /* ⚠️ Saving the same folder twice is the SAME workspace, not a second one
   * with the same name — the folder is the id.
   *
   * ⚠️ Counted by NOTE, not by title. The live session for that folder is a row
   * called "codenotch-win" too, and it is a different thing you can do with the
   * same project — counting titles would call that a duplicate. */
  await page.keyboard.press("Control+k");
  await field.fill("codenotch");
  await expect.poll(() => rows.filter({
    has: page.locator(".palette-note", {hasText: /^workspace/}),
  }).count()).toBe(1);
  await page.screenshot({path: "test-results/island-workspace.png"});
});

test("what the agents cost is cut three ways, and the week says whether today is normal", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await goTo(page, "agents");

  /* ⚠️ The usage notch says the window is going; nothing on the machine
   * said what was eating it. That is the question you actually have when you
   * look at that ring, and this app is the only thing already counting tokens
   * per run — per agent, per model and per project. */
  await expect(page.locator(".spend-title")).toHaveText("Usage");
  await expect(page.locator(".spend-total")).toContainText("today");

  /* ── The week ────────────────────────────────────
   * Seven columns, so today has something to be bigger or smaller THAN — and
   * every day, including the ones nothing ran on. Built from the days that
   * have data, a week with three days off draws as three days of work in a
   * row, which is the opposite of what it claims. */
  const days = page.locator(".use-day");
  await expect(days).toHaveCount(7);
  await expect(days.nth(6)).toHaveClass(/is-today/);
  await expect(page.locator(".use-day.is-today")).toHaveCount(1);

  /* ⚠️ A path with a NaN in it draws NOTHING — no error, no warning, an
   * empty box where the chart was — which is the one failure mode of drawing
   * arithmetic into an attribute. */
  const line = await page.locator(".use-chart-line").getAttribute("d");
  expect(line).toBeTruthy();
  expect(line).not.toMatch(/NaN|Infinity|undefined/);
  // One curve per day, plus the flat runs out to either edge.
  expect((line!.match(/C/g) ?? [])).toHaveLength(6);

  /* Today's dot sits over today's label. ⚠️ Spread from edge to edge the
   * curve is a seventh of a week out of step with the names underneath it,
   * and nothing about the picture looks wrong. */
  const left = await page.locator(".use-chart-dot").evaluate(
    dot => (dot as HTMLElement).style.left);
  expect(parseFloat(left)).toBeGreaterThan(85);
  expect(parseFloat(left)).toBeLessThan(100);

  /* ── By agent, which is the cut this panel never had ───────────
   * "Where" was answered and "on what" never was, and the second one is the
   * half that costs money. */
  /* ⚠️ Two columns, and the week leads. Stacked, the same four blocks ran the
   * panel off the bottom of the island and every heading had to be found by
   * scrolling past the one above it. */
  const cuts = page.locator(".use-cut");
  await expect(cuts.nth(0)).toHaveText("This week");
  await expect(cuts.nth(1)).toHaveText("By agent");
  const agents = page.locator(".use-list").nth(0).locator(".use-row");
  await expect(agents.nth(0).locator(".use-who")).toHaveText("Claude");
  await expect(agents.nth(0).locator(".use-model")).toHaveText("Opus 5");
  await expect(agents.nth(1).locator(".use-who")).toHaveText("Codex");
  await expect(agents.nth(1).locator(".use-model")).toHaveText("GPT-6 Astra");
  // Each row wears the agent's own mark, the same one the cards do.
  await expect(agents.nth(0).locator(".use-mark svg")).toHaveCount(1);

  // And the projects, biggest spender first, whatever order the runs arrived in.
  await expect(cuts.nth(2)).toHaveText("By project");
  const projects = page.locator(".use-list").nth(1).locator(".use-name");
  await expect(projects.nth(0)).toHaveText("codenotch-win");
  await expect(projects.nth(1)).toHaveText("akcesfonia");

  const widths = await page.locator(".use-rail i").evaluateAll(bars =>
    bars.map(bar => (bar as HTMLElement).style.width));
  expect(widths.every(width => /^[\d.]+%$/.test(width))).toBe(true);

  /* ── What is left of the plan ─────────────────────────
   * ⚠️ One agent reports this and the other does not, so it is drawn from
   * whichever live session has it rather than from a row per agent: a "0% of
   * unknown" line for Claude would be an invention. */
  await expect(page.locator(".use-plan-name")).toContainText("Codex plus");
  await expect(page.locator(".use-plan-slot")).toHaveCount(2);
  await expect(page.locator(".use-plan-used").nth(0)).toHaveText("12%");
  await expect(page.locator(".use-plan-used").nth(1)).toHaveText("41%");
  await page.screenshot({path: "test-results/island-spend.png"});
});

test("a working session says what it is doing, and which agent is doing it", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await goTo(page, "agents");
  await page.locator(".agent-card").nth(1).click();

  const detail = page.locator(".agent-detail");
  await expect(detail).toHaveClass(/is-working/);
  await expect(detail.locator(".agent-detail-name")).toHaveText("codenotch-win");

  /* ⚠️ "Thinking" is not a fourth state — it is working with no tool out,
   * and it is the one thing a long turn can say for itself. Under a badge
   * reading "Working", two minutes of reasoning looks exactly like two
   * minutes of having hung. */
  await expect(detail.locator(".agent-live-state")).toHaveText("Thinking");

  /* ⚠️ What an agent is doing is a LIST, not a sentence. One phrase says
   * "running cargo test" and nothing about the four calls before it — which
   * is most of what somebody glancing at this wants, because it is the
   * difference between stuck and working through. */
  const steps = detail.locator(".agent-step");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toHaveText("reading nz_2.png");
  await expect(steps.nth(3)).toHaveText("running grep -n");

  /* ⚠️ Exactly ONE is in flight, and it is the last. A tool call and the
   * result that finishes it are two records minutes apart, joined only by
   * their id — lose that and every step reads as started and none as
   * finished, which is an agent that never gets anywhere. */
  await expect(detail.locator(".agent-step.is-now")).toHaveCount(1);
  await expect(steps.nth(3)).toHaveClass(/is-now/);
  await expect(detail.locator(".agent-step.is-done")).toHaveCount(3);

  /* The figures, with their units under them — and each of them ONCE. The
   * same two numbers abbreviated again four pixels lower read as two more
   * facts rather than as the same ones. */
  const facts = detail.locator(".agent-fact");
  await expect(facts.nth(0)).toContainText("512k");
  await expect(facts.nth(0)).toContainText("read");
  await expect(facts.nth(1)).toContainText("written");
  await expect(detail.locator(".agent-spend")).toHaveCount(0);
  await page.screenshot({path: "test-results/island-agents-steps.png"});
});

test("the strip expands into the session, and the rail into the overview", async ({page}) => {
  /* ⚠️ The whole point of the two layouts. You looked down, saw that
   * something was running and opened it: the thing you came for is that
   * session. Walking to the same screen from the rail is the other intent
   * entirely — which of them are there — and it must not land you inside one
   * session because the pill happened to be showing it. */
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await expect(page.locator(".agent-detail")).toHaveCount(1);
  await expect(page.locator(".agent-detail-name")).toHaveText("akcesfonia");

  await goTo(page, "today");
  await goTo(page, "agents");
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await expect(page.locator(".agent-card")).toHaveCount(4);
});

test("the other agent is read, and says so with its own mark", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await goTo(page, "agents");

  /* ⚠️ Codex was invisible here for as long as this screen existed — not
   * because the screen was wrong about it, but because the watcher only ever
   * read `~/.claude`. Both agents now, told apart by their own marks. */
  const codex = page.locator(".agent-card").filter({hasText: "esono-price-watch"});
  await expect(codex).toHaveCount(1);
  await expect(codex.locator(".agent-model")).toHaveText("GPT-6 Astra");
  await codex.click();

  const detail = page.locator(".agent-detail");
  await expect(detail.locator(".agent-agent")).toHaveText("Codex");
  await expect(detail.locator(".agent-detail-mark svg")).toHaveCount(1);

  /* ⚠️ And it is reachable, with no pid to reach it by: every Codex thread
   * runs inside one process that owns no window, so the row hands the project
   * name over instead and the window is found by its title. */
  await detail.locator(".agent-detail-head").click();
  await expect(page.locator(".screen-error")).toHaveCount(0);

  /* The pager covers the LIVE sessions, so the two that are working and the
   * one that is waiting can be read one after another without going back. */
  const dots = page.locator(".agent-dot");
  await expect(dots).toHaveCount(3);
  await dots.nth(0).click();
  await expect(detail.locator(".agent-detail-name")).toHaveText("akcesfonia");
});

test("click mode: leaving does not close it, and the pill carries a control", async ({page}) => {
  await page.goto("/tasks.html?nocal&click&noagents");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.open)).toBe("click");

  // Pointing at it does nothing. That half already worked.
  const pill = (await page.locator("#island").boundingBox())!;
  await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await page.waitForTimeout(400);
  await expect(page.locator("#island-expanded")).toBeHidden();

  await page.locator("#island-collapsed").click();
  await expect(page.locator("#island-expanded")).toBeVisible();

  /* ⚠️ This is the whole of click mode, and it was the half that was missing.
     `openOnHover: false` only ever stopped the panel OPENING under the
     pointer — the fold timer was armed on every leave regardless, so the panel
     still shut the moment the pointer wandered off, which is precisely what
     somebody turning hover off is trying to stop. */
  await page.mouse.move(4, 690);
  // Twice the old 450ms fold delay, so a timer that is still armed has fired.
  await page.waitForTimeout(1100);
  await expect(page.locator("#island-expanded")).toBeVisible();

  /* And something still ends it. In the app that is a click anywhere else,
     seen natively (`island:dismiss` — hover.rs), which a preview cannot
     produce: the island is click-through out there and the event never
     reaches a page. Escape is the same exit through the same code. */
  await page.keyboard.press("Escape");
  await expect(page.locator("#island-expanded")).toBeHidden();

  /* The pill can hold a control now, because the pointer resting on it no
     longer means "open". The bars are decoration until hovered, then they are
     play/pause. */
  const eq = page.locator(".pill-eq");
  await expect(eq).toHaveCSS("pointer-events", "auto");
  await expect.poll(() => eq.locator(".pill-eq-mark").evaluate(el => getComputedStyle(el).opacity)).toBe("0");
  await eq.hover();
  await expect.poll(() => eq.locator(".pill-eq-mark").evaluate(el => getComputedStyle(el).opacity)).toBe("1");
  // ⚠️ And pressing it must not open the island: a play/pause that also
  // expands the panel is a control you can only use once.
  await eq.click();
  await expect(page.locator("#island-expanded")).toBeHidden();
  await page.screenshot({path: "test-results/island-click-mode.png"});
});

test("the player is a screen only while there is a player, and the queue is closed until asked", async ({page}) => {
  await page.goto("/tasks.html?nocal");
  await open(page);

  /* ⚠️ The tab exists only while something is playing. A permanent tab
     holding a title and three buttons is what got the last one removed; this
     one carries the playhead and the queue, and appears with the first track. */
  const tab = page.locator('.rail-stop[data-tab="media"]');
  await expect(tab).toHaveCount(1);
  await goTo(page, "media");

  await expect(page.locator(".media-title")).toHaveText(/potion shop/);
  // The source, never a fabricated "explicit" badge: Windows' transport
  // session carries no such flag, and a badge that is always on is decoration
  // claiming to be data.
  await expect(page.locator(".media-badge")).toHaveText("Brave");
  // Elapsed on the left, REMAINING on the right — the total is the same number
  // every time you look at it.
  await expect(page.locator(".media-left")).toHaveText(/^-\d+:\d{2}$/);

  /* Closed by default, and the panel is narrower for it.
     ⚠️ The panel is IN THE DOM when closed — it has to be, or there is
     nothing to animate on the way out. Closed means a zero-width column. */
  const column = () => page.locator(".media-queue").evaluate(el => el.getBoundingClientRect().width);
  await expect(page.locator(".media-queue")).toHaveCount(1);
  await expect.poll(column).toBe(0);
  await expect(page.locator(".media-queue")).toHaveAttribute("aria-hidden", "true");
  /* ⚠️ Settled, not sampled. The width is sprung, so a measurement taken on
     the frame the tab was pressed is some arbitrary point on the way there —
     which then makes every comparison against it meaningless. */
  const settle = async () => {
    let last = -1, same = 0;
    for (let i = 0; i < 60 && same < 3; i++) {
      const width = Math.round((await page.locator("#island").boundingBox())!.width);
      same = width === last ? same + 1 : 0;
      last = width;
      await page.waitForTimeout(50);
    }
    return last;
  };
  const shut = await settle();

  /* ⚠️ Watched all the way, not checked at both ends. Everything about this
     gesture was wrong in a way the endpoints agreed on: the panel's contents
     were sized and placed at their FINAL width on the first frame while only
     the black shape animated, so the whole player snapped and the queue
     appeared. Two things have to hold across the frames in between — the
     player never changes width, and it travels. */
  const frame = () => page.evaluate(() => {
    const now = document.querySelector(".media-now")!.getBoundingClientRect();
    const queue = document.querySelector(".media-queue")!.getBoundingClientRect();
    return { player: Math.round(now.width), left: Math.round(now.left), queue: Math.round(queue.width) };
  });

  const opening = page.getByRole("button", {name: "Playing next", exact: true}).click();
  const seen: Awaited<ReturnType<typeof frame>>[] = [];
  for (let i = 0; i < 9; i++) { seen.push(await frame()); await page.waitForTimeout(70); }
  await opening;
  await expect(page.locator(".media-queue-head")).toHaveText("Playing Next");
  await expect.poll(column).toBeGreaterThan(200);

  // The controls keep their size, so nothing inside them re-lays out. As a
  // `1fr` track they were sized by whatever was left over, and the transport
  // row is `space-between` — its buttons crawled apart and back every frame.
  expect(new Set(seen.map(f => f.player)).size).toBe(1);
  // And they MOVE, rather than arriving where they finish. The island is
  // centred on its edge, so growing pushes its left edge out and the player
  // rides it.
  expect(new Set(seen.map(f => f.left)).size).toBeGreaterThan(2);
  expect(seen[0].left).toBeGreaterThan(seen[seen.length - 1].left);
  // The queue widens over the same frames rather than appearing.
  expect(new Set(seen.map(f => f.queue)).size).toBeGreaterThan(2);
  await expect(page.locator(".media-track")).toHaveCount(6);
  // A track with no cover is still a row: artwork is the one field Spotify
  // legitimately omits.
  await expect(page.locator(".media-track-art.blank")).toHaveCount(6);

  /* ⚠️ Three rows, then the LIST scrolls — and only the list. A Spotify
     queue is routinely twenty tracks, and a panel that grows to fit one is a
     notch the height of a window. The list clips; nothing above it moves. */
  const list = page.locator(".media-queue-list");
  await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight + 1)).toBe(true);
  expect(await list.evaluate(el => Math.round(el.clientHeight))).toBeLessThan(150);
  /* ⚠️ And the CLOSED panel is not as tall as the open one. A column clipped
     to nothing still reports its content's height, and the island's measure
     adds a clipping child's hidden pixels back in — so without discounting
     zero-width children the closed player measured as tall as the open one. */
  // The screen itself does not scroll to make room for it.
  expect(await page.locator("#media-body")
    .evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

  /* Something can be put on the END of the queue. ⚠️ The end and nothing
     else: Spotify's Web API has no endpoint for reordering a queued item,
     removing one, or inserting at a position, so there is no handle offered
     for it. See TODO.md. */
  await page.getByRole("button", {name: "Add to the queue", exact: true}).click();
  const field = page.getByRole("searchbox", {name: "Search Spotify"});
  await expect(field).toBeFocused();
  await field.fill("carter");
  await expect(page.locator(".media-result")).toHaveCount(1);
  await page.locator(".media-result").click();
  await expect(page.locator(".media-said")).toContainText("Queued Mr. Carter");
  await expect.poll(async () => (await page.locator("#island").boundingBox())!.width)
    .toBeGreaterThan(shut + 100);
  await settle();
  await page.screenshot({path: "test-results/island-player.png"});

  // And it folds back to the narrow panel.
  await page.getByRole("button", {name: "Playing next", exact: true}).click();
  await expect.poll(column).toBe(0);
  /* ⚠️ Within a pixel, not equal to it. The width is a spring: it settles
     when it is within 0.01 of its target, which rounds to either side. */
  expect(Math.abs(await settle() - shut)).toBeLessThanOrEqual(2);

  /* ⚠️ With nothing playing there is no tab — and if it goes while you are
     looking at it, the shell moves you home rather than sitting on a hidden
     tab showing an empty screen. */
  await page.goto("/tasks.html?quiet");
  await open(page);
  await expect(page.locator('[data-tab="media"]')).toBeHidden();
});

test("the palette closes with the control that opened it, however fast it is pressed", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  const palette = page.locator(".palette");
  /* ⚠️ The KEY, not the header button. Opening the palette takes the panel
     behind it out of sight, header included — which is the whole reason the
     shortcut has to be able to close it. In the preview `island:palette` is a
     native event that never fires, so the island answers Ctrl+K itself; see
     the `preview` guard in tasks.ts. */
  const key = () => page.keyboard.press("Control+k");

  await key();
  await expect(palette).toBeVisible();
  // ⚠️ The key that opens it closes it. It used to re-select the field, which
  // left Escape — aimed at a window that may never have taken focus — as the
  // only way out of a palette opened from inside another application.
  await key();
  await expect(palette).toBeHidden();

  /* Pressed twice before the first has finished.
     ⚠️ This does NOT reproduce the interleaving it is named for, and saying
     so is the point: in the preview `set_task_input` returns immediately and
     `grab()` gets the caret on its first frame, so there is no window for the
     two halves to overlap in. Removing the queue in palette.ts leaves this
     test green — checked. What it does cover is that two fast presses still
     end closed, and that the palette works afterwards, which is where a
     swallowed press or a listener removed after a re-open would show. */
  await Promise.all([key(), key()]);
  await expect(palette).toBeHidden();
  // And it still opens afterwards: a queue that swallowed a press, or a
  // listener removed after the re-open added it, both show up here.
  await key();
  await expect(palette).toBeVisible();
  await expect(page.locator(".palette-field")).toBeFocused();

  // Escape still means "one level back, then out".
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  /* The island can fold again. ⚠️ This is the symptom the interleaving caused:
     `editing` blocks folding outright, so a stranded `input(true)` is a panel
     that never closes and no visible reason why. */
  await page.mouse.move(2, 690);
  await expect(page.locator("#island-expanded")).toBeHidden();
});

test("the accent is one variable, and nothing is still painted green", async ({page}) => {
  await page.goto("/tasks.html?nocal");
  await open(page);

  const today = page.locator(".home-day.is-today");
  const before = await today.evaluate(el => getComputedStyle(el).backgroundColor);

  /* ⚠️ The whole sheet, not a list of the places that were wrong. Thirty-two
     declarations said `#00ff88`, `#22ff9a` or `rgba(0,255,136,…)` while the
     accent was settable from the settings window — so a purple accent bought a
     purple tab strip and left green hovers, a green today-cell on Home and a
     green focus ring. Auditing by eye is what missed them the first time. */
  /* ⚠️ `!important`, in a sheet, rather than an inline write on the root.
   * `applyPrefs` sets the accent inline on every render — so a test that wrote
   * it the same way was in a race with the app, and any redraw between the
   * write and the scan put the default green back. It passed for as long as
   * nothing happened to redraw during it, which is not a property of the
   * thing being tested. */
  await page.addStyleTag({content: ":root { --accent: #a78bfa !important; }"});

  await expect.poll(() => today.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(before);

  /* ⚠️ POLLED, because colour is TRANSITIONED. Half the controls here animate
   * `background-color` over 150ms, so a scan taken the instant the accent
   * changes catches them part way between the old green and the new purple
   * and reports the start of the journey as a hardcoded colour. The question
   * is what the sheet settles on. */
  const scan = () => page.evaluate(() => {
    const hits: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      for (const prop of ["backgroundColor", "color", "borderColor", "boxShadow", "backgroundImage", "outlineColor"] as const) {
        const value = style[prop];
        // The default accent, in every form a computed style writes it.
        if (/rgba?\(\s*0,\s*255,\s*136/.test(value)) hits.push(`${el.className || el.tagName} ${prop}: ${value}`);
      }
    }
    return hits;
  });
  await expect.poll(scan, {timeout: 4000}).toEqual([]);

  /* And a hover is the same colour as the thing it lights up. `#22ff9a` was a
     hand-mixed lighter green that no longer had anything to do with the accent
     it was supposed to be a hover state for. */
  await page.evaluate(() => {
    const probe = document.createElement("button");
    probe.className = "raised is-accent";
    probe.id = "accent-probe";
    document.body.append(probe);
  });
  const hover = await page.evaluate(() => getComputedStyle(document.getElementById("accent-probe")!).backgroundColor);
  expect(hover).not.toMatch(/rgba?\(\s*0,\s*255,\s*136/);
});

test("the palette searches the island's own world and acts on it", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await page.keyboard.press("Control+k");
  const field = page.locator(".palette-field");
  await expect(field).toBeFocused();

  /* Subsequence, not substring: three letters have to get you there, or the
   * palette is a filter rather than a launcher. */
  await field.fill("agt");
  await expect(page.locator(".palette-row").first().locator(".palette-title")).toHaveText("Agents");
  /* The characters that matched are lit, and they are the ones typed. ⚠️ The
   * count of <b> elements is NOT the count of matched characters: consecutive
   * hits are grouped into one run, so "agt" against "Agents" lights "Ag" and
   * "t" — two elements, three letters. The text is what means something. */
  expect((await page.locator(".palette-row").first().locator(".palette-title b").allTextContents()).join(""))
    .toBe("Agt");

  // It reaches things a general launcher cannot see: the live sessions.
  await field.fill("akces");
  const titles = await page.locator(".palette-row .palette-title").allTextContents();
  expect(titles).toContain("akcesfonia");

  // Arrow keys move one highlight, and only one.
  await field.fill("");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".palette-row.is-at")).toHaveCount(1);
  await expect(page.locator(".palette-row").nth(1)).toHaveClass(/is-at/);
  // Wraps rather than running off the end.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".palette-row").last()).toHaveClass(/is-at/);

  /* Anything typed is offered as a task, but only past three characters:
   * a "create" row on every stray keystroke turns a mistyped search into an
   * accidental task. */
  await field.fill("bu");
  expect(await page.locator(".palette-row .palette-title").allTextContents())
    .not.toContain('Add task "bu"');
  await field.fill("buy milk");
  expect(await page.locator(".palette-row .palette-title").allTextContents())
    .toContain('Add task "buy milk"');

  // Enter runs the selection and closes: a palette left over the result is
  // something you have to dismiss to see what you asked for.
  await field.fill("today");
  await page.keyboard.press("Enter");
  await expect(page.locator(".palette")).toBeHidden();
  await expect(page.locator('.rail-stop[data-tab="today"]')).toHaveAttribute("aria-selected", "true");

  // Escape closes without running anything.
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette")).toBeHidden();

  /* ⚠️ The pin is never touched. `surface.pin()` is a toggle on a
   * user-facing latch, and three callers used to flip it around one open — so
   * the island came back pinned and stayed open until it was unpinned by hand.
   * Holding the panel while it has the caret is `editing`'s job. */
  await expect(page.getByRole("button", {name: "Pin the island open", exact: true}))
    .toHaveAttribute("aria-pressed", "false");

  /* Narrower while it is up, whatever the screen behind it was: a list of
   * one-line results in a panel sized for a bento reads as a window someone
   * left open. */
  const full = (await page.locator("#island").boundingBox())!.width;
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette")).toBeVisible();

  /* ⚠️ And the panel behind it is out of sight, not merely covered. It had a
   * `backdrop-filter`, which on a child of the solid-black island samples the
   * island's OWN contents rather than the desktop — so the search showed the
   * tab strip and the day smeared through it, reading as two stacked surfaces
   * rather than one. */
  await expect(page.locator(".island-head")).toBeHidden();
  await expect(page.locator(".screens")).toBeHidden();

  await expect.poll(async () => (await page.locator("#island").boundingBox())!.width)
    .toBeLessThan(full);
  await expect.poll(async () => Math.round((await page.locator("#island").boundingBox())!.width))
    .toBe(Math.round(capped(FRAME.islandPaletteLong)));
  await page.screenshot({path: "test-results/island-palette.png"});

  /* A click anywhere else closes it. It used to be closable only by RUNNING
   * something: the keys were bound to the field, so with the caret not yet
   * arrived Escape did nothing either. */
  await page.mouse.click(12, 620);
  await expect(page.locator(".palette")).toBeHidden();
});

test("the palette does arithmetic, goes a level deeper, and learns", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await page.keyboard.press("Control+k");
  const field = page.locator(".palette-field");
  const rows = page.locator(".palette-row");

  /* The one thing a launcher gets used for that has nothing to do with
   * launching. ⚠️ It ranks FIRST: when a line is a sum it is never also a
   * search, which is why `calc` insists on both a digit and an operator. */
  await field.fill("1900 * 56/117");
  await expect(rows.first().locator(".palette-title")).toHaveText("= 909.401709402");
  await expect(rows.first().locator(".palette-note")).toHaveText("copy the result");
  // And a line that is not arithmetic grows no such row.
  await field.fill("today");
  await expect(rows.first().locator(".palette-title")).not.toHaveText(/^=/);

  /* ── And money, beside it ─────────────────────────────────
   * The other thing a launcher is used for that has nothing to do with
   * launching. ⚠️ The rates are asked for ONCE and held — the row is live
   * rather than instant because of that one fetch, so this polls. */
  await field.fill("120 usd to pln");
  const money = rows.first();
  await expect.poll(async () => money.locator(".palette-title").textContent())
    .toBe("= 455.50 PLN");
  /* What it was worked out from, and WHEN. ⚠️ The date is not decoration:
   * these are daily reference rates, so an answer on a Sunday is Friday's
   * number and a converter that hides that is one you cannot check. */
  await expect(money.locator(".palette-note")).toHaveText("120 USD at 3.796 · 17 Sep");

  // The same sentence, written the way a hand in a hurry writes it.
  await field.fill("$120 zl");
  await expect.poll(async () => rows.first().locator(".palette-title").textContent())
    .toBe("= 455.50 PLN");

  /* ⚠️ And almost everything else is left alone. Anything that parses puts
   * a row at the TOP of the results, so the grammar saying no is the half of
   * the feature that decides whether the palette is still usable. */
  await field.fill("notes");
  await expect(rows.first().locator(".palette-title")).not.toHaveText(/^=/);

  /* Tab opens a row's own verbs. ⚠️ The mark is DRAWN as well as bound, since
   * a key nobody can see is a feature nobody uses. */
  await field.fill("setup");
  await expect(rows.first().locator(".palette-title")).toHaveText(/setup/);
  await expect(rows.first().locator(".palette-more")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.locator(".palette-crumb")).toBeVisible();
  const verbs = await rows.locator(".palette-title").allTextContents();
  expect(verbs).toContain("Open");
  expect(verbs).toContain("Show in folder");
  expect(verbs).toContain("Take off the shelf");

  /* ⚠️ Escape backs out one level before it closes anything. A sub-menu you
   * can only leave by dismissing the whole palette is a trap. */
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette-crumb")).toBeHidden();
  await expect(page.locator(".palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette")).toBeHidden();

  /* What you actually use comes first. ⚠️ This is the EMPTY query — the state
   * the palette is in every time it opens, and the one that had no opinion at
   * all before: it listed the providers in declaration order for ever. */
  await page.keyboard.press("Control+k");
  const before = await rows.first().locator(".palette-title").textContent();
  expect(before).not.toBe("Review");
  await field.fill("review");
  await page.keyboard.press("Enter");
  await expect(page.locator(".palette")).toBeHidden();

  await page.keyboard.press("Control+k");
  await expect(rows.first().locator(".palette-title")).toHaveText("Review");
  await page.screenshot({path: "test-results/island-palette-deep.png"});
});

test("ranking prefers the thing you named, and a scope narrows it", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await page.keyboard.press("Control+k");
  const field = page.locator(".palette-field");
  const rows = page.locator(".palette-row");
  const titles = () => rows.locator(".palette-title").allTextContents();

  /* ⚠️ The case that broke the hard bands. `hero` used to put "Hide the
   * chrome" — a real subsequence match, in a higher band — above a folder
   * actually called `hero`, and nothing about match quality could get past the
   * band. Bands are a preference now; an exact match is not. */
  await field.fill("hero");
  await expect.poll(async () => (await titles())[0]).toBe("hero");

  /* And the band still decides between things that match about as well: `n`
   * alone reaches an application before it reaches the disk. */
  await field.fill("notion");
  await expect(rows.first().locator(".palette-title")).toHaveText("Notion");

  /* ⚠️ A row built out of the query cannot be ranked against the query.
   * `Add task "agt"` contains `agt` verbatim, so it collected a substring bonus
   * on every query it appeared for and outranked Agents for its own initials. */
  await field.fill("agt");
  await expect(rows.first().locator(".palette-title")).toHaveText("Agents");
  expect(await titles()).toContain('Add task "agt"');

  /* A typed prefix narrows to one band — the honest answer to "sometimes I
   * want a strict filter": ask for it on one query, rather than make it a rule
   * that applies whether or not you meant it. */
  await field.fill("a ");
  await expect(page.locator(".palette-crumb")).toHaveText("Apps");
  // ⚠️ The prefix LEAVES the field: left in, every provider would see it and
  // backspacing over it would change what the results mean with nothing having
  // visibly moved.
  await expect(field).toHaveValue("");
  await field.fill("code");
  await expect(rows.first().locator(".palette-title")).toHaveText("Visual Studio Code");
  expect(await titles()).not.toContain("Agents");

  // Backspace on an empty field sheds the scope, one level at a time.
  await field.fill("");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".palette-crumb")).toBeHidden();

  await field.fill("f hero");
  await expect(page.locator(".palette-crumb")).toHaveText("Files");
  await expect.poll(async () => (await titles()).length).toBeGreaterThan(0);
  expect(await titles()).not.toContain("Hide the chrome");
  await page.screenshot({path: "test-results/island-palette-scope.png"});
});

test("a star keeps something, and keeps it in the empty list", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await page.keyboard.press("Control+k");
  const field = page.locator(".palette-field");
  const rows = page.locator(".palette-row");
  const titles = () => rows.locator(".palette-title").allTextContents();

  /* ⚠️ Starring a FOLDER is the point of the whole thing: once kept, it is two
   * keystrokes away for ever, with no round trip to Everything and no need for
   * it to be running. That only works because a star stores a snapshot of the
   * row rather than an id — nothing enumerates the disk on an empty query. */
  await field.fill("hero");
  await expect.poll(async () => (await titles())[0]).toBe("hero");
  await page.keyboard.press("Tab");
  await expect(page.locator(".palette-crumb")).toHaveText("hero");
  const verbs = await titles();
  expect(verbs).toContain("Star this");
  // The star is added by the palette, not by each provider, so a row with no
  // verbs of its own still has a Tab menu.
  await page.getByRole("option", {name: /Star this/}).click();
  await expect(page.locator(".palette")).toBeHidden();

  await page.keyboard.press("Control+k");
  // Empty query: the kept thing is there, and marked.
  await expect.poll(async () => (await titles()).includes("hero")).toBe(true);
  const kept = rows.filter({hasText: "hero"}).first();
  await expect(kept.locator(".palette-star")).toHaveCount(1);

  // And it unstars from the same place.
  await kept.hover();
  await page.keyboard.press("Tab");
  expect(await titles()).toContain("Remove the star");
  await page.screenshot({path: "test-results/island-palette-star.png"});
});

test("notes: one key to write one, and the pile stays findable", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await goTo(page, "notes");

  const rows = page.locator(".note-card");
  await expect(rows).toHaveCount(5);

  /* ⚠️ Enter SAVES; Shift+Enter is a newline. A quick note is one key or it
     is not quick — a textarea whose Enter does nothing is the shape every
     "notes" box has, which is why nobody uses them for one line. */
  const field = page.getByLabel("Note", {exact: true});
  await field.fill("Passport expires March");
  await field.press("Enter");
  await expect(rows).toHaveCount(6);
  // Newest first, and the field is empty again rather than holding what was
  // just saved — a second Enter would otherwise save it twice.
  await expect(rows.first()).toContainText("Passport expires March");
  await expect(field).toHaveValue("");

  await field.fill("first line");
  await field.press("Shift+Enter");
  await field.type("second line");
  await field.press("Enter");
  await expect(rows).toHaveCount(7);
  await expect(rows.first()).toContainText("first line");
  await expect(rows.first()).toContainText("second line");

  /* ⚠️ The markers are a FORMAT, not part of the text. The note is stored as
     what you typed — greppable, and safe to paste somewhere else — and the
     markers are read on the way out. */
  await field.fill("# Shopping\n- **milk** and bread\n- *maybe* eggs\n\n1. first\n2. second");
  await field.press("Enter");
  const shopping = rows.first();
  await expect(shopping.locator("h4")).toHaveText("Shopping");
  await expect(shopping.locator("ul li")).toHaveCount(2);
  await expect(shopping.locator("ol li")).toHaveCount(2);
  await expect(shopping.locator("strong")).toHaveText("milk");
  await expect(shopping.locator("em")).toHaveText("maybe");
  // The markers themselves are gone from what is drawn.
  await expect(shopping).not.toContainText("**");

  /* ⚠️ Bold wraps the SELECTION and leaves the caret inside the markers, or
     pressing bold and typing produces `**` followed by unbolded words. */
  await field.fill("plain words");
  await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 11));
  await page.getByLabel("Bold", {exact: true}).click();
  await expect(field).toHaveValue("plain **words**");
  await page.getByLabel("List", {exact: true}).click();
  await expect(field).toHaveValue("- plain **words**");
  await field.press("Enter");
  await expect(rows.first().locator("li strong")).toHaveText("words");

  /* ⚠️ Accents folded both ways. Half of what gets written down on this
     machine is Polish, and a search that only matches if you reproduce the
     diacritics is one you have to know the answer to use. */
  const search = page.getByLabel("Search notes");
  await search.fill("krakow");
  await expect(rows).toHaveCount(1);
  await expect(page.locator(".note-hit")).toHaveText("Krakow");
  await expect(page.locator(".note-count")).toHaveText(/1 of \d/);

  // Every word, anywhere, in any order — you remember a note as a few words,
  // not as a phrase.
  await search.fill("pi ssh");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("ssh key");
  /* ⚠️ Three, not two — `pi` is inside `expires` as well, and that is the
     right trade rather than a miss. Matching on word boundaries would stop
     `krak` finding `Krakowie`, and typing a prefix is how anyone actually
     searches a pile of their own writing. */
  /* ⚠️ Search runs on the plain text, so `milk` finds a note that says
     `**milk**`. On the raw body it would only be found by typing the markers,
     which is the one query nobody would use. */
  await search.fill("milk");
  await expect(rows).toHaveCount(1);
  /* ⚠️ "At least", not an exact count. `pi` is inside `expires` and inside
     `Shopping`, which is the right trade rather than a miss — matching on word
     boundaries would stop `krak` finding `Krakowie`, and typing a prefix is how
     anyone searches a pile of their own writing. An exact number here would
     also be a count of what earlier steps in this test happened to add. */
  await search.fill("pi");
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator(".note-card", {hasText: "Raspberry"})).toHaveCount(1);
  await search.fill("zzz");
  await expect(page.locator(".note-none")).toBeVisible();
  await search.fill("");

  /* Pressing a note opens it for editing, and the row says so — otherwise the
     composer has silently taken a row's contents and the row still reads as
     untouched. */
  const before2 = await rows.count();
  await rows.first().locator(".note-open").click();
  await expect(page.locator(".note-card.is-editing")).toHaveCount(1);
  // ⚠️ The MARKERS come back into the field, not the rendered text: editing a
  // note has to give you back exactly what you wrote.
  await expect(field).toHaveValue(/^- plain \*\*words\*\*$/);
  await field.fill("edited in place");
  await field.press("Enter");
  await expect(rows).toHaveCount(before2);
  await expect(rows.first()).toContainText("edited in place");
  await expect(page.locator(".note-card.is-editing")).toHaveCount(0);

  /* ⚠️ A note is arbitrary text the user pasted from somewhere, and the one
     thing you must not do with that is hand it to a parser. */
  await field.fill('<img src=x onerror="alert(1)"> pasted');
  await field.press("Enter");
  await expect(rows.first()).toContainText('<img src=x onerror="alert(1)"> pasted');
  await expect(page.locator(".note-wall img")).toHaveCount(0);

  await page.screenshot({path: "test-results/island-notes.png"});

  /* A note can be stuck to the desktop. ⚠️ The pin stays lit while the other
     two tools wait for the pointer — otherwise the only way to know which of
     nine notes is on your desktop is to go and look at the desktop. */
  await rows.first().hover();
  await rows.first().getByLabel("Pin to the desktop").click();
  await expect(rows.first()).toHaveClass(/is-pinned/);
  await expect.poll(() => rows.first().locator(".note-pin")
    .evaluate(el => getComputedStyle(el).opacity)).toBe("1");
  await rows.first().getByLabel("Unpin").click();
  await expect(rows.first()).not.toHaveClass(/is-pinned/);

  // Delete takes it back off the pile.
  const before = await rows.count();
  await rows.first().hover();
  await rows.first().getByLabel("Delete note").click();
  await expect(rows).toHaveCount(before - 1);
});

test("a pinned note is the same note, in a window of its own", async ({page}) => {
  /* The sticky window is its own page — one per pinned note, told which it is
     by `?id`. It reads and writes through the same commands the island does,
     so this is a second window onto one store, not a second copy. */
  await page.setViewportSize({width: 240, height: 240});
  await page.goto("/note.html?id=n1");

  await expect(page.locator(".note-body")).toContainText("ssh key for the pi");
  // The same formatter as the wall: markers are read, not shown.
  await expect(page.locator(".sticky-open")).not.toContainText("**");

  /* ⚠️ A drag STRIP, not the whole window. `data-tauri-drag-region` on the
     body would make every press a drag — and the body is what you click to
     edit, so the note would be unwritable and it would look like the click
     doing nothing. */
  await expect(page.locator(".sticky-bar[data-tauri-drag-region]")).toHaveCount(1);
  await expect(page.locator(".sticky-open[data-tauri-drag-region]")).toHaveCount(0);

  // Pressing the paper opens it for editing, with the markers back.
  await page.locator(".sticky-open").click();
  const field = page.getByLabel("Note", {exact: true});
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(/ssh key for the pi/);

  // Escape leaves it alone rather than saving.
  await field.fill("changed my mind");
  await page.keyboard.press("Escape");
  await expect(page.locator(".note-body")).toContainText("ssh key for the pi");
  await page.screenshot({path: "test-results/sticky-note.png"});
});

test("the shelf parks things and hands them back", async ({page}) => {
  await page.goto("/tasks.html?nocal");
  await open(page);
  await goTo(page, "shelf");
  const rows = page.locator(".shelf-card");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0).locator(".shelf-name")).toHaveText("Codenotch_0.1.0_x64-setup.exe");
  // Format and size, now there is a card with room for both.
  await expect(rows.nth(0).locator(".shelf-note")).toHaveText("EXE · 4.8 MB");
  await expect(rows.nth(1).locator(".shelf-note")).toHaveText("link");
  // A pasted wall of text is one line, not the row.
  await expect(rows.nth(2).locator(".shelf-name")).toHaveText("Traceback (most recent call last):");

  /* ⚠️ A file the shelf no longer has is SHOWN, not hidden. Referencing rather
   * than copying is what makes a shelf cheap; being honest when the reference
   * breaks is the price, and a row that silently vanished would look like the
   * shelf losing things. */
  await expect(rows.nth(3)).toHaveClass(/is-missing/);
  await expect(rows.nth(3).locator(".shelf-note")).toHaveText("moved or deleted");
  // It offers removal and nothing else: a button that cannot work is worse
  // than no button.
  await expect(rows.nth(3).locator(".shelf-do")).toHaveCount(1);
  await expect(rows.nth(0).locator(".shelf-do")).toHaveCount(4);

  // Copy leads, because taking a file out of this shelf IS a clipboard copy.
  await expect(rows.nth(0).locator(".shelf-do").first()).toHaveAttribute("aria-label", /^Copy /);
  await page.screenshot({path: "test-results/island-shelf.png"});
});

test("the shelf is cards, and a card says what the thing is", async ({page}) => {
  await page.goto("/tasks.html?agents");
  await open(page);
  await goTo(page, "shelf");

  /* ⚠️ A card, not a row. What is on the shelf is mostly files, and a file is
   * something you recognise — a shape, an extension — long before you read its
   * name. A row gave the name a whole line and everything else six grey pixels
   * at the end of it. */
  const cards = page.locator(".shelf-card");
  await expect(cards.first()).toBeVisible();
  const shape = await cards.first().evaluate(card => {
    const box = card.getBoundingClientRect();
    return {
      wide: box.width,
      tall: box.height,
      plinth: !!card.querySelector(".shelf-plinth"),
      note: card.querySelector(".shelf-note")?.textContent ?? "",
      ext: card.querySelector(".shelf-ext")?.textContent ?? "",
    };
  });
  // Square-ish: taller than wide, but nothing like a row.
  expect(shape.wide).toBeLessThan(200);
  expect(shape.tall / shape.wide).toBeGreaterThan(0.8);
  expect(shape.tall / shape.wide).toBeLessThan(1.8);
  expect(shape.plinth).toBe(true);
  // Format AND size, which a row had no room for.
  expect(shape.note).toMatch(/^[A-Z0-9]{2,5} · /);
  expect(shape.ext).toMatch(/^[A-Z0-9]{2,5}$/);

  /* ⚠️ And they lay out ACROSS, not down. Cards dropped straight into the
   * screen body come out one per row at full width — which is the list this
   * replaced, with bigger pictures. */
  const across = await page.locator(".shelf-card").evaluateAll(all =>
    new Set(all.map(c => Math.round(c.getBoundingClientRect().top))).size);
  expect(across).toBe(1);
});

test("a shelved file shows its real preview, and the rest keep their glyph", async ({page}) => {
  await page.goto("/tasks.html?agents");
  await open(page);
  await goTo(page, "shelf");

  /* ⚠️ The glyph is drawn FIRST and replaced only if a picture arrives.
   * Waiting for the answer before drawing anything gives a shelf of empty
   * squares for as long as the shell takes — and most files have no preview at
   * all, so for most cards the wait would never end in anything. */
  await expect(page.locator(".shelf-card")).toHaveCount(4);
  await expect.poll(() => page.locator(".shelf-shot").count()).toBe(1);

  const shot = page.locator(".shelf-shot").first();
  /* It fills the plinth rather than being letterboxed into it: a preview is a
   * sample, and a photograph with two grey bars is a worse sample than a crop. */
  const fit = await shot.evaluate(el => ({
    fit: getComputedStyle(el).objectFit,
    covers: el.getBoundingClientRect().width > 80,
  }));
  expect(fit.fit).toBe("cover");
  expect(fit.covers).toBe(true);

  /* ⚠️ The extension chip stays ON TOP of it. The picture is appended after
   * the chip, so without a stacking order it covers the one thing that says
   * what the file is. */
  await expect(page.locator(".shelf-card").first().locator(".shelf-ext")).toBeVisible();
  const order = await page.locator(".shelf-card").first().evaluate(card => {
    const chip = card.querySelector(".shelf-ext") as HTMLElement;
    const box = chip.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === chip || chip.contains(hit);
  });
  expect(order).toBe(true);

  /* And a file the shell cannot preview is asked about ONCE. Without the
   * "asked, and there is none" answer being remembered, every render asks
   * again, forever. */
  await goTo(page, "home");
  await goTo(page, "shelf");
  await expect.poll(() => page.locator(".shelf-shot").count()).toBe(1);
});

test("Review looks backwards at four things nothing else joined", async ({page}) => {
  await page.goto("/tasks.html?nocal");
  await open(page);
  await goTo(page, "review");
  const tiles = page.locator(".review-tile");
  await expect(tiles).toHaveCount(4);

  // App time, which used to be on System and never belonged there.
  await expect(tiles.nth(0).locator(".review-value")).toHaveText("4h 40m");
  await expect(tiles.nth(0).locator(".review-bar").first()).toBeVisible();
  await expect(tiles.nth(0).locator(".review-bar-name").first()).toHaveText("VS Code");
  await expect(page.locator(".sys-day")).toHaveCount(0);

  // Agent runs, grouped by project and longest first. Four, since the fixture
  // carries one run from before tokens were counted — see the spend test.
  await expect(tiles.nth(2).locator(".review-value")).toHaveText("4");
  await expect(tiles.nth(2).locator(".review-item-name").first()).toHaveText("codenotch-win");

  // Four tiles of different content, one height.
  const heights = await tiles.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  await page.screenshot({path: "test-results/island-review.png"});
});

test("the calendar has a week grid as well as an agenda", async ({page}) => {
  /* ⚠️ The clock is pinned to the middle of the working day, and the now line
   * below is why. The week grid draws it only while the current hour is inside
   * the axis, which ends at 19:00 unless an event runs later — so on the real
   * clock this test passed all afternoon and failed every evening. Today's
   * date is kept, because the assertions below compare against the runner's
   * own `new Date()`. */
  const morning = new Date();
  morning.setHours(10, 0, 0, 0);
  await page.clock.install({time: morning});
  await page.goto("/tasks.html");
  await open(page);
  await goTo(page, "calendar");
  await expect(page.locator(".cal-row").first()).toBeVisible();
  await page.getByRole("button", {name: "Week"}).click();
  await expect(page.locator(".cal-wkcol")).toHaveCount(7);
  await expect(page.locator(".cal-wkday.is-today .cal-wknum")).toHaveText(String(new Date().getDate()));

  /* ⚠️ A TIME grid, not seven lists. The only question a week view answers
     that the agenda does not is where the gaps are, and a list cannot show a
     gap — so every meeting is placed against an hour axis. */
  const block = page.locator(".cal-block").first();
  await expect(block).toBeVisible();
  const placed = await page.locator(".cal-block").evaluateAll(all =>
    all.map(el => [(el as HTMLElement).style.top, (el as HTMLElement).style.height]));
  expect(placed.every(([top, height]) => /%$/.test(top) && /%\)$/.test(height))).toBe(true);
  // Today's column carries the now line; the others do not.
  await expect(page.locator(".cal-wknow")).toHaveCount(1);
  await expect(page.locator(".cal-row")).toHaveCount(0);

  await page.getByRole("button", {name: "Month"}).click();
  await expect(page.locator(".cal-row").first()).toBeVisible();
  // 42 cells: six weeks, always, so paging cannot change the panel's height.
  await expect(page.locator(".cal-cell")).toHaveCount(42);

  /* ⚠️ Choosing a day SCROLLS the agenda to it, and does not cut the list
     down to it. Filtering looks identical the moment you click a day with
     something on it and is wrong every other time: a day with nothing on it
     answers with an empty panel rather than with the next thing that is, and
     there is no way back to the rest of the week. */
  const headings = () => page.locator(".cal-agenda .cal-day").allTextContents();
  const before = await headings();
  expect(before.length).toBeGreaterThan(1);
  await page.locator(".cal-cell").nth(20).click();
  await expect(page.locator(".cal-cell.is-chosen")).toHaveCount(1);
  expect(await headings()).toEqual(before);

  /* Paging is arithmetic, and the grid keeps its shape. */
  await page.getByRole("button", {name: "Next month", exact: true}).click();
  await expect(page.locator(".cal-cell")).toHaveCount(42);
  await expect(page.locator(".cal-cell.is-today")).toHaveCount(0);
  await page.getByRole("button", {name: "Previous month", exact: true}).click();
  await expect(page.locator(".cal-cell.is-today")).toHaveCount(1);

  /* The New Task popover writes through Today's own path — one outbox, one
     optimistic layer, one reconciliation. */
  await page.getByRole("button", {name: "New task", exact: true}).click();
  await expect(page.getByLabel("New task name")).toBeFocused();

  /* ⚠️ And it says which list it files into. It defaults to whatever Today's
     composer is on rather than to the first list — filing from here and filing
     from there should land in the same place unless you say otherwise, or the
     two screens quietly disagree about where your tasks go. */
  const picker = page.locator(".cal-new-list");
  await expect(picker).toContainText("Codenotch");
  await picker.click();
  await page.locator(".cal-list-menu .chip-option").filter({hasText: "Personal"}).click();
  await expect(picker).toContainText("Personal");
  // The caret comes back: choosing a list is a detour in the middle of typing.
  await expect(page.getByLabel("New task name")).toBeFocused();

  await page.getByLabel("New task name").fill("Ring the plumber");
  await page.getByRole("button", {name: "Add", exact: true}).click();
  await goTo(page, "today");
  await expect(day(page).getByText("Ring the plumber", {exact: true})).toBeVisible();
  // Filed where the picker said, not where Today's composer was.
  await page.locator(".list-chip").filter({hasText: "Personal"}).click();
  await expect(day(page).getByText("Ring the plumber", {exact: true})).toBeVisible();
});

test("changing screens moves, and the panel travels to the new height", async ({page}) => {
  await page.setViewportSize({width: 1060, height: 560});
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  /* Through the palette. ⚠️ Not the control on the arc: that is bare
   * until it is reached for, and these tests are not about reaching for
   * it — they only need the island held open while they poke at it. */
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");

  const dir = () => page.locator(".screens").evaluate(el =>
    getComputedStyle(el).getPropertyValue("--dir").trim());

  /* ⚠️ The direction comes from the TAB ORDER, not from the order screens were
   * opened in — the strip is what you are looking at while this happens, so a
   * screen has to arrive from the side it sits on. */
  await goTo(page, "review");
  expect(await dir()).toBe("1");
  await goTo(page, "today");
  expect(await dir()).toBe("-1");

  /* ⚠️ The screen being left goes ABSOLUTE for the length of its exit. Left in
   * flow it would hold the panel at the taller of the two heights and then drop
   * — a lurch at the end of every switch. */
  /* ⚠️ Presence and position read in ONE round trip. Asserting the count and
     then evaluating on the locator is two, and the exit is 150ms — so on a
     slower render the class is gone by the second call and `getComputedStyle`
     answers `static` for a screen that was absolute throughout its exit. The
     test failed on a calendar that had grown a 42-cell grid, which is a slower
     render and nothing else. */
  /* ⚠️ Switched with the KEYBOARD, not through the palette. The exit lasts
   * 150ms and `goTo` waits for the island to settle, which is longer — so by
   * the time it returns the leaving screen has already gone and this reads
   * "no screen is leaving" as "the screen was never absolute". Ctrl+Tab steps
   * to the next screen and returns immediately. */
  await page.keyboard.press("Control+Tab");
  await expect.poll(() => page.evaluate(() => {
    const el = document.querySelector(".screen.is-leaving");
    return el ? getComputedStyle(el).position : "";
  })).toBe("absolute");
  // And it is gone once the exit is over, rather than left stacked underneath.
  await expect(page.locator(".screen.is-leaving")).toHaveCount(0);

  /* The panel's height is SPRUNG rather than set: it travels to the new
   * screen's height instead of snapping to it. */
  const height = () => page.locator("#island").evaluate(el => el.getBoundingClientRect().height);
  await goTo(page, "home");
  const settled = await height();
  /* ⚠️ WITHOUT waiting for it to settle, which is the whole point: the claim
   * is that the height travels, and a helper that waits for it to arrive can
   * only ever measure the destination twice. */
  await goTo(page, "review", false);
  const mid = await height();
  await expect.poll(height).not.toBe(mid);
  expect(await height()).not.toBe(settled);
  await page.screenshot({path: "test-results/island-screen-change.png"});
});

test("an event opens into a panel, and nothing is striped", async ({page}) => {
  await page.goto("/tasks.html");
  await open(page);
  await goTo(page, "calendar");

  /* ⚠️ No left rails anywhere. A 3px coloured bar down the edge of a dark card
   * is the shape every generated calendar has, and it says nothing the card's
   * own tint cannot. The next-up card carried its strip as a SECOND box-shadow
   * on the same rule, which won over the first and threw the elevation away
   * with it. */
  const strips = await page.locator(".cal-row, .cal-next, .cal-chip").evaluateAll(nodes =>
    nodes.map(node => {
      const style = getComputedStyle(node);
      return `${style.borderLeftWidth}|${style.boxShadow}`;
    }));
  expect(strips.length).toBeGreaterThan(1);
  for (const shape of strips) {
    expect(shape.startsWith("0px")).toBe(true);
    // An inset shadow offset sideways is a strip wearing a different hat.
    expect(/inset\s+\d+px\s+0px\s+0px/.test(shape)).toBe(false);
  }

  /* ⚠️ A panel over the list, not a row that grows. The detail is five lines,
   * and growing a row by that much pushes every event under it down the screen
   * — so the thing being read moves while it is read. */
  const before = await page.locator(".cal-row").first().boundingBox();
  await page.locator(".cal-row").first().click();
  const panel = page.locator(".cal-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".cal-panel-title")).toHaveText("Design review");
  // How long, not two clock times to subtract.
  await expect(panel.locator(".cal-fact").first()).toContainText("min");
  await expect(panel.getByRole("button", {name: "Join"})).toBeVisible();
  const after = await page.locator(".cal-row").first().boundingBox();
  expect(Math.round(after!.y)).toBe(Math.round(before!.y));

  await panel.getByRole("button", {name: "Close event"}).click();
  await expect(panel).toHaveCount(0);
  await page.screenshot({path: "test-results/island-calendar-panel.png"});
});

test("every screen ends the same way, and a card that lights up goes somewhere", async ({page}) => {
  await page.setViewportSize({width: 1060, height: 760});
  /* ⚠️ `nofollow`: this walks every screen deliberately, and opening the
   * island lands on whatever is live — which in the full fixture is an agent
   * waiting for you. The steering is tested where it belongs. */
  await page.goto("/tasks.html?nofollow");
  await open(page);
  /* Through the palette. ⚠️ Not the control on the arc: that is bare
   * until it is reached for, and these tests are not about reaching for
   * it — they only need the island held open while they poke at it. */
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");

  /* ⚠️ The gap under the last row must match the gap at the sides. It was the
   * screen's own padding PLUS a card's worth added by `measure()` — about 30px,
   * spent twice, which is what made the bottom look nothing like the sides. */
  /* ⚠️ No "system": it came off the rail and is reached from its chip in the
   * header now. The screen itself is covered where that chip is tested. */
  for (const tab of ["home", "agents", "shelf", "review"]) {
    await page.locator(`[data-tab="${tab}"]`).click();
    await expect.poll(() => page.evaluate(() => {
      const body = document.querySelector(".screen.active .screen-body") as HTMLElement | null;
      if (!body) return -1;
      const box = body.getBoundingClientRect();
      const last = [...body.children].map(child => child.getBoundingClientRect().bottom)
        .sort((a, b) => b - a)[0] ?? box.bottom;
      const side = parseFloat(getComputedStyle(body).paddingLeft);
      return Math.abs((box.bottom - last) - side);
    }), {message: `${tab} does not end like it begins`}).toBeLessThanOrEqual(2);
  }

  /* ⚠️ A card that lights up under the pointer has to GO somewhere. The player
   * has no screen behind it any more, so it neither lifts nor takes a click —
   * a hover that leads nowhere is a promise the screen does not keep. */
  await goTo(page, "home");
  await expect(page.locator(".home-media")).not.toHaveClass(/can-open/);
  await expect(page.locator(".home-cal")).toHaveClass(/can-open/);

  // And the whole card opens it, not just the 15px arrow in its corner.
  await page.locator(".home-cal .home-strip").click();
  await expect(page.locator('[data-tab="calendar"]')).toHaveAttribute("aria-selected", "true");
});

test("a screen opens at its own height, not already scrolled", async ({page}) => {
  await page.setViewportSize({width: 1060, height: 760});
  await page.goto("/tasks.html?nofollow");
  await open(page);
  /* Through the palette. ⚠️ Not the control on the arc: that is bare
   * until it is reached for, and these tests are not about reaching for
   * it — they only need the island held open while they poke at it. */
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");

  /* ⚠️ `measure()` summed each row's `offsetHeight` and missed every margin
   * between them — the agents, shelf and calendar lists all space themselves
   * with `.row + .row { margin-top }`, so a five-row list came out about thirty
   * pixels short and opened already scrolled. A list that arrives scrolled
   * reads as cut off rather than as long. */
  /* ⚠️ No "system" in this walk any more: it came off the rail and is
   * reached from its chip in the header. The screen itself is covered by the
   * test that opens it that way. */
  for (const tab of ["home", "agents", "shelf", "calendar", "review"]) {
    await page.locator(`[data-tab="${tab}"]`).click();
    await expect.poll(() => page.evaluate(() => {
      const body = document.querySelector(".screen.active .screen-body") as HTMLElement | null;
      if (!body) return 0;
      return body.scrollHeight - body.clientHeight;
    }), {message: `${tab} opened scrolled`}).toBeLessThanOrEqual(1);
  }
});

test("a wheel has to mean it before the screen changes", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  /* Through the palette. ⚠️ Not the control on the arc: that is bare
   * until it is reached for, and these tests are not about reaching for
   * it — they only need the island held open while they poke at it. */
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");
  await goTo(page, "home");
  /* ⚠️ The HEADER, not the rail. The rail carries icons now — a caption on
   * the middle one made every stop as wide as a word and marooned the screens
   * at either end of a two-hundred-pixel bar. The name lives where it does not
   * have to fit between two other screens. */
  const active = () => page.locator("#island-where").textContent();

  const head = page.locator(".island-head");
  /* ⚠️ A trackpad sends a stream of 2-4px deltas, so acting on the first one
   * made a screen change out of a thumb resting on the pad — you would look up
   * to find yourself somewhere else. */
  await head.hover();
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 4);
  expect(await active()).toBe("Home");

  /* ⚠️ ONE mouse notch is not enough either, and that is the point of the
     second raise: at 90 a single notch switched, which in use meant looking up
     to find yourself a screen away after brushing the wheel. */
  await page.mouse.wheel(0, 120);
  expect(await active()).toBe("Home");

  // Two notches, or a deliberate swipe, and it goes.
  await page.mouse.wheel(0, 140);
  await expect.poll(active).not.toBe("Home");
});

test("a wheel changes screens unless the thing under it can scroll", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  /* ⚠️ Over the HEADER, not the rail. The rail eats a wheel itself — it is
   * a carousel and a wheel steps it — and what is under test here is the
   * panel's own wheel-to-change-screen, which the rail must not double up on.
   * The header is the panel, and it never scrolls. */
  await page.locator(".island-head").hover();
  /* ⚠️ 260, not 120. The threshold is 240 now — one mouse notch no longer
     switches, which is the whole of "less sensitive". */
  await page.mouse.wheel(0, 260);
  await expect(page.locator('.rail-stop[data-tab="today"]')).toHaveAttribute("aria-selected", "true");
  // Past the cooldown: one flick must not run through every tab, so a second
  // wheel inside 450ms is deliberately ignored. The pointer is NOT re-aimed —
  // the rail has moved out from under it, and the gesture must survive that.
  await page.waitForTimeout(520);
  await page.mouse.wheel(0, -260);
  await expect(page.locator('.rail-stop[data-tab="home"]')).toHaveAttribute("aria-selected", "true");

  /* Vertical scrolling over a list must stay with the list.
   *
   * ⚠️ The list is CAPPED here on purpose. The panel measures itself to its
   * content now, so on a real day nothing scrolls — and a wheel over a list
   * with nothing to scroll correctly falls through to changing screens, which
   * is the rule rather than a bug. The rule under test is about scrollers, not
   * about how one came to be scrollable, so the test makes one. */
  await page.addStyleTag({content: "#task-list { max-height: 90px; }"});
  await goTo(page, "today");
  await expect.poll(() => page.locator("#task-list")
    .evaluate(el => el.scrollHeight > el.clientHeight + 1)).toBe(true);
  const list = await page.locator("#task-list").boundingBox();
  await page.mouse.move(list!.x + list!.width / 2, list!.y + 20);
  await page.mouse.wheel(0, 300);
  await expect(page.locator('.rail-stop[data-tab="today"]')).toHaveAttribute("aria-selected", "true");
  // A horizontal swipe there does change screens.
  await page.waitForTimeout(520);
  await page.mouse.wheel(300, 0);
  await expect(page.locator('[data-tab="today"]')).toHaveAttribute("aria-selected", "false");
});

test("the System screen carries the machine's own controls", async ({page}) => {
  await page.goto("/tasks.html?quiet&nofollow");
  await open(page);
  await goTo(page, "system");

  /* Volume and brightness are capsules, not range inputs — the whole shape is
   * the target. They keep role=slider and the arrow keys, so nothing is lost
   * by leaving the native control behind. */
  /* ⚠️ Scoped, and `getByLabel` is why: it matches on a SUBSTRING, so the
   * mixer's rows — "Brave volume", "Spotify volume" — answer to it too. The
   * master control is the one in the controls tile. */
  const volume = page.locator(".sys-controls").getByLabel("Volume");
  await expect(volume).toHaveAttribute("role", "slider");
  await expect(volume).toHaveAttribute("aria-valuenow", "51");
  await expect(page.locator(".sys-controls").getByLabel("Brightness"))
    .toHaveAttribute("aria-valuenow", "14");
  await volume.focus();
  await volume.press("ArrowUp");
  await expect(volume).toHaveAttribute("aria-valuenow", "56");
  await expect(volume.locator(".cap-readout")).toHaveText("56%");
  // The fill grows from the bottom, so its height is the value.
  await expect(volume.locator(".cap-fill")).toHaveAttribute("style", /height:\s*56%/);

  // The machine reads itself, and an alarming figure looks alarming.
  const machine = page.locator(".sys-machine");
  await expect(machine).toContainText("Ethernet");
  await expect(machine).toContainText("7.6 GB free");
  await expect(machine.locator(".meter-rail i.hot")).toHaveCount(1);   // disk at 97%
  await page.screenshot({path: "test-results/island-system.png"});
});

test("a closed system pill is exactly its own row", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await goTo(page, "system");

  /* ⚠️ `.tile` sets a 7px gap, and a pill holds TWO children — the head, and
   * a list held at `max-height: 0`. A zero-height child still takes its gap,
   * so every closed pill carried seven pixels of nothing along its bottom edge
   * and read as badly padded. Measured rather than eyeballed: it is the kind
   * of wrong that looks like a taste decision. */
  const pills = await page.locator(".sys-pill").evaluateAll(all => all.map(pill => ({
    whole: pill.getBoundingClientRect().height,
    head: pill.querySelector(".pill-head")!.getBoundingClientRect().height,
  })));
  expect(pills.length).toBeGreaterThan(1);
  for (const pill of pills) expect(pill.whole - pill.head).toBeLessThan(1);
});

test("a long device list opens in place and the panel travels to fit", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await goTo(page, "system");

  /* ⚠️ The whole reason the pills exist. Seven audio endpoints — and this
   * machine has Steam's two virtual ones, every monitor and the real speakers —
   * made a column taller than the island can be, and the tile underneath was
   * cut off with nothing to scroll. Closed, a pill is one line. */
  const output = page.locator(".sys-output");
  await expect(output.locator(".pill-text")).toHaveText("Mateusz's Buds3 Pro");
  await expect(output.locator(".sys-row")).toHaveCount(0);
  const closed = (await page.locator("#island").boundingBox())!.height;

  await output.locator(".pill-head").click();
  await expect(output.locator(".sys-row")).toHaveCount(7);

  /* ⚠️ It opens IN PLACE and pushes the panel taller, rather than into a sheet
   * floating over it — on a screen of four controls a sheet hid most of them.
   * Polled, because the panel's height is sprung: measured once, it is measured
   * mid-flight. */
  await expect.poll(() => page.locator("#island").evaluate(el => el.getBoundingClientRect().height))
    .toBeGreaterThan(closed);
  await expect.poll(async () => {
    const list = (await output.locator(".pill-list").boundingBox())!;
    const island = (await page.locator("#island").boundingBox())!;
    return list.y + list.height <= island.y + island.height + 1;
  }).toBe(true);

  /* ⚠️ And it must not draw over the pill below it. As two grid rows it did
   * exactly that — the row came out 50px shorter than the open pill. */
  const list = (await output.locator(".pill-list").boundingBox())!;
  const below = (await page.locator(".sys-bluetooth").boundingBox())!;
  expect(below.y).toBeGreaterThanOrEqual(list.y + list.height - 1);

  // Choosing from it switches and closes.
  await output.locator(".sys-row", {hasText: "MSI G24C4"}).click();
  await expect(output.locator(".sys-row")).toHaveCount(0);
  await expect(output.locator(".pill-text")).toHaveText("MSI G24C4");
  await page.screenshot({path: "test-results/island-system.png"});
});



test("the player follows the words, and only the line that has started", async ({page}) => {
  await page.setViewportSize({width: 1100, height: 860});
  await page.goto("/tasks.html?nofollow");
  await open(page);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");
  await goTo(page, "media");

  /* ⚠️ Closed by default, like the queue: lyrics are the thing you want
   * sometimes and the thing that doubles the height of the panel always. */
  await expect(page.locator(".media-lyrics.is-open")).toHaveCount(0);
  const tall = (await page.locator("#island").boundingBox())!.height;
  await page.locator('.media-side[aria-label="Lyrics"]').click();
  await expect(page.locator(".media-lyrics.is-open")).toHaveCount(1);

  /* ⚠️ Seek to a known second FIRST. The fixture's playhead runs in real
   * time from wherever the page loaded it, so by the time a test has walked to
   * this screen the track is several seconds further on than the fixture says
   * — a test that passes or fails on how fast the machine is. */
  const rail = (await page.locator(".media-rail").boundingBox())!;
  const seekTo = (seconds: number) => page.locator(".media-rail")
    .click({position: {x: rail.width * (seconds / 1878), y: rail.height / 2}});
  await seekTo(262);

  /* At 4:22 the line that has STARTED is the one at 4:20 — not the one at
   * 4:25, however much closer it is. */
  const now = page.locator(".media-word.is-now");
  await expect(now).toHaveText("nobody said a word");
  // The whole file is there to be scrolled; the window is what moves.
  await expect(page.locator(".media-word")).toHaveCount(6);
  /* ⚠️ Distance, not a binary state: one bright line in a wall of identical
   * grey is a list, and the fade out from the middle is what puts the eye
   * where the voice is. */
  const fars = await page.locator(".media-words").evaluate(el =>
    [...el.children].map(row => (row as HTMLElement).style.getPropertyValue("--far")));
  expect(fars).toEqual(["1", "0", "1", "2", "3", "4"]);

  /* ⚠️ The NEXT line is not just another neighbour. No transcript is
   * perfectly timed — the ones on LRCLIB are a second out as often as not —
   * so the line about to be sung is what rescues a stamp that lands late: it
   * stays readable while everything else falls away. The line just SUNG gets
   * no such help; you have heard it. */
  const lit = (sel: string) => page.locator(sel).evaluate(el => ({
    fade: Number(getComputedStyle(el).opacity),
    blur: getComputedStyle(el).filter,
  }));
  const ahead = await lit(".media-word.is-next");
  const behind = await lit(".media-word.is-past");
  expect(ahead.fade).toBeGreaterThan(behind.fade + 0.2);
  expect(ahead.blur).toBe("none");

  /* ⚠️ And a hand on the wheel turns the depth of field OFF. It puts the
   * eye on the line being sung, which is right while the song is driving —
   * and the instant you scroll away from that line, every line you are
   * scrolling TOWARDS is the dim, blurred end of the gradient. */
  const words = (await page.locator(".media-words").boundingBox())!;
  await page.mouse.move(words.x + words.width / 2, words.y + words.height / 2);
  await page.mouse.wheel(0, 90);
  await expect(page.locator(".media-words.is-reading")).toHaveCount(1);
  /* ⚠️ Polled: the blur is transitioned over four hundred milliseconds, so
   * a reading measured on the frame the wheel turned catches it half gone. */
  await expect.poll(async () => (await lit(".media-word:last-child")).blur).toBe("none");
  expect((await lit(".media-word:last-child")).fade).toBeGreaterThan(0.5);

  /* Past the next stamp and the window moves on. ⚠️ Aimed at the MIDDLE of
   * a line's span rather than just past its stamp, for the same reason the
   * seek above exists. */
  await seekTo(268);
  await expect(now).toHaveText("we just stood there");

  /* ⚠️ A gap the file marks explicitly is a real line with no words. It
   * keeps its place in the column, so the lines after it do not slide up into
   * the silence. */
  await seekTo(280);
  await expect(now).toHaveText("");

  // And the panel is the island's own height: opening it grew the shape.
  expect((await page.locator("#island").boundingBox())!.height).toBeGreaterThan(tall + 80);
});

test("the lyrics panel costs the screen nothing while it is shut", async ({page}) => {
  await page.setViewportSize({width: 1100, height: 860});
  await page.goto("/tasks.html?nofollow");
  await open(page);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");
  await goTo(page, "media");
  await page.locator('.media-side[aria-label="Playing next"]').click();

  /* ⚠️ The panel is always in the DOM and closed to nothing, which is what
   * lets it animate — and a `gap` on the body would then space the screen away
   * from a box with no height. The island's measure unions its children's
   * boxes, and a gap is not a box, so those pixels were a screen that scrolled
   * with nothing in the overflow. */
  const scrolls = () => page.locator("#media-body")
    .evaluate(el => el.scrollHeight > el.clientHeight + 1);
  await expect.poll(scrolls).toBe(false);

  /* ⚠️ And the screen does not REDRAW while the playhead moves. `media:changed`
   * fires several times a second; rebuilding on it threw away the hover, the
   * caret in the search field, and the lyrics' own scroll position mid
   * animation — which is what made the words appear and then vanish. */
  const builds = await page.evaluate(async () => {
    let n = 0;
    const host = document.querySelector("#media-body")!;
    const watch = new MutationObserver(() => { n++; });
    watch.observe(host, {childList: true});
    await new Promise(done => setTimeout(done, 2600));
    watch.disconnect();
    return n;
  });
  expect(builds).toBe(0);
  // The clock still moves, because `tick` writes it in place.
  const said = () => page.locator(".media-time").first().textContent();
  const first = await said();
  await expect.poll(said, {timeout: 4000}).not.toBe(first);
});

test("System is a chip rather than a rail stop, and it carries the mixer", async ({page}) => {
  await page.setViewportSize({width: 1200, height: 900});
  await page.goto("/tasks.html?nofollow");
  await open(page);

  /* ⚠️ Off the rail, like the notices and the timer. It is a place you visit
   * for one thing and leave, which is not what a rail stop is for — and a
   * screen with no way in is a screen nobody opens, so the chip is always
   * there rather than only when the machine has something to say. */
  await expect(page.locator('.rail-stop[data-tab="system"]')).toHaveCount(0);
  const chip = page.locator("#head-system");
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator("#island-where")).toHaveText("System");

  const rows = page.locator(".mix-row");
  await expect(rows).toHaveCount(2);
  /* ⚠️ A dot for what is making a sound RIGHT NOW. An app holds its session
   * for hours after it went quiet, so by the afternoon the list is most of the
   * machine — which of them you can hear is the whole reason anybody opens a
   * mixer. */
  await expect(page.locator(".mix-row .mix-live")).toHaveCount(1);

  // Dragging the rail moves the level, and does not redraw the screen under
  // the pointer: a redraw mid-drag replaces the element the press is captured
  // on and the gesture is dropped with the button still down.
  const rail = rows.first().locator(".mix-rail");
  const box = (await rail.boundingBox())!;
  const width = () => rail.locator("i").evaluate(el => Math.round(el.getBoundingClientRect().width));
  const before = await width();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
  const during = await width();
  expect(during).toBeGreaterThan(before);
  await page.mouse.up();
  expect(await width()).toBe(during);

  // And muting one says so on its own row, not on the master control.
  await rows.first().locator(".pip").click();
  await expect(rows.first()).toHaveClass(/is-muted/);
  await expect(page.locator(".sys-controls .pip").first()).not.toHaveClass(/is-on/);
});

test("shuffling re-reads what is next, without the panel being closed", async ({page}) => {
  await page.setViewportSize({width: 1200, height: 900});
  await page.goto("/tasks.html?nofollow");
  await open(page);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");
  await goTo(page, "media");
  await page.locator('.media-side[aria-label="Playing next"]').click();

  const first = page.locator(".media-queue-list .media-track-title").first();
  await expect(first).not.toHaveText("");
  const was = await first.textContent();

  /* ⚠️ Shuffling is the one thing that changes what comes NEXT without
   * changing what is playing, and the queue was keyed on the track alone — so
   * the panel sat there showing the order that had just been thrown away, and
   * only corrected itself when it was closed and opened again. */
  await page.locator('.media-side[aria-label="Shuffle"]').click();
  await expect(page.locator('.media-side[aria-label="Shuffle"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => first.textContent(), {timeout: 5000}).not.toBe(was);
  // And the panel never went away to do it.
  await expect(page.locator(".media-queue-list")).toBeVisible();
});

test("closing the lyrics gives the island back its height, queue or no queue", async ({page}) => {
  await page.setViewportSize({width: 1200, height: 900});
  await page.goto("/tasks.html?nofollow");
  await open(page);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");
  await goTo(page, "media");
  await page.locator('.media-side[aria-label="Playing next"]').click();

  const tall = async () => Math.round((await page.locator("#island").boundingBox())!.height);
  await expect.poll(tall).toBeGreaterThan(100);
  const shut = await tall();
  await page.locator('.media-side[aria-label="Lyrics"]').click();
  await expect.poll(tall).toBeGreaterThan(shut + 80);

  /* ⚠️ Back to EXACTLY where it was. A grid with `auto` rows and spare room
   * stretches those rows to fill it, and the queue is `align-self: stretch` —
   * so it grew into whatever height the island happened to have, the island
   * measured the stretched content and kept the taller size, and the two
   * agreed with each other for ever. Seventy pixels of nothing under the
   * player, with nothing on screen to explain it. */
  await page.locator('.media-side[aria-label="Lyrics"]').click();
  await expect.poll(tall, {timeout: 4000}).toBe(shut);
});

test("a hand on the lyrics offers the way back to the song", async ({page}) => {
  await page.setViewportSize({width: 1200, height: 900});
  await page.goto("/tasks.html?nofollow");
  await open(page);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");
  await goTo(page, "media");
  await page.locator('.media-side[aria-label="Lyrics"]').click();

  /* ⚠️ Only while the follow is standing down. Reading ahead is deliberate and
   * the panel should stay put — but somebody who scrolled by accident is
   * watching a verse they are not on with nothing to say why. */
  const back = page.locator(".media-resync");
  await expect(back).toHaveCSS("opacity", "0");
  /* ⚠️ Measured once the island has STOPPED growing. Opening the panel
   * extends the shape over a spring, so a box read on the frame after the
   * press is where the words were on their way to — and the wheel lands on
   * whatever is there instead. */
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await page.locator(".media-words").boundingBox());
    const same = now === last;
    last = now;
    return same;
  }, {timeout: 4000}).toBe(true);
  const box = (await page.locator(".media-words").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 80);
  await expect(back).toHaveCSS("opacity", "1");

  await back.click();
  /* The class first: it is the fact. The opacity follows it through a 250ms
   * transition, and under load a reading taken on the frame of the press
   * catches the pill part way out. */
  await expect(page.locator(".media-words.is-reading")).toHaveCount(0);
  await expect.poll(() => back.evaluate(el => getComputedStyle(el).opacity),
    {timeout: 4000}).toBe("0");
});

test("the day points at one thing to do next, and counts what is behind you", async ({page}) => {
  await page.setViewportSize({width: 1200, height: 900});
  await page.goto("/tasks.html?nofollow");
  await open(page);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Keep the island open");
  await page.keyboard.press("Enter");
  await goTo(page, "today");

  /* ⚠️ Exactly ONE. A list is a set of things you could do; a queue is one
   * thing you are about to do, and the difference is a mark on one row — two
   * marks would be two opinions about what to do now. */
  await expect(page.locator(".day-row.is-next")).toHaveCount(1);
  /* ⚠️ And it is a row that can actually be TICKED. A parent with children
   * cannot be completed here, so pointing at one is pointing at a circle that
   * is disabled. */
  await expect(page.locator(".day-row.is-next .check input")).not.toBeDisabled();

  /* ⚠️ What you have FINISHED, beside what is left. A day that only counts
   * down can only get worse; the same line saying both is the one that makes
   * anybody want to tick the next thing. */
  await expect(page.locator("#day-won")).toHaveText(/\d+ done/);
  await expect(page.locator("#day-left")).toHaveText(/left|all done|nothing/);
});
