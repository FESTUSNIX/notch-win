import { test, expect, type Page } from "@playwright/test";

/* Talking with the Guardian from anywhere (29 Oct): hold the talk key, speak,
 * let go; the Guardian's reply streams into the thread and is said sentence by
 * sentence. Natively the key is `voice.rs` and the voice is played in Rust;
 * here Alt+Q held in the page stands in for the key (tasks.ts), and
 * `voice_say` only keeps time (task-client.ts). What the preview was asked to
 * do is read back from `window.__helmCalls`. Staged: `?call` (in a call),
 * `?spoken=off` (Settings → Spoken replies off). */

/** A microphone the preview can record: an oscillator, so the level moves.
 *  ⚠️ Created inside the press, which is the gesture an AudioContext needs. */
async function fakeMic(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.4;
      const out = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(out);
      osc.start();
      return out.stream;
    };
  });
}

/** What the preview was asked to do. */
async function calls(page: Page, command: string) {
  return page.evaluate(name => (window as unknown as { __helmCalls: { command: string; args: Record<string, unknown> }[] })
    .__helmCalls.filter(one => one.command === name).map(one => one.args), command);
}

/** ⚠️ A clipped page screenshot, not a locator one: the island ticks every
 *  second and a locator screenshot waits for a stillness that never comes. */
async function picture(page: Page, name: string) {
  const box = await page.locator("#island-expanded").boundingBox();
  if (!box) return;
  await page.screenshot({ path: `test-results/voice-${name}.png`, clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
}

const strip = (page: Page) => page.locator(".v-strip");
const guardian = (page: Page) => page.locator('.screen[data-screen="guardian"]');

async function hold(page: Page) {
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
}
async function letGo(page: Page) {
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
}

/** The tallest bar in the strip's wave, 0..1. */
const loudest = (page: Page) => page.locator(".v-wave i").evaluateAll(bars =>
  Math.max(...bars.map(bar => Number((bar as HTMLElement).style.getPropertyValue("--h")) || 0)));

test("hold to talk from anywhere: the island listens, the words go to the Guardian, and its reply is said a sentence at a time", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await expect(page.locator("#island-expanded")).toBeHidden();

  await hold(page);
  // The island comes up by itself, on the Guardian, listening.
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toHaveAttribute("data-phase", "listening");
  await expect(guardian(page)).toBeVisible();
  await expect(guardian(page).locator(".g-composer")).toBeHidden();
  await expect(page.locator(".v-time")).toHaveText(/^0:0[1-9]$/, { timeout: 4000 });
  await expect.poll(() => loudest(page), { timeout: 3000 }).toBeGreaterThan(0.2);
  expect((await calls(page, "voice_escape"))[0]).toEqual({ on: true });
  // The shape has to settle before a picture of it means anything.
  await page.waitForTimeout(900);
  await picture(page, "listening");
  await letGo(page);

  // His words in the thread, sent as spoken.
  await expect(guardian(page).locator(".g-mine").last()).toContainText("Przesuń Repricer na jutro rano", { timeout: 5000 });
  const sent = await calls(page, "helm_send");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ text: "Przesuń Repricer na jutro rano", voice: true });
  await expect(strip(page)).toHaveAttribute("data-phase", /thinking|speaking/);

  // The first sentence is said while the second is still being written.
  await expect.poll(async () => (await calls(page, "voice_say")).length, { timeout: 5000 }).toBeGreaterThan(0);
  const live = await guardian(page).locator(".g-reply").last().innerText();
  expect(live).not.toContain("dwie rzeczy");
  expect((await calls(page, "voice_say"))[0]).toMatchObject({ text: "Dobrze, przesunąłem Repricer na siedemnastą.", seq: 0 });
  await expect(strip(page)).toHaveAttribute("data-phase", "speaking");
  await expect.poll(() => loudest(page), { timeout: 3000 }).toBeGreaterThan(0.3);
  await picture(page, "speaking");

  // Then the next, in the same turn; then it's over and the composer is back.
  await expect.poll(async () => (await calls(page, "voice_say")).length, { timeout: 6000 }).toBe(2);
  const [first, second] = await calls(page, "voice_say");
  expect(second).toMatchObject({ text: "Zostały ci dziś dwie rzeczy.", seq: 1, turn: first.turn });
  await expect(strip(page)).toBeHidden({ timeout: 8000 });
  await expect(guardian(page).locator(".g-composer")).toBeVisible();
  expect((await calls(page, "voice_escape")).at(-1)).toEqual({ on: false });
  // Its receipt is the chat's as ever, and the island stays up a moment to read.
  await expect(guardian(page).locator(".g-reply").last()).toContainText("Zostały ci dziś dwie rzeczy.");
  await expect(page.locator("#island-expanded")).toBeVisible();
  await picture(page, "after");
});

test("a press under half a second does nothing at all", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await hold(page);
  await page.waitForTimeout(180);
  await letGo(page);
  await page.waitForTimeout(800);
  await expect(strip(page)).toBeHidden();
  await expect(page.locator("#island-expanded")).toBeHidden();
  expect(await calls(page, "helm_transcribe")).toEqual([]);
  expect(await calls(page, "helm_send")).toEqual([]);
});

test("barge-in: holding the key while it speaks stops the voice and listens; the answer is the next turn", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await hold(page);
  await expect(strip(page)).toHaveAttribute("data-phase", "listening");
  await page.waitForTimeout(700);
  await letGo(page);
  await expect(strip(page)).toHaveAttribute("data-phase", "speaking", { timeout: 6000 });
  const turn = (await calls(page, "voice_say"))[0].turn as number;

  await hold(page);
  await expect.poll(async () => (await calls(page, "voice_hush")).length).toBe(1);
  await expect(strip(page)).toHaveAttribute("data-phase", "listening");
  await page.waitForTimeout(700);
  await letGo(page);
  // The old reply finishes as text; then the new words go, and its reply is a new turn.
  await expect.poll(async () => (await calls(page, "helm_send")).length, { timeout: 8000 }).toBe(2);
  await expect.poll(async () => (await calls(page, "voice_say")).filter(one => one.turn === turn + 1).length, { timeout: 8000 }).toBeGreaterThan(0);
  const next = (await calls(page, "voice_say")).find(one => one.turn === turn + 1)!;
  expect(next.seq).toBe(0);
  await expect(strip(page)).toBeHidden({ timeout: 10_000 });
});

test("Escape stops everything: while listening nothing is sent, while speaking the voice stops", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await hold(page);
  await expect(strip(page)).toHaveAttribute("data-phase", "listening");
  await page.keyboard.press("Escape");
  await expect(strip(page)).toBeHidden();
  await letGo(page);
  await page.waitForTimeout(700);
  expect(await calls(page, "helm_transcribe")).toEqual([]);
  expect((await calls(page, "voice_escape")).at(-1)).toEqual({ on: false });

  await hold(page);
  await page.waitForTimeout(800);
  await letGo(page);
  await expect(strip(page)).toHaveAttribute("data-phase", "speaking", { timeout: 6000 });
  const hushed = (await calls(page, "voice_hush")).length;
  await page.locator(".v-stop").click();
  await expect(strip(page)).toBeHidden();
  expect((await calls(page, "voice_hush")).length).toBe(hushed + 1);
  // What is left of the reply comes as text, and is not said.
  await expect(guardian(page).locator(".g-reply").last()).toContainText("dwie rzeczy", { timeout: 6000 });
  expect((await calls(page, "voice_say")).length).toBe(1);
});

test("in a call the reply is text only, and says why", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents&call");
  await hold(page);
  await expect(strip(page)).toHaveAttribute("data-phase", "listening");
  await page.waitForTimeout(700);
  await letGo(page);
  await expect(page.locator(".v-quiet")).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".v-quiet")).toHaveAttribute("data-tip", "Text only: you're in a call");
  await picture(page, "in-a-call");
  await expect(guardian(page).locator(".g-reply").last()).toContainText("dwie rzeczy", { timeout: 6000 });
  await expect(strip(page)).toBeHidden({ timeout: 6000 });
  expect(await calls(page, "voice_say")).toEqual([]);
  // The island waits longer when nothing was heard.
  await page.waitForTimeout(6500);
  await expect(page.locator("#island-expanded")).toBeVisible();
});

test("with Spoken replies off it never asks for the voice", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents&spoken=off");
  await hold(page);
  await expect(strip(page)).toHaveAttribute("data-phase", "listening");
  await page.waitForTimeout(700);
  await letGo(page);
  await expect(page.locator(".v-quiet")).toHaveAttribute("data-tip", "Text only: spoken replies are off", { timeout: 5000 });
  await expect(strip(page)).toBeHidden({ timeout: 8000 });
  await expect(guardian(page).locator(".g-reply").last()).toContainText("dwie rzeczy");
  expect(await calls(page, "voice_say")).toEqual([]);
  expect(await calls(page, "voice_quiet")).toEqual([]);
});

test("signed out, holding the key says so on the pill and opens nothing", async ({ page }) => {
  await page.goto("/tasks.html?noagents");
  await hold(page);
  await page.waitForTimeout(800);
  await letGo(page);
  await expect(page.locator("#island-collapsed .pill-label")).toContainText(/Guardian/, { timeout: 3000 });
  await expect(strip(page)).toBeHidden();
  expect(await calls(page, "helm_send")).toEqual([]);
});
