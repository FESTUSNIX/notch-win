import { test, expect, type Page } from "@playwright/test";

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
  await page.locator('[data-tab="today"]').click();
  await expect(page.locator("#inline-composer")).toBeVisible();
}

/** ⚠️ Scope day assertions to the Today screen. Home lists the same tasks, so
 *  a bare getByText matches twice and Playwright refuses in strict mode. */
const day = (page: Page) => page.locator('[data-screen="today"]');

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
  await page.locator('[data-tab="today"]').click();
  await expect(page.locator("#day-date")).toHaveText(/\w/);
  await expect(page.locator(".day-meta")).not.toContainText("00b7");
  await page.locator('[data-tab="home"]').click();
  // Home is the default: three sections on one row, one per other screen.
  await expect(page.locator(".home-sec")).toHaveCount(3);
  await expect(page.locator(".home-month")).toBeVisible();
  await page.locator('[data-tab="media"]').click();
  await expect(page.locator(".media-title")).toBeVisible();
  await page.locator('[data-tab="calendar"]').click();
  await expect(page.locator(".cal-next")).toBeVisible();
  await page.locator('[data-tab="today"]').click();
  await expect(day(page).getByText("Get outside for a walk", {exact: true})).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({path: "test-results/island-today.png"});
});

test("the collapsed pill shows whatever is most live, and opens that screen", async ({page}) => {
  await page.goto("/tasks.html");
  // Something playing outranks the day's tally.
  await expect(page.locator(".pill-label")).toHaveText(/potion shop/);
  await expect(page.locator(".pill-eq.on")).toBeVisible();
  // The pill can only name one thing; the other screens raise a dot instead.
  await expect(page.locator('[data-tab="media"]')).toHaveClass(/live/);
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

  await open(page);
  await page.getByRole("button", {name: "Island settings", exact: true}).click();
  await page.getByRole("button", {name: "12 h", exact: true}).click();
  // 3 PM, not 15:00 and not 03 PM: the 12-hour cycle drops the leading zero in
  // every engine, so the two formats are different lengths.
  await expect(clock).toHaveText(/^3:00\s?[AaPp]\.?[Mm]\.?$/);
  await page.getByRole("button", {name: "24 h", exact: true}).click();
  await expect(clock).toHaveText("15:00");
});

test("a player left paused hands the pill back to the clock", async ({page}) => {
  // nocal, not quiet: the demo meeting is 18 minutes out and a *paused* player
  // ranks below an imminent one, so it would win this contest legitimately.
  await page.goto("/tasks.html?nocal");
  await expect(page.locator("#island-collapsed")).toHaveAttribute("data-kind", "media");
  await open(page);
  await page.locator('[data-tab="media"]').click();
  await page.getByRole("button", {name: "Pause", exact: true}).click();
  // Paused is still a claim at first — the controls stay one glance away.
  await expect(page.locator("#island-collapsed")).toHaveAttribute("data-kind", "media");
  // ...but not for long. 30s in the app; the clock is what it falls back to.
  await page.clock.install();
  await page.clock.fastForward(35_000);
  await expect(page.locator("#island-collapsed")).toHaveAttribute("data-kind", "clock");
});

test("media controls answer at once and the scrubber reads the real timeline", async ({page}) => {
  await page.goto("/tasks.html");
  await open(page);
  await page.locator('[data-tab="media"]').click();
  await expect(page.locator(".media-title")).toHaveText(/potion shop/);
  // Artist and app share one line now: six rows of chrome became four.
  await expect(page.locator(".media-artist")).toHaveText("Real Civil Engineer  ·  Brave");
  await expect(page.locator(".media-time").first()).toHaveText(/^\d+:\d{2}$/);
  const pause = page.getByRole("button", {name: "Pause"});
  await expect(pause).toBeVisible();
  await pause.click();
  // Optimistic: the button flips without waiting for Windows to answer.
  await expect(page.getByRole("button", {name: "Play"})).toBeVisible();
  await expect(page.locator(".pill-eq.on")).toHaveCount(0);
  await page.screenshot({path: "test-results/island-media.png"});
});

test("the waveform is the progress bar, is per-track, and seeks", async ({page}) => {
  await page.goto("/tasks.html");
  await open(page);
  await page.locator('[data-tab="media"]').click();

  // Art beside the copy, not above it: one row.
  const art = await page.locator(".media-art").boundingBox();
  const side = await page.locator(".media-side").boundingBox();
  expect(side!.x).toBeGreaterThan(art!.x + art!.width - 1);

  const bars = page.locator(".wave i");
  await expect(bars).toHaveCount(72);
  // The demo track is 4:26 into 31:18, so roughly the first eighth is played.
  const played = await page.locator(".wave i.on").count();
  expect(played).toBeGreaterThan(4);
  expect(played).toBeLessThan(20);

  /* ⚠️ Synthetic, but deterministic — the same track must always draw the same
   * shape. Random bars would be a lie that also flickers on every render. */
  const shape = () => page.locator(".wave").evaluate(w =>
    [...w.querySelectorAll("i")].map(b => (b as HTMLElement).style.height).join(","));
  const first = await shape();
  await page.locator('[data-tab="home"]').click();
  await page.locator('[data-tab="media"]').click();
  expect(await shape()).toBe(first);

  // Clicking it moves the playhead, and the played run grows with it.
  const box = await page.locator(".wave").boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.75, box!.y + box!.height / 2);
  await expect.poll(() => page.locator(".wave i.on").count()).toBeGreaterThan(48);
  await page.screenshot({path: "test-results/island-media.png"});
});

test("the agenda groups by day and offers a link only where there is one", async ({page}) => {
  await page.goto("/tasks.html");
  await open(page);
  await page.locator('[data-tab="calendar"]').click();
  await expect(page.locator(".cal-next-title")).toHaveText("Design review");
  await expect(page.locator(".cal-next-when")).toHaveText(/^(now|in \d+ (min|h|d))$/);
  // Not asserted as "Today": the demo's next event is minutes away, which after
  // 23:40 is tomorrow. That a heading is printed is the point, not which one.
  await expect(page.locator(".cal-day").first()).toHaveText(/\S/);
  // Two of the three demo events are calls; the lunch is not.
  await expect(page.locator(".cal-join")).toHaveCount(2);
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
  await expect(page.getByRole("button", {name: "1 done today"})).toBeVisible();
  await expect(day(page).getByText("Get outside for a walk", {exact: true})).toBeHidden();
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

test("a draft survives the island folding, and renaming happens in place", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await openToday(page);
  const field = page.getByRole("textbox", {name: "Task name"});
  await field.click();
  await field.fill("Half a thought");
  await page.mouse.move(0, 400);
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

test("editor: safe quick add, rename, schedule and empty connection state", async ({page}) => {
  await page.setViewportSize({width: 460, height: 690});
  await page.goto("/task-editor.html");
  await page.getByLabel("Task", {exact: true}).fill('<img src=x onerror="alert(1)"> Review');
  await page.getByRole("button", {name: "Add task", exact: true}).click();
  await expect(page.getByText('<img src=x onerror="alert(1)"> Review', {exact: true})).toBeVisible();
  await expect(page.locator("#editor-list img")).toHaveCount(0);
  await page.getByRole("button", {name: 'Rename <img src=x onerror="alert(1)"> Review', exact: true}).click();
  await page.getByLabel("Task", {exact: true}).fill("Review the release");
  await page.getByRole("button", {name: "Save name", exact: true}).click();
  await expect(page.getByText("Review the release", {exact: true})).toBeVisible();
  // The island's two new connections are configured here, never in the notch.
  await expect(page.getByLabel("Client secret")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Open the island")).toHaveValue("Ctrl+Alt+Space");
  await expect(page.getByLabel("Hide everything")).toHaveValue("Ctrl+Alt+H");
  await page.screenshot({path: "test-results/task-editor.png"});

  // Back to a normal viewport: the island is ~970px wide and does not fit the
  // narrow one this test used for the editor page.
  await page.setViewportSize({width: 1200, height: 700});
  await page.goto("/tasks.html?empty&quiet");
  await open(page);
  await page.locator('[data-tab="today"]').click();
  await expect(page.getByRole("button", {name: "Connect TickTick", exact: true})).toBeVisible();
  // Nothing connected means nothing countable: the line is empty rather than
  // claiming a zero it cannot stand behind.
  await expect(page.locator("#day-left")).toHaveText("");
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
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.getByRole("button", {name: "Pin the island open", exact: true}).click();
  await page.getByRole("button", {name: "Island settings", exact: true}).click();
  for (const edge of ["left", "top", "bottom", "right"]) {
    await page.locator(`[data-task-edge="${edge}"]`).click();
    await expect(page.locator("#notch-shell")).toHaveAttribute("data-edge", edge);
    await expect.poll(() => page.locator("#notch-shell").evaluate(shell => {
      const outer = shell.getBoundingClientRect();
      const island = document.getElementById("island")!.getBoundingClientRect();
      return island.left >= outer.left - 1 && island.right <= outer.right + 1
        && island.top >= outer.top - 1 && island.bottom <= outer.bottom + 1;
    })).toBe(true);
    /* ⚠️ And the header controls stay inside it. On a vertical edge the
     * panel is only ~388px wide; a tab strip that refused to shrink laid
     * `.panel-actions` out past the island's right edge, where the clip
     * erased them — pin, settings and collapse were simply absent, with
     * nothing in the DOM saying so. */
    await expect.poll(() => page.locator("#island").evaluate(el => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll(".island-head *")].every(part => {
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
  await page.locator('[data-tab="today"]').click();
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
  await page.getByRole("button", {name: "Pin the island open", exact: true}).click();

  const sits = () => page.locator(".tab-glide").evaluate(glide => {
    const pill = glide.getBoundingClientRect();
    const tab = document.querySelector('.island-tab[aria-selected="true"]')!.getBoundingClientRect();
    return Math.abs(pill.left - tab.left) < 1.5 && Math.abs(pill.width - tab.width) < 1.5;
  });

  /* ⚠️ The geometry is COMPUTED, not measured: at the moment of a click every
   * width on the strip is mid-transition, so reading one gives a target that
   * was true a frame ago. This is the assertion that catches that arithmetic
   * going wrong — the pill would still glide, just never quite onto anything. */
  for (const tab of ["shelf", "review", "today", "home"]) {
    await page.locator(`[data-tab="${tab}"]`).click();
    await expect.poll(sits).toBe(true);
  }

  /* ⚠️ And the selected tab paints no background of its OWN. Painting both
   * lights the new tab instantly while the pill is still travelling, so there
   * are two selections on screen for a quarter of a second, every switch.
   *
   * The pointer is moved off first: hover is a real state and does paint, which
   * is correct — the claim here is about the selection, not the pointer. The
   * island is pinned, so nothing folds. */
  await page.mouse.move(520, 520);
  expect(await page.locator('.island-tab[aria-selected="true"]')
    .evaluate(tab => getComputedStyle(tab).backgroundColor))
    .toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

  /* Only the tab you are on is captioned: eight labels is a menu, one is a
   * caption for where you are. ⚠️ Polled — the label being left behind is
   * shrinking rather than vanishing, which is the whole point of it, so for a
   * quarter of a second there really are two. */
  await expect.poll(() => page.locator(".island-tab span").evaluateAll(labels =>
    labels.filter(label => label.getBoundingClientRect().width > 0).length)).toBe(1);
  await page.screenshot({path: "test-results/island-tabs.png"});
});

test("Home gathers the other three onto one row, and opens into them", async ({page}) => {
  await page.goto("/tasks.html");
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
  await expect(page.locator(".home-task")).toHaveCount(3);
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
  /* The pill: only a WAITING session claims it. Something working needs
   * nothing from you and will carry on by itself. ⚠️ Not under `?quiet` —
   * that fixture has no sessions at all, on purpose, so the resting-clock
   * tests are not competing with an agent for the same strip. */
  await expect(page.locator(".pill-label")).toHaveText("akcesfonia");
  await expect(page.locator(".pill-value")).toHaveText(/waiting \d+m/);

  await open(page);
  await page.locator('[data-tab="agents"]').click();
  const rows = page.locator(".agent-row");
  await expect(rows).toHaveCount(3);
  // Ordered by who wants you, not by name or by when they started.
  await expect(rows.nth(0)).toHaveClass(/is-waiting/);
  await expect(rows.nth(1)).toHaveClass(/is-working/);
  await expect(rows.nth(2)).toHaveClass(/is-idle/);

  await expect(rows.nth(0).locator(".agent-project")).toHaveText("akcesfonia");
  await expect(rows.nth(0).locator(".agent-branch")).toHaveText("master");
  await expect(rows.nth(0).locator(".agent-tokens")).toHaveText("1.3M / 38k");
  await expect(rows.nth(0).locator(".agent-run")).toHaveText("last 4m 12s");

  // Going there is the useful thing to do with "akcesfonia is waiting".
  const go = rows.nth(0).locator(".agent-go");
  await expect(go).toHaveAttribute("aria-label", /Go to akcesfonia, waiting for you/);
  await go.click();
  await expect(page.locator(".screen-error")).toHaveCount(0);

  /* Snoozing is offered on the waiting row and NOT on the others: muting
   * something that is already saying nothing is a control that does nothing
   * but make you wonder later what you switched off. */
  await expect(rows.nth(0).locator(".agent-snooze")).toHaveCount(1);
  await expect(rows.nth(1).locator(".agent-snooze")).toHaveCount(0);
  await expect(rows.nth(2).locator(".agent-snooze")).toHaveCount(0);

  // A snoozed session hands the pill back and says so where it can be undone.
  await rows.nth(0).locator(".agent-snooze").click();
  await expect(rows.nth(0)).toHaveClass(/is-quiet/);
  // The pill goes back to whatever it would otherwise be showing — here the
  // player, which a waiting agent had been outranking.
  await expect(page.locator("#island-collapsed")).toHaveAttribute("data-kind", "media");
  await page.getByRole("button", {name: "Island settings", exact: true}).click();
  await expect(page.locator("#snoozed-line")).toContainText("1 thing snoozed");
  await page.getByRole("button", {name: "bring back", exact: true}).click();
  await expect(page.locator("#snoozed-line")).toBeHidden();
  await expect(rows.nth(0)).not.toHaveClass(/is-quiet/);
  await page.screenshot({path: "test-results/island-agents.png"});
});

test("the palette searches the island's own world and acts on it", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await page.getByRole("button", {name: "Search and commands"}).click();
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
  await expect(page.locator('[data-tab="today"]')).toHaveAttribute("aria-selected", "true");

  // Escape closes without running anything.
  await page.getByRole("button", {name: "Search and commands"}).click();
  await expect(page.locator(".palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette")).toBeHidden();

  /* ⚠️ The pin is never touched. `surface.pin()` is a toggle on a
   * user-facing latch, and three callers used to flip it around one open — so
   * the island came back pinned and stayed open until it was unpinned by hand.
   * Holding the panel while it has the caret is `editing`'s job. */
  await expect(page.getByRole("button", {name: "Pin the island open", exact: true}))
    .toHaveAttribute("aria-pressed", "false");

  /* Narrower while it is up. The full panel is ~910px, which is right for a
   * screen of content and reads as a window someone left open when all it
   * holds is a list of one-line results. */
  const full = (await page.locator("#island").boundingBox())!.width;
  await page.getByRole("button", {name: "Search and commands"}).click();
  await expect(page.locator(".palette")).toBeVisible();
  await expect.poll(async () => (await page.locator("#island").boundingBox())!.width)
    .toBeLessThan(full - 100);
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
  await page.getByRole("button", {name: "Search and commands"}).click();
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
  await page.getByRole("button", {name: "Search and commands"}).click();
  const before = await rows.first().locator(".palette-title").textContent();
  expect(before).not.toBe("Review");
  await field.fill("review");
  await page.keyboard.press("Enter");
  await expect(page.locator(".palette")).toBeHidden();

  await page.getByRole("button", {name: "Search and commands"}).click();
  await expect(rows.first().locator(".palette-title")).toHaveText("Review");
  await page.screenshot({path: "test-results/island-palette-deep.png"});
});

test("ranking prefers the thing you named, and a scope narrows it", async ({page}) => {
  await page.goto("/tasks.html?agents&nocal");
  await open(page);
  await page.getByRole("button", {name: "Search and commands"}).click();
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
  await page.getByRole("button", {name: "Search and commands"}).click();
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

  await page.getByRole("button", {name: "Search and commands"}).click();
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

test("the shelf parks things and hands them back", async ({page}) => {
  await page.goto("/tasks.html?nocal");
  await open(page);
  await page.locator('[data-tab="shelf"]').click();
  const rows = page.locator(".shelf-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0).locator(".shelf-name")).toHaveText("Codenotch_0.1.0_x64-setup.exe");
  await expect(rows.nth(0).locator(".shelf-note")).toHaveText("4.8 MB");
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

test("Review looks backwards at four things nothing else joined", async ({page}) => {
  await page.goto("/tasks.html?nocal");
  await open(page);
  await page.locator('[data-tab="review"]').click();
  const tiles = page.locator(".review-tile");
  await expect(tiles).toHaveCount(4);

  // App time, which used to be on System and never belonged there.
  await expect(tiles.nth(0).locator(".review-value")).toHaveText("4h 40m");
  await expect(tiles.nth(0).locator(".review-bar").first()).toBeVisible();
  await expect(tiles.nth(0).locator(".review-bar-name").first()).toHaveText("VS Code");
  await expect(page.locator(".sys-day")).toHaveCount(0);

  // Agent runs, grouped by project and longest first.
  await expect(tiles.nth(2).locator(".review-value")).toHaveText("3");
  await expect(tiles.nth(2).locator(".review-item-name").first()).toHaveText("codenotch-win");

  // Four tiles of different content, one height.
  const heights = await tiles.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  await page.screenshot({path: "test-results/island-review.png"});
});

test("the calendar has a week grid as well as an agenda", async ({page}) => {
  await page.goto("/tasks.html");
  await open(page);
  await page.locator('[data-tab="calendar"]').click();
  await expect(page.locator(".cal-row").first()).toBeVisible();
  await page.getByRole("button", {name: "Week"}).click();
  await expect(page.locator(".cal-wcol")).toHaveCount(7);
  await expect(page.locator(".cal-wcol.is-today .cal-wnum")).toHaveText(String(new Date().getDate()));
  await expect(page.locator(".cal-chip").first()).toBeVisible();
  await expect(page.locator(".cal-row")).toHaveCount(0);
  await page.getByRole("button", {name: "Agenda"}).click();
  await expect(page.locator(".cal-row").first()).toBeVisible();
});

test("a wheel changes screens unless the thing under it can scroll", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator(".island-tabs").hover();
  await page.mouse.wheel(0, 120);
  await expect(page.locator('[data-tab="today"]')).toHaveAttribute("aria-selected", "true");
  // Past the cooldown: one flick must not run through every tab, so a second
  // wheel inside 260ms is deliberately ignored. The pointer is NOT re-aimed —
  // the rail has moved out from under it, and the gesture must survive that.
  await page.waitForTimeout(320);
  await page.mouse.wheel(0, -120);
  await expect(page.locator('[data-tab="home"]')).toHaveAttribute("aria-selected", "true");

  // Vertical scrolling over a list must stay with the list.
  await page.locator('[data-tab="today"]').click();
  const list = await page.locator("#task-list").boundingBox();
  await page.mouse.move(list!.x + list!.width / 2, list!.y + 20);
  await page.mouse.wheel(0, 200);
  await expect(page.locator('[data-tab="today"]')).toHaveAttribute("aria-selected", "true");
  // A horizontal swipe there does change screens.
  await page.waitForTimeout(320);
  await page.mouse.wheel(200, 0);
  await expect(page.locator('[data-tab="today"]')).toHaveAttribute("aria-selected", "false");
});

test("the System screen carries the machine's own controls", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator('[data-tab="system"]').click();

  /* Volume and brightness are capsules, not range inputs — the whole shape is
   * the target. They keep role=slider and the arrow keys, so nothing is lost
   * by leaving the native control behind. */
  const volume = page.getByLabel("Volume");
  await expect(volume).toHaveAttribute("role", "slider");
  await expect(volume).toHaveAttribute("aria-valuenow", "51");
  await expect(page.getByLabel("Brightness")).toHaveAttribute("aria-valuenow", "14");
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

test("a long device list stays behind one press instead of growing the panel", async ({page}) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator('[data-tab="system"]').click();

  /* ⚠️ The point of the whole tile shape: seven endpoints used to make a column
   * taller than the island can be, and the tile underneath was cut off with
   * nothing to scroll. Closed, the tile shows only what is in use. */
  const output = page.locator(".sys-output");
  await expect(output.locator(".sys-row")).toHaveCount(1);
  await expect(output.locator(".sys-row")).toContainText("Mateusz's Buds3 Pro");
  await expect(output.locator(".tile-more")).toHaveText("6 more");
  const closed = (await page.locator("#island").boundingBox())!.height;

  await output.locator(".tile-more").click();
  const sheet = output.locator(".sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".sys-row")).toHaveCount(7);

  // Opening it GROWS the island rather than being clipped by it.
  await expect.poll(() => page.locator("#island").evaluate(el => el.getBoundingClientRect().height))
    .toBeGreaterThan(closed);
  const box = await sheet.boundingBox();
  const island = await page.locator("#island").boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(island!.y + island!.height + 1);

  // Choosing from it switches and closes.
  await sheet.locator(".sys-row").nth(1).click();
  await expect(output.locator(".sheet")).toHaveCount(0);
  await expect(output.locator(".sys-row")).toContainText("DELL U2724D");

  /* Bluetooth is a readout, not a control: Windows exposes no supported way to
   * connect or disconnect a device from another process. */
  const bt = page.locator(".sys-bluetooth");
  await expect(bt.locator(".sys-row")).toHaveCount(2);           // the connected ones
  await expect(bt.locator(".sys-row").first()).toHaveClass(/static/);
  await bt.locator(".tile-more").click();
  await expect(bt.locator(".sheet .sys-row")).toHaveCount(4);    // everything paired
});

