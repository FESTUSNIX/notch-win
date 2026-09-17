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

test("clearing them all lives on the arc, and nowhere else", async ({ page }) => {
  await page.goto("/tasks.html?notices&quiet");
  await open(page);
  await page.locator("#head-bell").click();

  /* ⚠️ ONE clear-all. There was a second on a bar above the list; two controls
   * for one verb is two places to look for it, and the bar was a row of chrome
   * over a list whose whole job is to be skimmed. */
  await expect(page.locator(".notice-all")).toHaveCount(0);
  await expect(page.locator(".notice-bar")).toHaveCount(0);
  const tools = await page.evaluate(() =>
    [...document.querySelectorAll("#island-tools .arc-act")]
      .map(one => one.getAttribute("aria-label")));
  expect(tools).toContain("Clear them all");

  /* The quick action is OPEN THE APP, and it is named for exactly that. A
   * notification carries no way to activate itself from outside, so pressing
   * a row can open Slack and never the thread — see `notices.rs`. */
  await expect(page.locator(".notice-row").first().locator(".notice-open"))
    .toHaveAttribute("data-tip", "Open Slack");
});

/** A card's box, once it has stopped moving.
 *
 * ⚠️ The panel ANIMATES to each screen's own width, so a box measured the
 * instant the screen changes is the width of the screen you just left. Measured
 * during the narrowing, this card reported 789px wide and was 511 by the time
 * the press landed — so the press went to whatever had taken that pixel, and
 * the drag did nothing at all. Two identical readings in a row is settled; the
 * same rule `reachIsland` in tasks.spec follows for the arc. */
async function settled(page: Page, selector: string) {
  let last = "";
  await expect.poll(async () => {
    const box = await page.locator(selector).boundingBox();
    const now = JSON.stringify(box);
    const same = now === last;
    last = now;
    return same;
  }, { timeout: 4000 }).toBe(true);
  return (await page.locator(selector).boundingBox())!;
}

test("a card can be thrown away, and a nudge is not a throw", async ({ page }) => {
  await page.goto("/tasks.html?notices&quiet");
  await open(page);
  await page.locator("#head-bell").click();
  await expect(page.locator(".notice-row")).toHaveCount(4);

  const card = await settled(page, '.notice-row[data-notice="2"]');
  const throwIt = async (distance: number) => {
    await page.mouse.move(card.x + 120, card.y + card.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) {
      await page.mouse.move(card.x + 120 + (distance * step) / 10, card.y + card.height / 2);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  };

  /* ⚠️ A nudge springs back AND does not open the app. The card is a button,
   * so without the guard on the click every throw would end in Slack. */
  await throwIt(40);
  await expect(page.locator('.notice-row[data-notice="2"]')).toHaveCount(1);
  await expect(page.locator("#island-where")).toHaveText("Notices");

  // Past a third of the card's own width, and it goes.
  await throwIt(card.width * 0.5);
  await expect(page.locator('.notice-row[data-notice="2"]')).toHaveCount(0);
  await expect(page.locator(".notice-row")).toHaveCount(3);
  await expect(page.locator("#head-bell .head-count")).toHaveText("3");
});

test("a screen you were sent to has a way back; one you walked to does not", async ({ page }) => {
  await page.goto("/tasks.html?notices&quiet");
  await open(page);
  /* ⚠️ Not on a rail screen. Everything on the rail already has a way back —
   * the rail — and an arrow on all twelve would be a control that does nothing
   * you could not already do, on every screen, for ever. */
  await expect(page.locator("#island-back")).toBeHidden();

  await run(page, "Notes", "Notes");
  await expect(page.locator("#island-where")).toHaveText("Notes");
  await expect(page.locator("#island-back")).toBeHidden();

  await page.locator("#head-bell").click();
  await expect(page.locator("#island-where")).toHaveText("Notices");
  const back = page.locator("#island-back");
  await expect(back).toBeVisible();
  /* And it goes back to where you WERE, not to Home — Home is where the island
   * opens, which is not the same thing. */
  await expect(back).toHaveAttribute("data-tip", "Back to Notes");
  await back.click();
  await expect(page.locator("#island-where")).toHaveText("Notes");
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
  /* ⚠️ Visible with NOTHING running. Hidden when idle it was a control with
   * no way in: the only way to start a pomodoro was to know the palette
   * command, and a feature you have to be told about is one nobody uses. */
  const chip = page.locator("#head-timer");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveClass(/is-idle/);
  await expect(chip.locator(".head-text")).toHaveText("");

  await chip.click();
  await expect(page.locator("#island-where")).toHaveText("Timer");
  // It opens on the pomodoro, which is the one with a method behind it.
  await expect(page.locator(".tm-mode.is-on")).toHaveText("Pomodoro");
  /* ⚠️ Icon only, and the label is the TOOLTIP. Four labelled buttons in a row
   * say all four matter equally; a big accent circle beside two grey ones says
   * which one you meant. */
  await expect(page.locator(".tm-btn.is-lead")).toHaveAttribute("aria-label", "Start");
  await expect(page.locator(".tm-btn.is-lead")).toHaveText("");
});

test("the controls have a pecking order rather than a row of equals", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  await page.locator(".tm-btn.is-lead").click();

  const size = async (selector: string) => {
    const box = (await page.locator(selector).boundingBox())!;
    return Math.round(box.width);
  };
  /* Pause is the one you press twenty times, stop is the one you press once,
   * and the lengths are a thing you touch on a Tuesday. */
  const lead = await size(".tm-btn.is-lead");
  const second = await size('.tm-btn[aria-label="Stop"]');
  const third = await size(".tm-btn.is-ghost");
  expect(lead).toBeGreaterThan(second);
  expect(second).toBeGreaterThan(third);
});

test("the two faces keep their own controls, and their own clock", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();

  /* ⚠️ The dial belongs to the TIMER alone. A pomodoro's lengths are a
   * setting you choose once; under a drag they become a thing to fiddle with,
   * which is the opposite of what the method is for. */
  await expect(page.locator(".tm-dial")).toHaveCount(0);
  await expect(page.locator(".tm-track")).toHaveCount(1);
  await expect(page.locator(".tm-name")).toHaveCount(1);

  await page.locator('.tm-mode:has-text("Timer")').click();
  await expect(page.locator(".tm-dial")).toHaveCount(1);
  await expect(page.locator(".tm-track")).toHaveCount(0);
  await expect(page.locator(".tm-name")).toHaveCount(0);
  await expect(page.locator(".tm-clock")).toHaveText("15:00");

  /* ⚠️ And a countdown running on ONE face must not be drawn on the other:
   * both faces are one engine, so the Timer face happily showed a running
   * pomodoro's time above a dial set to something else — two different times
   * on one screen. */
  await page.locator('.tm-mode:has-text("Pomodoro")').click();
  await page.locator(".tm-btn.is-lead").click();
  await expect(page.locator(".tm-clock")).toHaveText(/^2[45]:\d\d$/);
  await page.locator('.tm-mode:has-text("Timer")').click();
  await expect(page.locator(".tm-clock")).toHaveText("15:00");
});

test("the dial winds the timer, and the wound number is what starts", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  await page.locator('.tm-mode:has-text("Timer")').click();
  await expect(page.locator(".tm-clock")).toHaveText("15:00");

  const dial = (await page.locator(".tm-dial").boundingBox())!;
  /* ⚠️ Dragging LEFT winds it UP. The ruler moves with the hand and its
   * numbers run left to right, so pulling it leftward brings the bigger ones
   * under a mark that does not move. */
  await page.mouse.move(dial.x + dial.width / 2, dial.y + dial.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(dial.x + dial.width / 2 - step * 15, dial.y + dial.height / 2);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await expect(page.locator(".tm-clock")).toHaveText("25:00");

  await page.locator(".tm-btn.is-lead").click();
  await expect(page.locator(".tm-clock")).toHaveText(/^(25:00|24:5\d)$/);
  await expect(page.locator("#head-timer")).toHaveAttribute("data-phase", "plain");
});

test("a pomodoro shows the whole cycle, and can be skipped through", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  await page.locator(".tm-btn.is-lead").click();

  /* Four focus rounds and their breaks — the shape does not change as you
   * move along it, which is the only way it can say where you are. */
  await expect(page.locator(".tm-dot")).toHaveCount(8);
  await expect(page.locator(".tm-dot.is-now")).toHaveCount(1);
  await expect(page.locator(".tm-dot.is-work.is-now")).toHaveCount(1);
  await expect(page.locator(".tm-say")).toHaveText("Focus · 1 of 4");

  /* ⚠️ Skip exists because cutting a break short is the commonest thing
   * anybody wants mid-cycle, and stopping threw the whole run away. */
  await page.locator('.tm-btn[aria-label="Skip to the next session"]').click();
  await expect(page.locator(".tm-say")).toHaveText("Break");
  await expect(page.locator(".tm-dot.is-rest.is-now")).toHaveCount(1);
  await expect(page.locator(".tm-dot.is-done")).toHaveCount(1);

  await page.locator('.tm-btn[aria-label="Stop"]').click();
  await expect(page.locator(".tm-dot.is-now")).toHaveCount(0);
});

test("a named session is what the collapsed pill says", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  await page.locator(".tm-name").fill("Ship the call screen");
  await page.locator(".tm-btn.is-lead").click();

  /* Off the island, so it folds. ⚠️ The whole point of the claim: the
   * countdown has to be readable with the panel shut, which is how it spends
   * almost all of its twenty-five minutes. */
  await page.mouse.move(10, 700);
  await expect(page.locator("#island-expanded")).not.toBeVisible();
  const pill = page.locator("#island-collapsed");
  await expect(pill).toHaveAttribute("data-kind", "focus");
  /* ⚠️ The NAME, not the phase. "Focus" you already knew — you started it;
   * what you look down at the strip for is which thing you said you were on. */
  await expect(pill.locator(".pill-label")).toHaveText("Ship the call screen");
  await expect(pill.locator(".pill-value")).toHaveText("Focus");

  /* ⚠️ The countdown has a SLOT OF ITS OWN, and it is the biggest thing on
   * the strip. It used to be the tail of that grey second line — 10.5px,
   * behind the phase and a middle dot — which printed the one number anybody
   * looks down for smaller than everything around it. */
  const time = pill.locator(".pill-time");
  await expect(time).toHaveText(/^\d?\d:\d\d$/);
  const sizes = await pill.evaluate(el => [".pill-time", ".pill-label", ".pill-value"]
    .map(one => parseFloat(getComputedStyle(el.querySelector(one)!).fontSize)));
  expect(sizes[0]).toBeGreaterThan(sizes[1]);
  expect(sizes[0]).toBeGreaterThan(sizes[2]);
});

test("a plain timer parks beside the notch instead of taking the strip", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  await page.locator('.tm-mode:has-text("Timer")').click();
  await page.locator(".tm-btn.is-lead").click();
  await page.mouse.move(10, 700);
  await expect(page.locator("#island-expanded")).not.toBeVisible();

  /* ⚠️ The strip keeps the CLOCK. A plain timer used to claim it like
   * everything else, so for twenty minutes the notch said "Timer" and a
   * countdown — the date, the time and the module slot all spent on a number
   * you asked for yourself and can see the end of. */
  await expect(page.locator("#island-collapsed")).toHaveAttribute("data-kind", "clock");

  const bubble = page.locator(".island-bubble");
  await expect(bubble).toBeVisible();
  // Both in one evaluate, and after the fold has stopped: see `fits` below.
  await settled(page, "#island");
  const [notch, circle] = await page.evaluate(() => ["#island", ".island-bubble"]
    .map(one => {
      const r = document.querySelector(one)!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
  // Beside the notch, clear of it, round, and as tall as it.
  expect(circle.x).toBeGreaterThan(notch.x + notch.width);
  expect(Math.round(circle.height)).toBe(Math.round(notch.height));
  expect(Math.round(circle.width)).toBe(Math.round(circle.height));
  // Whole minutes: there is room for two characters and no more.
  await expect(bubble.locator(".bub-mid")).toHaveText(/^\d{1,2}$/);

  /* The middle is the pause. ⚠️ And pressing it must NOT open the island:
   * it sits on the button that does, so without a stopped press the only way
   * to pause would be to accept the panel opening over what you were doing. */
  await bubble.hover();
  await expect(bubble.locator(".bub-act")).toHaveAttribute("aria-label", "Pause");
  await bubble.locator(".bub-act").click();
  await expect(bubble.locator(".bub-act")).toHaveAttribute("aria-label", "Resume");
  await expect(page.locator("#island-expanded")).not.toBeVisible();

  /* And the ring around it opens the screen. ⚠️ Off centre on purpose —
   * the middle of this button is the pause. */
  await page.locator(".bub-open").click({ position: { x: 4, y: circle.height / 2 } });
  await expect(page.locator("#island-expanded")).toBeVisible();
  await expect(page.locator("#island-where")).toHaveText("Timer");
});

test("the mode switch is a pill under the word, not under half the control", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  const pill = page.locator(".tm-modes-pill");

  /* ⚠️ MEASURED off the tab, never `calc(50%)`. "Timer" and "Pomodoro" are
   * not the same length, so half the control was a pill that overhung one
   * word and left the other sticking out from under it. */
  /* ⚠️ Both boxes in ONE evaluate. The panel is still growing from its
   * centre for a few frames after it opens, so two measurements taken a round
   * trip apart are taken at two different panel widths — and the pill reads
   * as seven pixels adrift of a tab that has simply moved under it. Same trap
   * `settled` above documents, one frame smaller. */
  const fits = async () => {
    const [box, tab] = await page.evaluate(() => [".tm-modes-pill", ".tm-mode.is-on"]
      .map(one => {
        const r = document.querySelector(one)!.getBoundingClientRect();
        return { x: r.x, width: r.width };
      }));
    expect(Math.abs(box.width - tab.width)).toBeLessThan(2);
    expect(Math.abs((box.x + box.width / 2) - (tab.x + tab.width / 2))).toBeLessThan(2);
  };
  await fits();
  await page.locator('.tm-mode:has-text("Timer")').click();
  await expect(page.locator(".tm-mode.is-on")).toHaveText("Timer");
  // It travels; give it the trip before measuring where it landed.
  await page.waitForTimeout(400);
  await fits();

  /* ⚠️ A quiet raised surface, NOT a slab of accent. Which face you are on
   * is not the important thing on this screen — the accent belongs to the
   * number you are reading and the one button you came to press. */
  const tone = await pill.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(tone).toContain("255, 255, 255");
});

test("the ruler follows the hand between the marks, and eases onto one", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  await page.locator('.tm-mode:has-text("Timer")').click();

  const where = () => page.locator(".tm-strip")
    .evaluate(el => parseFloat(getComputedStyle(el).translate));
  const dial = (await page.locator(".tm-dial").boundingBox())!;
  const mid = { x: dial.x + dial.width / 2, y: dial.y + dial.height / 2 };
  const start = await where();

  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x - 7, mid.y);
  /* ⚠️ Seven pixels is under half a minute, so the NUMBER must not change
   * — and the ruler must move anyway. Rounding the strip as well is what made
   * the drag a ratchet: it stood still for seven pixels of hand and then
   * jumped fifteen. */
  await expect(page.locator(".tm-clock")).toHaveText("15:00");
  expect(await where()).toBeCloseTo(start - 7, 0);

  // Let go and it EASES back onto the mark rather than landing in one frame.
  await page.mouse.up();
  await expect.poll(where, { timeout: 2000 }).toBeCloseTo(start, 0);

  /* The mark under the arrow is lit, and the arrow is UNDERNEATH the ruler —
   * drawn through it, it was one more tall line among a hundred tall lines. */
  await expect(page.locator(".tm-strip i.is-at")).toHaveCount(1);
  const lit = (await page.locator(".tm-strip i.is-at").boundingBox())!;
  const arrow = (await page.locator(".tm-marker").boundingBox())!;
  expect(arrow.y).toBeGreaterThanOrEqual(lit.y + lit.height);
  expect(Math.abs((arrow.x + arrow.width / 2) - (lit.x + lit.width / 2))).toBeLessThan(1.5);
});

test("the lengths are on the screen as well, behind a button", async ({ page }) => {
  await page.goto("/tasks.html?quiet");
  await open(page);
  await page.locator("#head-timer").click();
  await expect(page.locator(".tm-drawer")).toHaveCount(0);

  await page.locator('.tm-btn[aria-label="Focus and break lengths"]').click();
  await expect(page.locator(".tm-drawer")).toHaveCount(1);
  await expect(page.locator(".tm-tune")).toHaveCount(3);
  await expect(page.locator(".tm-tune-value").first()).toHaveText("25m");

  // Shorter by one, and the face agrees straight away.
  await page.locator('.tm-tune:has-text("Focus") .tm-step').first().click();
  await expect(page.locator(".tm-tune-value").first()).toHaveText("24m");
  await expect(page.locator(".tm-clock")).toHaveText("24:00");
});

/* ── The meeting that would not go away ────────────────────────────────── */

test("an imminent meeting takes the strip, and lets go when it starts", async ({ page }) => {
  await page.goto("/tasks.html?event=soon&quiet");
  const pill = page.locator("#island-collapsed");
  await expect(pill).toHaveAttribute("data-kind", "event");
  await expect(pill.locator(".pill-label")).toHaveText("Design review");

  /* ⚠️ Gone once it has STARTED. `nextEvent` keeps an event until it ENDS, so
   * this claimed all the way through the meeting counting DOWN past zero —
   * and a reminder for something that began twenty minutes ago is not a
   * reminder. */
  await page.goto("/tasks.html?event=now&quiet");
  await expect(pill).toHaveAttribute("data-kind", "clock");
});

test("and it can be dismissed, which nothing on the strip could be", async ({ page }) => {
  await page.goto("/tasks.html?event=soon&quiet");
  const pill = page.locator("#island-collapsed");
  await expect(pill).toHaveAttribute("data-kind", "event");

  /* ⚠️ The one claim on the island that could not be answered: a module can be
   * muted and an agent snoozed, but the thing with an actual deadline had no
   * way to say "not now" — the strip is not clickable, because hovering it
   * opens the panel. */
  await open(page);
  await run(page, "Dismiss", "Dismiss Design review");
  await page.mouse.move(10, 700);
  await expect(pill).toHaveAttribute("data-kind", "clock");
});
