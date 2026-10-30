import { test, expect, type Page } from "@playwright/test";

/* Moments (30 Oct): the island's notifications — moments.ts, moment-feed.ts,
 * moment-glance.ts. The preview stages each through the real path with
 * `&moment=finished,question,usage,nudge,block,meeting` (moment-feed.ts
 * `stage`): two readings of the sessions, a provider reading, a planned
 * block two minutes out, a meeting five minutes out, Helm's `?nudge`. What
 * the buttons asked for is read back from `window.__helmCalls`. A picture of
 * each moment goes where `MOMENT_SHOTS` says. */

async function calls(page: Page, command: string) {
  return page.evaluate(name => (window as unknown as { __helmCalls: { command: string; args: Record<string, unknown> }[] })
    .__helmCalls.filter(one => one.command === name).map(one => one.args), command);
}

async function picture(page: Page, name: string) {
  await page.waitForTimeout(700);
  const box = await page.locator("#island").boundingBox();
  if (!box) return;
  const dir = process.env.MOMENT_SHOTS ?? "test-results";
  await page.screenshot({ path: `${dir}/moment-${name}.png`, clip: { x: box.x - 24, y: 0, width: box.width + 48, height: box.y + box.height + 24 } });
}

const moment = (page: Page) => page.locator("#island-moment");
const panel = (page: Page) => page.locator("#island-expanded");

test("an agent finishing: its project and last line in Claude's colour, and it waits until dismissed", async ({ page }) => {
  await page.clock.install();
  await page.goto("/tasks.html?noagents&nocal&moment=finished");
  await expect(moment(page)).toBeVisible();
  await expect(moment(page)).toHaveAttribute("data-kind", "finished");
  await expect(moment(page)).toHaveAttribute("data-agent", "claude");
  await expect(moment(page).locator(".m-title")).toHaveText("codenotch");
  await expect(moment(page).locator(".m-line")).toContainText("Moments are in");
  // Claude's orange (--mark-claude), not green, on the badge and the kicker.
  await expect(moment(page).locator(".m-badge")).toHaveCSS("background-color", "rgb(217, 119, 87)");
  await expect(moment(page).locator(".m-close")).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await picture(page, "finished");
  // Sticky (AGENTS 879): still there long after, for when he comes back.
  await page.clock.fastForward(60_000);
  await expect(moment(page)).toBeVisible();
  // Escape is its ×.
  await page.keyboard.press("Escape");
  await expect(moment(page)).toBeHidden();
  await expect(panel(page)).toBeHidden();
});

test("several agents done fold into one: Open takes the first, the rest stays", async ({ page }) => {
  await page.goto("/tasks.html?noagents&nocal&moment=finished,finished2");
  await expect(moment(page).locator(".m-kicker")).toHaveText("2 done");
  await expect(moment(page).locator(".m-title")).toHaveText("codenotch, akcesfonia");
  await expect(moment(page).locator('[data-act="jump"]')).toHaveText("Open codenotch");
  await picture(page, "finished-two");
  await moment(page).locator('[data-act="jump"]').click();
  expect(await calls(page, "focus_session")).toEqual([{ pid: 4242, hint: "codenotch" }]);
  await expect(moment(page).locator(".m-kicker")).toHaveText("Done");
  await expect(moment(page).locator(".m-title")).toHaveText("akcesfonia");
  await moment(page).locator(".m-close").click();
  await expect(moment(page)).toBeHidden();
});

test("Open on a finished agent raises its window", async ({ page }) => {
  await page.goto("/tasks.html?noagents&nocal&moment=finished");
  await moment(page).locator('[data-act="jump"]').click();
  await expect(moment(page)).toBeHidden();
  expect(await calls(page, "focus_session")).toEqual([{ pid: 4242, hint: "codenotch" }]);
});

test("an agent asking is sticky: it stays until answered or dismissed", async ({ page }) => {
  await page.clock.install();
  await page.goto("/tasks.html?noagents&nocal&moment=question");
  await expect(moment(page)).toHaveAttribute("data-kind", "question");
  await expect(moment(page).locator(".m-line")).toContainText("weekly review");
  await picture(page, "question");
  await page.clock.fastForward(30_000);
  await expect(moment(page)).toBeVisible();
  await moment(page).locator(".m-close").click();
  await expect(moment(page)).toBeHidden();
  // ⚠️ The pill's own "waiting" claim is the Agents screen's (screen-agents.ts), which the staged sessions do not reach.
});

test("running low on usage: what is left and when it resets, once", async ({ page }) => {
  await page.goto("/tasks.html?noagents&nocal&moment=usage");
  await expect(moment(page)).toHaveAttribute("data-kind", "usage");
  await expect(moment(page).locator(".m-kicker")).toHaveText("7% left");
  await expect(moment(page).locator(".m-line")).toHaveText(/Resets in 1 h 1[78] min/);
  await picture(page, "usage");
});

test("a Guardian nudge: its action, Helm's quick replies and Open; sticky; the action starts the work", async ({ page }) => {
  await page.clock.install();
  await page.goto("/tasks.html?helm&nudge&noagents&nocal&moment=nudge");
  await expect(moment(page)).toHaveAttribute("data-kind", "nudge");
  await expect(moment(page).locator(".m-title")).toHaveText("Przerwa trwa 40 minut");
  await expect(moment(page).locator(".m-chip")).toHaveText(["Zaczynam", "Za duże, daj 10 minut", "Dziś wolne"]);
  await expect(moment(page).locator(".m-btn.is-primary")).toHaveCount(1);
  // Not the Guardian's whole page any more.
  await expect(panel(page)).toBeHidden();
  await picture(page, "nudge");
  await page.clock.fastForward(30_000);
  await expect(moment(page)).toBeVisible();
  await moment(page).locator('[data-act="go"]').click();
  await expect(moment(page)).toBeHidden();
  const acts = await calls(page, "helm_act");
  expect(acts.some(a => (a.action as { do: string }).do === "read")).toBe(true);
});

test("a quick reply on a nudge is sent to the Guardian", async ({ page }) => {
  await page.goto("/tasks.html?helm&nudge&noagents&nocal&moment=nudge");
  await moment(page).locator(".m-chip").first().click();
  await expect(moment(page)).toBeHidden();
  expect((await calls(page, "helm_send")).map(a => a.text)).toEqual(["Zaczynam"]);
});

test("a planned block two minutes out: Start starts it", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents&nocal&moment=block");
  await expect(moment(page)).toHaveAttribute("data-kind", "block");
  await expect(moment(page).locator(".m-kicker")).toHaveText("Za 2 min");
  await expect(moment(page).locator(".m-title")).toHaveText("Repricer — testy koszyka");
  await picture(page, "block");
  await moment(page).locator('[data-act="start:77"]').click();
  await expect(moment(page)).toBeHidden();
  expect((await calls(page, "helm_act")).map(a => a.action)).toContainEqual({ do: "start", block: 77 });
});

test("a meeting five minutes out: Join opens its link, and it folds by itself", async ({ page }) => {
  await page.goto("/tasks.html?noagents&nocal&moment=meeting");
  await expect(moment(page)).toHaveAttribute("data-kind", "meeting");
  await expect(moment(page).locator(".m-kicker")).toHaveText("Za 5 min");
  await picture(page, "meeting");
  await moment(page).locator('[data-act="join"]').click();
  expect(await calls(page, "open_external")).toEqual([{ url: "https://meet.google.com/demo" }]);
});

test("several queue and play one at a time, by priority", async ({ page }) => {
  await page.clock.install();
  await page.goto("/tasks.html?noagents&nocal&moment=finished,usage,meeting");
  await expect(moment(page)).toHaveAttribute("data-kind", "meeting");
  await page.clock.fastForward(7000);
  await expect(moment(page)).toHaveAttribute("data-kind", "usage");
  await page.clock.fastForward(7000);
  await expect(moment(page)).toHaveAttribute("data-kind", "finished");
  // The finished one is sticky now: it stays.
  await page.clock.fastForward(7000);
  await expect(moment(page)).toHaveAttribute("data-kind", "finished");
});

/** A microphone the preview can record (voice.spec.ts's). */
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

test("the voice wins: a moment waits under a spoken turn and comes back after", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents&nocal&moment=question");
  await expect(moment(page)).toBeVisible();
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await expect(page.locator("#island-voice")).toBeVisible();
  await expect(moment(page)).toBeHidden();
  await page.waitForTimeout(600);
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
  // The reply, read; Escape folds it; the question is still there.
  await expect(page.locator("#island-voice .v-answer")).toContainText("Dobrze", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator("#island-voice")).toBeHidden();
  await expect(moment(page)).toBeVisible();
  await expect(moment(page)).toHaveAttribute("data-kind", "question");
});

/* ── Batch 12: the Guardian's own moments (`&hmoment=…`, task-client.ts
 * `demoMoments`), from `/api/notch`'s `moments`. ── */

const helmUrl = (kinds: string, more = "") => `/tasks.html?helm&noagents&nocal&hmoment=${kinds}${more}`;
const notchPosts = async (page: Page) => (await calls(page, "helm_notch_post")).map(a => ({ path: a.path, body: a.body }));

test("Helm's prep: the Guardian's colour, its detail lines, Join opens the link", async ({ page }) => {
  await page.goto(helmUrl("prep"));
  await expect(moment(page)).toHaveAttribute("data-kind", "helm");
  await expect(moment(page)).toHaveAttribute("data-tone", "guardian");
  await expect(moment(page).locator(".m-title")).toHaveText("Za 5 min: Esono");
  await expect(moment(page).locator(".m-detail dt")).toHaveText(["Status", "Zapytaj", "Uważaj"]);
  await expect(moment(page).locator(".m-btn.is-primary")).toHaveCount(1);
  await picture(page, "helm-prep");
  await moment(page).locator('[data-act="h:0"]').click();
  await expect(moment(page)).toBeHidden();
  expect(await calls(page, "open_external")).toEqual([{ url: "https://meet.google.com/demo" }]);
});

test("Helm's prep for a meeting replaces the notch's own Za 5 min for it", async ({ page }) => {
  await page.clock.install();
  await page.goto(helmUrl("prep", "&moment=meeting"));
  await expect(moment(page)).toHaveAttribute("data-kind", "helm");
  // The prep folds by itself (not sticky); the local meeting moment never comes.
  await page.clock.fastForward(8000);
  await expect(moment(page)).toBeHidden();
  await page.clock.fastForward(8000);
  await expect(moment(page)).toBeHidden();
});

test("× on a Helm moment tells Helm, and it does not come back", async ({ page }) => {
  await page.goto(helmUrl("wrap"));
  await expect(moment(page)).toHaveAttribute("data-tone", "guardian");
  await picture(page, "helm-wrap");
  await moment(page).locator(".m-close").click();
  await expect(moment(page)).toBeHidden();
  expect(await notchPosts(page)).toEqual([{ path: "/api/notch/moments", body: { id: "wrap:work:kowalski-1", action: "dismiss" } }]);
  await page.waitForTimeout(1500);
  await expect(moment(page)).toBeHidden();
});

test("a drift's +15 min is the queue act as Helm sent it", async ({ page }) => {
  await page.goto(helmUrl("drift"));
  await expect(moment(page)).toHaveAttribute("data-tone", "warn");
  await expect(moment(page).locator(".m-btn")).toHaveText(["+15 min", "Zrobione", "Nie dziś"]);
  await picture(page, "helm-drift");
  await moment(page).locator('[data-act="h:0"]').click();
  await expect(moment(page)).toBeHidden();
  expect((await calls(page, "helm_queue")).map(a => a.action)).toContainEqual({ act: "extend", block: 2, minutes: 15 });
});

test("a reminder's Wyślij posts under /api/notch/, and a refusal brings it back", async ({ page }) => {
  await page.goto(helmUrl("remind", "&hpost=fail"));
  await expect(moment(page)).toHaveAttribute("data-tone", "warn");
  await picture(page, "helm-remind");
  await moment(page).locator('[data-act="h:0"]').click();
  expect(await notchPosts(page)).toEqual([{ path: "/api/notch/reminders/7", body: null }]);
  // Helm said 409: it is up again for another try.
  await expect(moment(page)).toBeVisible();
  await expect(moment(page).locator(".m-title")).toHaveText("Ubrania: 1 200 zł, 2 dni po terminie");
});

test("a request's Wyślij posts its reply and the moment goes", async ({ page }) => {
  await page.goto(helmUrl("request"));
  await expect(moment(page).locator(".m-line")).toContainText("Wycena obejmuje");
  await picture(page, "helm-request");
  await moment(page).locator('[data-act="h:0"]').click();
  await expect(moment(page)).toBeHidden();
  expect(await notchPosts(page)).toEqual([{ path: "/api/notch/requests/9/reply", body: null }]);
});

test("an idle drift's 10 minut asks the Guardian, answered on the voice glance", async ({ page }) => {
  await page.goto(helmUrl("idle"));
  await picture(page, "helm-idle");
  await moment(page).locator('[data-act="h:0"]').click();
  await expect(page.locator("#island-voice")).toBeVisible();
  await expect(page.locator("#island-voice .v-answer")).toContainText("Dobrze", { timeout: 15_000 });
  const sent = await calls(page, "helm_send");
  expect(sent.map(a => a.text)).toEqual(["Rozbij to na pierwszy krok na 10 minut"]);
  // Read, not said: no sentence went to the voice.
  expect(await calls(page, "voice_say")).toEqual([]);
});

test("a wrap-up's Opowiedz starts a hands-free turn sent with command wrap and the meeting", async ({ page }) => {
  await fakeMic(page);
  await page.goto(helmUrl("wrap"));
  await moment(page).locator('[data-act="h:0"]').click();
  await expect(page.locator("#island-voice")).toBeVisible();
  await expect(moment(page)).toBeHidden();
  // Hands-free, as a tap of Alt+Q: it listens with no key held until Enter.
  await expect(page.locator("#island-voice")).toHaveAttribute("data-phase", "listening");
  await expect(page.locator("#island-voice")).toHaveAttribute("data-free", "true");
  await expect(page.locator("#island-voice .v-time")).toHaveText(/^0:0[2-9]$/, { timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page, "helm_send")).length, { timeout: 10_000 }).toBe(1);
  const [body] = await calls(page, "helm_send");
  expect(body).toMatchObject({ text: "Przesuń Repricer na jutro rano", command: "wrap", meeting: "work:kowalski-1", voice: true });
});

test("the close moment opens closing the day", async ({ page }) => {
  await page.goto(helmUrl("close"));
  await expect(moment(page)).toHaveAttribute("data-tone", "good");
  await picture(page, "helm-close");
  await moment(page).locator('[data-act="h:0"]').click();
  await expect(page.locator(".helm-close")).toBeVisible();
  await expect(page.locator(".hc-title")).toHaveText("Zamykamy dzień");
});
