import { test, expect, type Page } from "@playwright/test";

/* Helm on the island: its day as Today and the Guardian, staged by `?helm`
 * (and `?nudge`) in task-client.ts. Each test also saves a clipped picture of
 * the island to test-results/, for checking the look by eye.
 *
 * The cockpit (28 Oct) is staged too: `/api/notch` with `?helm`, and the 404
 * of a Helm that has not shipped it yet with `&notch=off`; `&agents&finished`
 * stages a run that has just ended on a request. What the preview was asked to
 * do to Helm is read back from `window.__helmCalls`. */

async function open(page: Page) {
  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();
}

/** Through the palette, as tasks.spec does, then wait for the shape to settle. */
async function goTo(page: Page, label: string, screen: string) {
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill(label);
  await page.locator(".palette-row .palette-title").filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await expect(page.locator(`.screen[data-screen="${screen}"]`)).toBeVisible();
  await page.waitForTimeout(900);
}

/** ⚠️ A clipped page screenshot, not a locator one: the island ticks every
 *  second and a locator screenshot waits for a stillness that never comes. */
async function picture(page: Page, name: string) {
  const box = await page.locator("#island-expanded").boundingBox();
  await page.screenshot({ path: `test-results/helm-${name}.png`, clip: { x: box!.x - 8, y: box!.y - 8, width: box!.width + 16, height: box!.height + 16 } });
}

/** What the preview was asked to do to Helm. */
async function calls(page: Page, command: string) {
  return page.evaluate(name => (window as unknown as { __helmCalls: { command: string; args: Record<string, unknown> }[] })
    .__helmCalls.filter(one => one.command === name).map(one => one.args), command);
}

/** The pill's own line, which is where a toast lands (`say`). */
const pillLabel = (page: Page) => page.locator("#island-collapsed .pill-label");

test("with Helm connected, Today is Helm's Today, the suggestions folded under it", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Today", "helm");
  const today = page.locator('.screen[data-screen="helm"]');
  await expect(today.locator(".helm-must-text")).toHaveText("4 in Today");
  // Now is Today's first, with the Guardian's line on why.
  await expect(today.locator(".helm-hero-title")).toHaveText("Rynek Czeski — poprawki w koszyku");
  await expect(today.locator(".helm-why-text")).toHaveText("Termin w czwartek, zostały około 2 godziny.");
  await expect(today.locator(".helm-toggle")).toHaveAttribute("aria-label", "Start");
  // The day's figures, as marks and numbers: done, his time, the agents'.
  await expect(today.locator(".helm-fig.is-done")).toHaveAttribute("aria-label", "3 done today");
  await expect(today.locator(".helm-fig.is-you .helm-fig-value")).toHaveText("3 h 10");
  await expect(today.locator(".helm-fig.is-agents .helm-fig-value")).toHaveText("1 h 25");
  // The rest of Today as rows; the late request says so in a chip; the suggestions wait folded.
  await expect(today.locator(".day-row")).toHaveCount(3);
  await expect(today.locator(".helm-chip.is-late")).toHaveText("2 days late");
  await expect(today.locator(".helm-block.is-suggested .k-count")).toHaveText("2");
  await expect(today.locator(".helm-tomorrow")).toHaveAttribute("aria-label", "2 moved to tomorrow");
  // ⚠️ No grey meta line any more: the project is the row's face.
  await expect(today.locator(".day-sub")).toHaveCount(0);
  await expect(today.locator(".helm-hero .hp-logo.has-logo img")).toHaveCount(1);
  await picture(page, "today");

  // Unfolded, a suggestion's + puts it into Today at once.
  await today.locator(".helm-block.is-suggested .k-block-head").click();
  await expect(today.locator(".day-row.is-suggested")).toHaveCount(2);
  await picture(page, "today-suggested");
  await today.locator(".day-row.is-suggested").filter({ hasText: "Galeria" }).locator(".task-focus").first().click();
  await expect(today.locator(".helm-must-text")).toHaveText("5 in Today");

  // Not today takes Now off; the small things are next, their items listed under the hero.
  await today.locator(".helm-later").click();
  await expect(today.locator(".helm-hero-title")).toHaveText("3 small things");
  await expect(today.locator(".day-row.nested")).toHaveCount(3);
});

test("the Suggested fold reveals its rows rather than opening into empty space", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Today", "helm");
  const today = page.locator('.screen[data-screen="helm"]');
  await today.locator(".helm-block.is-suggested .k-block-head").click();
  /* ⚠️ Polled, and both rects in ONE round trip (AGENTS 473): the island
   * springs to its new height and the list scrolls smoothly, so a box read on
   * the frame after the click is where things were going, not where they are. */
  await expect.poll(() => page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.screen[data-screen="helm"] .helm-list')!.getBoundingClientRect();
    const rows = [...document.querySelectorAll<HTMLElement>('.screen[data-screen="helm"] .day-row.is-suggested')];
    return rows.length > 0 && rows.every(row => {
      const box = row.getBoundingClientRect();
      return box.height > 0 && box.top >= list.top - 1 && box.bottom <= list.bottom + 1;
    });
  }), { timeout: 4000 }).toBe(true);
});

test("a session started from the queue is Now, with its timer and ring", async ({ page }) => {
  await page.goto("/tasks.html?helm&running&noagents");
  await open(page);
  await goTo(page, "Today", "helm");
  const today = page.locator('.screen[data-screen="helm"]');
  await expect(today.locator(".helm-hero-title")).toHaveText("Rynek Czeski — poprawki w koszyku");
  await expect(today.locator(".helm-toggle")).toHaveAttribute("aria-label", "Pause");
  await expect(today.locator(".helm-later")).toBeHidden();
  await expect(today.locator(".helm-elapsed")).toHaveText(/^29:\d\d$/);
  await expect(today.locator(".helm-of")).toHaveText("/ 2 h");
  // While it runs, Done is the call; the ring has moved off zero.
  await expect(today.locator(".helm-finish")).toHaveClass(/is-primary/);
  const offset = await today.locator(".hp-ring .arc").getAttribute("stroke-dashoffset");
  expect(Number(offset)).toBeLessThan(94);
  await picture(page, "today-running");
});

test("a paused session waits in the hero with Resume", async ({ page }) => {
  await page.goto("/tasks.html?helm&paused&noagents");
  await open(page);
  await goTo(page, "Today", "helm");
  await expect(page.locator(".helm-toggle")).toHaveAttribute("aria-label", "Resume");
  await picture(page, "today-paused");
});

test("what needs him is a strip under the header, and a meeting can be joined", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Today", "helm");
  const needs = page.locator('.screen[data-screen="helm"] .helm-need');
  await expect(needs).toHaveCount(4);
  const meeting = needs.filter({ hasText: "Call z Piotrem" });
  await expect(meeting.locator(".helm-need-side")).toHaveText(/^\d\d:\d\d$/);
  await expect(meeting.locator(".helm-need-join")).toBeVisible();
  // A late reminder says so in the side, in amber.
  await expect(needs.filter({ hasText: "Faktura" })).toHaveClass(/is-late/);
  // Each opens itself in Helm.
  await needs.filter({ hasText: "Faktura" }).locator(".helm-need-main").click();
  expect(await calls(page, "helm_open")).toContainEqual({ path: "/money" });
});

test("Start with Claude opens a terminal on a request, and says when the folder isn't known", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Today", "helm");
  const today = page.locator('.screen[data-screen="helm"]');
  // An agent is already on Now's request, so there is no second Start for it.
  await expect(today.locator(".helm-hero .hp-agent")).toHaveCount(1);
  await expect(today.locator(".helm-claude")).toBeHidden();
  // On a row it is one of the actions that replace the reading under the pointer.
  const logo = today.locator(".day-row").filter({ hasText: "Zmiana logo" });
  await logo.hover();
  await logo.locator(".helm-row-claude").click();
  expect(await calls(page, "helm_start_claude")).toContainEqual({ id: 5 });
  await expect(pillLabel(page)).toHaveText("Claude is on it");
});

test("a session on the Agents screen shows its Helm project, and a finished run asks whether it is done", async ({ page }) => {
  await page.goto("/tasks.html?helm&agents&finished");
  // The question claims the strip before anything is opened.
  await expect(pillLabel(page)).toHaveText("Nowy koszyk B2B done?");
  // Opening the island lands on that session, with the question.
  await open(page);
  const detail = page.locator(".agent-detail");
  await expect(detail.locator(".agent-detail-name")).toHaveText("akcesfonia");
  await expect(detail.locator(".agent-helm-name")).toHaveText("Akcesfonia");
  await expect(detail.locator(".agent-helm-on")).toHaveText("Nowy koszyk B2B");
  await page.waitForTimeout(700);
  await picture(page, "agents-ask");

  // Done: Helm suggests the time — no estimate here, so uncapped, in amber.
  await detail.locator(".agent-ask-done").click();
  await expect(detail.locator(".hp-log-value")).toHaveText("4 h 10");
  await expect(detail.locator(".helm-chip.is-uncapped")).toHaveText("uncapped");
  await expect(detail.locator(".hp-part.is-agent")).toHaveText("3 h 50");
  await expect(detail.locator(".hp-part.is-you")).toHaveText("20 min");
  expect(await calls(page, "helm_request")).toContainEqual({ id: 21, status: "done" });
  await picture(page, "agents-suggest");
  // The minutes can be changed before they are logged.
  await detail.locator(".hp-step").last().click();
  // Onto the next quarter hour, which is what a stepper of time should land on.
  await expect(detail.locator(".hp-log-value")).toHaveText("4 h 15");
  await detail.locator(".hp-log-go").click();
  await expect(detail.locator(".agent-ask-said")).toHaveText("Logged 4 h 15");
  expect(await calls(page, "helm_log")).toContainEqual({ id: 21, minutes: 255 });
  // The question has gone from the strip.
  await expect(pillLabel(page)).not.toHaveText("Nowy koszyk B2B done?");

  // The overview: each card its project, and the request it is on where one is doing.
  await page.locator("#island-back").click();
  const cards = page.locator(".agent-card");
  await expect(cards.filter({ hasText: "codenotch-win" }).locator(".agent-helm-request")).toHaveText("Helm w notchu");
  await expect(cards.filter({ hasText: "esono-price-watch" }).locator(".agent-helm-project")).toHaveText("Esono Repricer");
  await expect(cards.filter({ hasText: "esono-price-watch" }).locator(".agent-helm-request")).toHaveCount(0);
  await page.waitForTimeout(600);
  await picture(page, "agents");
});

test("Not yet puts the question away, and a project's next request starts from the detail", async ({ page }) => {
  await page.goto("/tasks.html?helm&agents&finished");
  await open(page);
  await page.locator("#island-back").click();
  const card = page.locator(".agent-card").filter({ hasText: "akcesfonia" });
  await expect(card.locator(".agent-ask-q")).toHaveText("Nowy koszyk B2B done?");
  await card.locator(".agent-ask-later").click();
  await expect(card.locator(".agent-ask")).toHaveCount(0);
  // Nothing was marked: Not yet leaves the request doing.
  expect(await calls(page, "helm_request")).toEqual([]);

  // Akcesfonia's folder isn't known to Helm: the start says so instead of guessing.
  await card.click();
  await page.locator(".agent-helm-start").first().click();
  await expect(pillLabel(page)).toHaveText("Start with Claude");
  await expect(page.locator("#island-collapsed .pill-value")).toHaveText("Helm doesn't know this project's folder yet.");
});

test("without /api/notch (a Helm that answers 404) the cockpit is simply not there", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/tasks.html?helm&agents&notch=off&finished");
  await open(page);
  await goTo(page, "Today", "helm");
  const today = page.locator('.screen[data-screen="helm"]');
  // Today itself is all there.
  await expect(today.locator(".helm-must-text")).toHaveText("4 in Today");
  await expect(today.locator(".helm-hero-title")).toHaveText("Rynek Czeski — poprawki w koszyku");
  // His own time falls back to the queue's; the agents', the needs, logos and Claude are absent.
  await expect(today.locator(".helm-fig.is-you .helm-fig-value")).toHaveText("3 h 10");
  await expect(today.locator(".helm-fig.is-agents")).toBeHidden();
  await expect(today.locator(".helm-needs")).toBeHidden();
  await expect(today.locator(".hp-logo.has-logo")).toHaveCount(0);
  await expect(today.locator(".helm-claude")).toBeHidden();
  await expect(today.locator(".helm-row-claude")).toHaveCount(0);
  await expect(today.locator(".hp-agent")).toHaveCount(0);
  // Nothing on the strip says anything is wrong — and no question was asked.
  await expect(pillLabel(page)).not.toHaveText(/Helm|done\?/);
  await picture(page, "today-notch-off");
  // The Agents screen is what it always was.
  await goTo(page, "Agents", "agents");
  await expect(page.locator(".agent-helm, .agent-ask, .agent-helm-panel")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the Guardian shows the thread and streams a reply", async ({ page }) => {
  await page.goto("/tasks.html?helm&nudge");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const guardian = page.locator('.screen[data-screen="guardian"]');
  await expect(guardian.locator(".g-msg.is-nudge").last()).toContainText("Przerwa trwa 40 minut");
  // The newest unanswered nudge carries its action and the quick replies.
  await expect(guardian.locator(".g-go")).toHaveText("Start");
  // The day card leads with the queue.
  await expect(guardian.locator(".g-qrow.is-now")).toContainText("Rynek Czeski");
  await expect(guardian.locator(".g-card.is-day")).toBeVisible();
  await picture(page, "guardian");

  const field = guardian.locator(".g-composer .k-input");
  await field.click();
  await field.fill("Przesuń Repricer");
  await page.keyboard.press("Enter");
  await expect(guardian.locator(".g-mine").last()).toContainText("Przesuń Repricer");
  // Its two changes come folded, and open to what they were, each with Cofnij.
  const changes = guardian.locator(".g-changes").last();
  await expect(changes.locator(".g-changes-label")).toHaveText("2 zmiany");
  await changes.locator(".g-changes-head").click();
  await expect(guardian.locator(".g-changes").last().locator(".g-receipt-label").last()).toHaveText("Repricer: reguły cen, 17:00");
  await picture(page, "guardian-reply");
});

test("the Guardian's cards act: time is logged, a reminder sent at a level, a renewal billed", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const guardian = page.locator('.screen[data-screen="guardian"]');
  const time = guardian.locator(".g-card.is-time");
  await expect(time.locator(".hp-log-value")).toHaveText("1 h 30");
  await expect(time.locator(".hp-part.is-agent")).toHaveText("1 h 10");
  // Capped: no amber chip.
  await expect(time.locator(".helm-chip")).toHaveCount(0);
  const reminder = guardian.locator(".g-card.is-reminder");
  await expect(reminder.locator(".g-amount")).toHaveText(/^1\s200\szł$/);
  await expect(reminder.locator(".g-late")).toHaveText("2 dni po terminie");
  const renewal = guardian.locator(".g-card.is-renewal");
  await expect(renewal.locator(".g-amount")).toHaveText(/^120\szł$/);
  await expect(renewal.locator(".k-chip")).toHaveText("co rok");
  await picture(page, "guardian-cards");

  // Time: one step up (a quarter above the hour), then Log — and the card says so.
  await time.locator(".hp-step").last().click();
  await expect(time.locator(".hp-log-value")).toHaveText("1 h 45");
  await time.locator(".hp-log-go").click();
  await expect(guardian.locator(".g-card.is-time .g-card-said")).toHaveText("Zalogowane: 1 h 45");
  expect(await calls(page, "helm_log")).toContainEqual({ id: 1, minutes: 105 });

  // A reminder: the level is chosen on a segmented control, then Send.
  await reminder.locator(".k-seg-item").filter({ hasText: "Stanowczo" }).click();
  await expect(reminder.locator('.k-seg-item[aria-checked="true"]')).toHaveText("Stanowczo");
  await reminder.locator(".g-card-go").click();
  await expect(guardian.locator(".g-card.is-reminder .g-card-said")).toHaveText("Wysłane do ksiegowosc@ubrania.pl");
  expect(await calls(page, "helm_remind")).toContainEqual({ paymentId: "9", level: "firm" });

  // A renewal the client pays for is billed, for its cycle.
  await renewal.locator(".g-card-bill").click();
  await expect(guardian.locator(".g-card.is-renewal .g-card-said")).toHaveText("Faktura wystawiona");
  expect(await calls(page, "helm_renewal")).toContainEqual({ id: "3", action: "bill", send: true, period: "co rok" });
  await picture(page, "guardian-cards-after");
});

test("a reminder Helm already sent at that level shows as sent, with Helm's sentence", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents&remind=sent");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const reminder = page.locator('.screen[data-screen="guardian"] .g-card.is-reminder');
  await reminder.locator(".g-card-go").click();
  await expect(page.locator('.screen[data-screen="guardian"] .g-card.is-reminder .g-card-said')).toHaveText("Uprzejme przypomnienie poszło już 26 paź");
  await expect(page.locator('.screen[data-screen="guardian"] .g-card.is-reminder .g-card-go')).toHaveCount(0);
});

test("a requests card starts one with Claude and marks another done, in place", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const card = page.locator('.screen[data-screen="guardian"] .g-card.is-requests');
  await card.scrollIntoViewIfNeeded();
  // The one Claude is already on has no second Start.
  await expect(card.locator(".g-req").filter({ hasText: "Rynek Czeski" }).locator(".g-req-claude")).toHaveCount(0);
  const filters = card.locator(".g-req").filter({ hasText: "Filtry kategorii" });
  await filters.hover();
  await filters.locator(".g-req-claude").click();
  expect(await calls(page, "helm_start_claude")).toContainEqual({ id: 11 });
  const map = card.locator(".g-req").filter({ hasText: "Mapa strony" });
  await map.hover();
  await map.locator(".g-req-done").click();
  await expect(page.locator('.screen[data-screen="guardian"] .g-card.is-requests .g-req').filter({ hasText: "Mapa strony" })).toHaveClass(/is-done/);
  expect(await calls(page, "helm_request")).toContainEqual({ id: 12, status: "done" });
  // The day card's first thing starts from the card.
  await page.locator('.screen[data-screen="guardian"] .g-qgo').click();
  expect((await calls(page, "helm_queue")).some(one => (one.action as { act: string; key: string }).act === "start" && (one.action as { key: string }).key === "request:1")).toBe(true);
});

test("quick capture: one line to the Guardian, its answer and Cofnij, then it folds away", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents&notch=off");
  await page.waitForTimeout(600);
  // The global key, as the preview stands it in (`helm:capture` is native).
  await page.keyboard.press("Control+Alt+j");
  const field = page.locator(".capture-field");
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  // The bar IS the panel: no screen under it, and no slab of empty black.
  await expect(page.locator('.screen.active')).toBeHidden();
  await expect.poll(async () => (await page.locator("#island-expanded").boundingBox())!.height).toBeLessThan(110);
  await field.fill("Zadzwonić do Piotra w sprawie oferty");
  await page.keyboard.press("Enter");
  await expect(page.locator(".capture-text")).toHaveText("Zapisane, przypomnę jutro o 9:00.");
  await expect(page.locator(".capture-receipt-label")).toHaveText("Przypomnienie: Zadzwonić do Piotra w sprawie oferty");
  // ⚠️ Sent with the capture flag; a Helm without it answers as a chat, which is fine.
  expect(await calls(page, "helm_send")).toContainEqual({ text: "Zadzwonić do Piotra w sprawie oferty", images: [], capture: true, command: null, mentions: null });
  await picture(page, "capture");
  await page.locator(".capture-undo").click();
  await expect(page.locator(".capture-receipt.is-undone")).toHaveCount(1);
  expect(await calls(page, "helm_undo")).toContainEqual({ messageId: 102, index: 0 });
  // Left alone, it folds itself away.
  await page.mouse.move(5, 700);
  await expect(page.locator("#island")).toHaveAttribute("aria-expanded", "false", { timeout: 10_000 });
  await expect(page.locator(".capture")).toBeHidden();
});

test("quick capture from the palette, with the words already typed", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("kupić tonery");
  await page.locator(".palette-row").filter({ hasText: 'Tell the Guardian "kupić tonery"' }).click();
  await expect(page.locator(".capture-receipt-label")).toHaveText("Przypomnienie: kupić tonery");
  // And the plain command opens the empty line.
  await page.keyboard.press("Escape");
  await expect(page.locator(".capture")).toBeHidden();
});

test("without Helm, Today is TickTick's and there is no Guardian", async ({ page }) => {
  await page.goto("/tasks.html");
  await open(page);
  await goTo(page, "Today", "today");
  await expect(page.locator("#inline-composer")).toBeVisible();
  await expect(page.locator('.screen[data-screen="helm"]')).toBeHidden();
});

/* ── Round 2: the kit ──────────────────────────────────────────────────────
 * The composer (grows, @ and /, the draft, Escape), the focus and the project
 * panel, history and search, the folded receipts and the message actions, hold
 * to talk, Today's blocks and the Blocks menu, and the Agents panel. */

/** A microphone the preview can record: an oscillator, so the level moves.
 *  ⚠️ Created inside the press, which is the gesture an AudioContext needs. */
async function fakeMic(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const out = ctx.createMediaStreamDestination();
      osc.connect(out);
      osc.start();
      return out.stream;
    };
  });
}

test("the composer grows with the words, then scrolls; Enter sends and Shift+Enter breaks the line", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const field = page.locator(".g-composer .k-input");
  const one = (await field.boundingBox())!.height;
  await field.click();
  await page.keyboard.type("Pierwsza linijka");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("druga linijka");
  await expect(field).toHaveValue("Pierwsza linijka\ndruga linijka");
  await expect.poll(async () => (await field.boundingBox())!.height).toBeGreaterThan(one + 15);
  // A long line wraps instead of running off the end of the field.
  await field.fill("Przesuń Repricer na jutro rano i daj mi znać, ile zostało do końca tygodnia na Rynku Czeskim — chcę to zamknąć przed piątkiem, bo klient czeka na demo i na fakturę za październik.");
  const wide = await field.evaluate(el => el.scrollWidth <= el.clientWidth + 1);
  expect(wide).toBe(true);
  // Six lines, then it scrolls rather than taking the screen.
  await field.fill(Array.from({ length: 12 }, (_, i) => `linijka ${i + 1}`).join("\n"));
  await expect.poll(async () => (await field.boundingBox())!.height).toBeLessThan(150);
  expect(await field.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  // Send is lit only with words in the field.
  await expect(page.locator(".g-composer .k-send")).toHaveClass(/is-ready/);
  await page.keyboard.press("Escape");
  await expect(field).toHaveValue("");
  await expect(page.locator(".g-composer .k-send")).not.toHaveClass(/is-ready/);
  await field.fill("Co mam dziś?");
  await page.keyboard.press("Enter");
  expect(await calls(page, "helm_send")).toContainEqual({ text: "Co mam dziś?", images: [], focus: null, command: null, mentions: null });
  await expect(field).toHaveValue("");
});

test("@ picks a project into the text and / says what the line is; both go with the message", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const field = page.locator(".g-composer .k-input");
  await field.click();
  await page.keyboard.type("/");
  const pop = page.locator(".g-composer .k-pop");
  await expect(pop.locator(".k-menu-item")).toHaveCount(4);
  await expect(pop.locator(".k-menu-item").first()).toContainText("Zgłoszenie");
  await picture(page, "composer-slash");
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("/request ");
  await page.keyboard.type("Popraw stopkę dla @eso");
  // Words before letters: "eso" is Esono, not Akcesfonia's scattered letters.
  await expect(pop.locator(".k-menu-item").first()).toContainText("Esono Rozwój");
  await expect(pop.locator(".k-menu-item").filter({ hasText: "Akcesfonia" })).toHaveCount(0);
  await expect(pop.locator(".k-menu-item").first().locator(".hp-logo.has-logo")).toHaveCount(1);
  await picture(page, "composer-at");
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("/request Popraw stopkę dla @Esono Rozwój ");
  await expect(page.locator(".g-composer .k-mirror .k-mention")).toHaveText("@Esono Rozwój");
  await expect(page.locator(".g-composer .k-mirror .k-command")).toHaveText("/request");
  // Picked from @ with no focus set, the project becomes the focus too.
  await expect(page.locator(".g-focus .k-pchip-name")).toHaveText("Esono Rozwój");
  await picture(page, "composer-mention");
  // Backspace at its end takes the whole mention, not its last letter.
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(field).toHaveValue("/request Popraw stopkę dla ");
  await page.keyboard.type("@Esono Roz");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  expect(await calls(page, "helm_send")).toContainEqual({
    text: "Popraw stopkę dla @Esono Rozwój", images: [], focus: 3, command: "request", mentions: [3],
  });
});

test("the draft is kept across closing the island and a reload", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const field = page.locator(".g-composer .k-input");
  await field.click();
  await page.keyboard.type("Niedokończona myśl o Repricerze");
  await page.waitForTimeout(400);
  await page.reload();
  await open(page);
  await goTo(page, "Guardian", "guardian");
  await expect(page.locator(".g-composer .k-input")).toHaveValue("Niedokończona myśl o Repricerze");
});

test("the project panel sets the focus, which goes with every message and shows that project's requests", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const guardian = page.locator('.screen[data-screen="guardian"]');
  await guardian.locator(".g-proj-toggle").click();
  await expect(guardian.locator(".g-project")).toHaveClass(/is-open/);
  await guardian.locator(".g-pp-pick").filter({ hasText: "Esono Rozwój" }).click();
  await expect(guardian.locator(".g-focus .k-pchip-name")).toHaveText("Esono Rozwój");
  const requests = guardian.locator(".g-pp-req");
  await expect(requests).toHaveCount(3);
  await expect(requests.filter({ hasText: "Rynek Czeski" })).toHaveClass(/is-doing/);
  // Its open requests start with Claude from here.
  const filters = requests.filter({ hasText: "Filtry kategorii" });
  await filters.hover();
  await filters.locator(".g-pp-claude").click();
  expect(await calls(page, "helm_start_claude")).toContainEqual({ id: 11 });
  await page.waitForTimeout(700);
  await picture(page, "guardian-project");
  // The panel grows the island beside the thread rather than squeezing it.
  const main = await guardian.locator(".g-main").boundingBox();
  expect(Math.round(main!.width)).toBeGreaterThan(640);
  await guardian.locator(".g-composer .k-input").click();
  await page.keyboard.type("Co dalej?");
  await page.keyboard.press("Enter");
  expect((await calls(page, "helm_send")).at(-1)).toMatchObject({ text: "Co dalej?", focus: 3 });
  // × lets the focus go.
  await guardian.locator(".k-pchip-x").click();
  await expect(guardian.locator(".g-focus-pick")).toBeVisible();
});

test("history: the days, a day opened, a search across everything", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const guardian = page.locator('.screen[data-screen="guardian"]');
  await guardian.locator(".g-hist-toggle").click();
  const days = guardian.locator(".g-hist-day");
  await expect(days).toHaveCount(3);
  await expect(days.first().locator(".g-hist-name")).toHaveText("Dziś");
  await expect(days.first()).toHaveClass(/is-on/);
  await page.waitForTimeout(700);
  await picture(page, "guardian-history");
  await days.filter({ hasText: "Wczoraj" }).click();
  await expect(guardian.locator(".g-mine").last()).toHaveText("Co z fakturą dla Ubrania?");
  await expect(guardian.locator(".g-day-chip")).toHaveText("Wczoraj");
  expect(await calls(page, "helm_thread")).toContainEqual({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  // Back to today.
  await guardian.locator(".g-today").click();
  await expect(guardian.locator(".g-day-chip")).toHaveCount(0);
  // A search finds a word in any day, folded ("faktur" → "fakturą"), and opens its day.
  await guardian.locator(".g-search-field").click();
  await page.keyboard.type("faktur");
  const hits = guardian.locator(".g-hist-hit");
  await expect(hits).toHaveCount(3);
  await expect(hits.first().locator("mark")).toHaveText(/faktur/i);
  await picture(page, "guardian-search");
  await hits.filter({ hasText: "Co z" }).click();
  await expect(guardian.locator(".g-day-chip")).toHaveText("Wczoraj");
});

test("a Helm without history, speech or the projects list: the parts are simply not there", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/tasks.html?helm&noagents&history=off&speech=off&projects=off");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const guardian = page.locator('.screen[data-screen="guardian"]');
  await expect(guardian.locator(".g-hist-toggle")).toBeHidden();
  await expect(guardian.locator(".k-mic")).toBeHidden();
  // The @ picker falls back to the cockpit's folders.
  await guardian.locator(".g-composer .k-input").click();
  await page.keyboard.type("@son");
  await expect(guardian.locator(".k-pop .k-menu-item").first()).toContainText("sonocars");
  await expect(pillLabel(page)).not.toHaveText(/Helm|Speech/);
  expect(errors).toEqual([]);
});

test("a reply's message actions: copy, ask again, make it a request", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const reply = page.locator('.screen[data-screen="guardian"] .g-msg.is-reply').filter({ hasText: "Trzy otwarte zgłoszenia" });
  await reply.scrollIntoViewIfNeeded();
  await reply.hover();
  await expect(reply.locator(".g-hover")).toHaveCSS("opacity", "1");
  await reply.locator(".g-hover-copy").click();
  // Through Win32, not the web clipboard (AGENTS 173), and said on the pill.
  await expect(pillLabel(page)).toHaveText("Copied");
  await reply.hover();
  await reply.locator(".g-hover-request").click();
  expect((await calls(page, "helm_send")).at(-1)).toMatchObject({ command: "request", text: expect.stringContaining("Trzy otwarte zgłoszenia") });
});

test("folded receipts open to each change, and Cofnij takes one back", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const changes = page.locator('.screen[data-screen="guardian"] .g-changes').filter({ hasText: "3 zmiany" });
  await changes.scrollIntoViewIfNeeded();
  await expect(changes.locator(".g-receipt")).toHaveCount(0);
  await changes.locator(".g-changes-head").click();
  const open3 = page.locator('.screen[data-screen="guardian"] .g-changes').filter({ hasText: "3 zmiany" });
  await expect(open3.locator(".g-receipt")).toHaveCount(3);
  await expect(open3.locator(".g-undo")).toHaveCount(2);
  await open3.locator(".g-undo").first().click();
  expect(await calls(page, "helm_undo")).toContainEqual({ messageId: 3, index: 0 });
});

test("hold to talk: recording shows its time and level, letting go puts the words in the box (not sent)", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const mic = page.locator(".g-composer .k-mic");
  await expect(mic).toBeVisible();
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator(".g-composer")).toHaveClass(/is-recording/);
  await expect(page.locator(".g-composer .k-rec")).toBeVisible();
  await expect(page.locator(".g-composer .k-rec-time")).toHaveText(/^0:0[1-9]$/, { timeout: 4000 });
  await picture(page, "composer-recording");
  await page.mouse.up();
  await expect(page.locator(".g-composer .k-input")).toHaveValue("Przesuń Repricer na jutro rano", { timeout: 5000 });
  const sent = await calls(page, "helm_transcribe");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ mime: expect.stringMatching(/^audio\/(webm|ogg)$/), lang: "pl" });
  expect(String(sent[0].audio).length).toBeGreaterThan(100);
  // Read before sending: nothing went to the Guardian.
  expect(await calls(page, "helm_send")).toEqual([]);
  await picture(page, "composer-transcribed");
});

test("hold to talk: Escape cancels, a tap does nothing, and Ctrl+Space held in the field talks too", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Guardian", "guardian");
  const mic = page.locator(".g-composer .k-mic");
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator(".g-composer .k-rec-time")).toHaveText(/^0:0[1-9]$/, { timeout: 4000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".g-composer")).not.toHaveClass(/is-recording/);
  await page.mouse.up();
  // A tap is not something said.
  await mic.click();
  await page.waitForTimeout(600);
  expect(await calls(page, "helm_transcribe")).toEqual([]);
  // The key, held while the field has the caret.
  await page.locator(".g-composer .k-input").click();
  await page.keyboard.down("Control");
  await page.keyboard.down(" ");
  await expect(page.locator(".g-composer .k-rec-time")).toHaveText(/^0:0[1-9]$/, { timeout: 4000 });
  await page.keyboard.up(" ");
  await page.keyboard.up("Control");
  await expect(page.locator(".g-composer .k-input")).toHaveValue("Przesuń Repricer na jutro rano", { timeout: 5000 });
});

test("Today is blocks: each folds and stays folded, and the Blocks menu shows or hides each", async ({ page }) => {
  await page.goto("/tasks.html?helm&agents");
  await open(page);
  await goTo(page, "Today", "helm");
  const today = page.locator('.screen[data-screen="helm"]');
  const blocks = ["now", "needs", "agents", "today", "suggested"];
  for (const id of blocks) await expect(today.locator(`.helm-block.is-${id}`)).toBeVisible();
  // The live sessions in brief, each a way to its detail.
  const agents = today.locator(".helm-agent");
  await expect(agents).toHaveCount(3);
  await expect(agents.filter({ hasText: "Akcesfonia" }).locator(".helm-agent-state")).toHaveText("Waiting");
  await picture(page, "today-blocks");
  // Fold Needs you: its strip goes, its count stays on the header.
  await today.locator(".helm-block.is-needs .k-block-head").click();
  await expect(today.locator(".helm-needs")).toBeHidden();
  await expect(today.locator(".helm-block.is-needs .k-count")).toHaveText("4");
  // The Blocks menu switches Agents off.
  await today.locator(".helm-blocks-button").click();
  const menu = today.locator(".helm-blocks-menu");
  await expect(menu.locator(".k-menu-item")).toHaveCount(5);
  await picture(page, "today-blocks-menu");
  await menu.locator(".k-menu-item").filter({ hasText: "Agents" }).click();
  await expect(today.locator(".helm-block.is-agents")).toBeHidden();
  await expect(menu.locator('.k-menu-item[aria-checked="false"]')).toHaveText("Agents");
  await page.keyboard.press("Escape");
  // Both remembered.
  await page.reload();
  await open(page);
  await goTo(page, "Today", "helm");
  await expect(today.locator(".helm-block.is-agents")).toBeHidden();
  await expect(today.locator(".helm-block.is-needs")).not.toHaveClass(/is-open/);
  // A session's project opens beside Today, with its open requests to start.
  await today.locator(".helm-blocks-button").click();
  await today.locator(".helm-blocks-menu .k-menu-item").filter({ hasText: "Agents" }).click();
  await page.keyboard.press("Escape");
  const before = (await page.locator("#island-expanded").boundingBox())!.width;
  await today.locator(".helm-agent").filter({ hasText: "Codenotch" }).click();
  const side = today.locator(".today-side");
  await expect(side).toHaveClass(/is-open/);
  await expect(side.locator(".agent-side-name")).toHaveText("Codenotch");
  await expect.poll(async () => (await page.locator("#island-expanded").boundingBox())!.width).toBeGreaterThan(before + 200);
  await expect(side.locator(".agent-side-row.is-on .k-chip")).toHaveText("On it");
  await side.locator(".agent-side-row").filter({ hasText: "Tryb ambient" }).locator(".agent-side-start").click();
  expect(await calls(page, "helm_start_claude")).toContainEqual({ id: 32 });
  await page.waitForTimeout(700);
  await picture(page, "today-agent-panel");
  // And from there to the session itself.
  await side.locator(".agent-side-open").click();
  await expect(page.locator(".agent-detail .agent-detail-name")).toHaveText("codenotch-win");
});

test("Add to today: the composer is pinned under the list, never over it; a plain line adds, a /command files", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await open(page);
  await goTo(page, "Today", "helm");
  const today = page.locator('.screen[data-screen="helm"]');
  await today.locator(".helm-block.is-suggested .k-block-head").click();
  await page.waitForTimeout(900);
  // The list ends above the foot: no row is under the field.
  const overlap = await page.evaluate(() => {
    const foot = document.querySelector('.screen[data-screen="helm"] .helm-foot')!.getBoundingClientRect();
    const list = document.querySelector('.screen[data-screen="helm"] .helm-list')!.getBoundingClientRect();
    return list.bottom - foot.top;
  });
  expect(overlap).toBeLessThanOrEqual(0.5);
  expect(await today.locator(".helm-foot").evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(0, 0, 0)");
  const field = today.locator(".helm-composer .k-input");
  await field.click();
  await page.keyboard.type("Zadzwonić do Piotra");
  await page.keyboard.press("Enter");
  expect(await calls(page, "helm_queue")).toContainEqual({ action: { act: "add", title: "Zadzwonić do Piotra" } });
  await page.keyboard.type("/");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Klient woli wtorki");
  await page.keyboard.press("Enter");
  expect(await calls(page, "helm_send")).toContainEqual({ text: "Klient woli wtorki", images: [], capture: true, command: "note", mentions: null });
  await expect(pillLabel(page)).toHaveText("Guardian", { timeout: 5000 });
});

test("the Agents screen: a session's project opens beside it, with its open requests to start", async ({ page }) => {
  await page.goto("/tasks.html?helm&agents");
  await open(page);
  await goTo(page, "Agents", "agents");
  const before = (await page.locator("#island-expanded").boundingBox())!.width;
  await page.locator(".agent-card").filter({ hasText: "codenotch-win" }).locator(".agent-helm-door").click();
  const side = page.locator('.screen[data-screen="agents"] .agent-side');
  await expect(side).toHaveClass(/is-open/);
  await expect(side.locator(".agent-side-name")).toHaveText("Codenotch");
  // The card was not opened: the overview stays, the island grows by the panel.
  await expect(page.locator(".agent-grid")).toBeVisible();
  await expect.poll(async () => (await page.locator("#island-expanded").boundingBox())!.width).toBeGreaterThan(before + 200);
  await expect(side.locator(".agent-side-row.is-on")).toContainText("Helm w notchu");
  await side.locator(".agent-side-row").filter({ hasText: "Tryb ambient" }).locator(".agent-side-start").click();
  expect(await calls(page, "helm_start_claude")).toContainEqual({ id: 32 });
  await page.waitForTimeout(600);
  await picture(page, "agents-panel");
  await side.locator(".agent-side-close").click();
  await expect(side).not.toHaveClass(/is-open/);
});

test("quick capture takes / and @ too, under the field, and the island grows to show them", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents");
  await page.waitForTimeout(600);
  await page.keyboard.press("Control+Alt+j");
  await expect(page.locator(".capture-field")).toBeFocused();
  const closed = (await page.locator("#island-expanded").boundingBox())!.height;
  await page.keyboard.type("/");
  await expect(page.locator(".capture .k-pop .k-menu-item")).toHaveCount(4);
  await expect.poll(async () => (await page.locator("#island-expanded").boundingBox())!.height).toBeGreaterThan(closed + 100);
  await picture(page, "capture-slash");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Kupić tonery");
  await page.keyboard.press("Enter");
  expect(await calls(page, "helm_send")).toContainEqual({ text: "Kupić tonery", images: [], capture: true, command: "request", mentions: null });
});
