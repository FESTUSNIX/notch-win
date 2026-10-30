import { test, expect, type Page } from "@playwright/test";

/* Talking with the Guardian from anywhere (29 Oct, round 2): hold the talk
 * key, speak, let go — or TAP it and talk hands-free until Enter, another tap
 * or Escape. The turn shows in the island's voice glance, never on the
 * Guardian's screen; the reply is written in word by word as it is said.
 * Natively the key is `voice.rs` and the voice is played in Rust; here Alt+Q
 * in the page stands in for the key (tasks.ts) and `voice_say` only keeps
 * time (task-client.ts). What the preview was asked to do is read back from
 * `window.__helmCalls`. Staged: `?call` (in a call), `?spoken=off`,
 * `&pace=n` (the whole turn n times slower), `&voicecard` (a card). */

/** A microphone the preview can record: an oscillator, so the level moves.
 *  `delay` is how long it takes to open (a Bluetooth headset switching
 *  profile); the last stream is kept on `window.__mic` so a test can lose it.
 *  ⚠️ Created inside the press, which is the gesture an AudioContext needs. */
async function fakeMic(page: Page, delay = 0) {
  await page.addInitScript(ms => {
    navigator.mediaDevices.getUserMedia = async () => {
      if (ms) await new Promise(done => setTimeout(done, ms));
      const ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.4;
      const out = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(out);
      osc.start();
      (window as unknown as { __mic: MediaStream }).__mic = out.stream;
      return out.stream;
    };
  }, delay);
}

/** What the preview was asked to do. */
async function calls(page: Page, command: string) {
  return page.evaluate(name => (window as unknown as { __helmCalls: { command: string; args: Record<string, unknown> }[] })
    .__helmCalls.filter(one => one.command === name).map(one => one.args), command);
}
const count = async (page: Page, command: string) => (await calls(page, command)).length;

/** A picture of the island. ⚠️ A clipped page screenshot, not a locator one:
 *  the island ticks and a locator screenshot waits for a stillness that never comes. */
async function picture(page: Page, name: string) {
  const box = await page.locator("#island").boundingBox();
  if (!box) return;
  const dir = process.env.VOICE_SHOTS ?? "test-results";
  await page.screenshot({ path: `${dir}/voice-${name}.png`, clip: { x: box.x - 24, y: 0, width: box.width + 48, height: box.y + box.height + 24 } });
}

const glance = (page: Page) => page.locator("#island-voice");
const panel = (page: Page) => page.locator("#island-expanded");

async function hold(page: Page) {
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
}
async function letGo(page: Page) {
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
}
async function tap(page: Page) {
  await hold(page);
  await page.waitForTimeout(120);
  await letGo(page);
}
/** Held for `ms`, then let go. */
async function say(page: Page, ms = 900) {
  await hold(page);
  await page.waitForTimeout(ms);
  await letGo(page);
}

/** The tallest bar in the glance's wave, 0..1. */
const loudest = (page: Page) => page.locator(".v-wave i").evaluateAll(bars =>
  Math.max(...bars.map(bar => Number((bar as HTMLElement).style.getPropertyValue("--h")) || 0)));

test("hold to talk opens the voice glance, never the Guardian's screen, and writes the reply in as it is said", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await expect(panel(page)).toBeHidden();

  await hold(page);
  await expect(glance(page)).toBeVisible();
  await expect(glance(page)).toHaveAttribute("data-phase", "listening");
  await expect(glance(page)).toHaveAttribute("data-free", "false");
  await expect(page.locator(".v-keys")).toBeHidden();
  await expect(page.locator(".v-time")).toHaveText(/^0:0[1-9]$/, { timeout: 4000 });
  await expect.poll(() => loudest(page), { timeout: 3000 }).toBeGreaterThan(0.2);
  expect((await calls(page, "voice_keys"))[0]).toEqual({ escape: true, enter: false });
  await letGo(page);

  // His words, as one line; sent as spoken.
  await expect(page.locator(".v-said-text")).toHaveText("Przesuń Repricer na jutro rano", { timeout: 5000 });
  expect((await calls(page, "helm_send"))[0]).toMatchObject({ text: "Przesuń Repricer na jutro rano", voice: true });
  // The receipt is a chip; Cofnij comes once Helm has saved the reply.
  await expect(page.locator(".v-rc")).toHaveCount(1, { timeout: 5000 });
  // The first sentence is said while the reply is still being written, and the words arrive one by one.
  await expect.poll(() => count(page, "voice_say"), { timeout: 5000 }).toBeGreaterThan(0);
  expect((await calls(page, "voice_say"))[0]).toMatchObject({ text: "Dobrze, przesunąłem Repricer na siedemnastą.", seq: 0 });
  const early = await page.locator(".v-answer .v-w").count();
  expect(early).toBeLessThan(10);
  await expect.poll(() => page.locator(".v-answer .v-w").count(), { timeout: 8000 }).toBe(10);
  await expect(page.locator(".v-answer")).toHaveText("Dobrze, przesunąłem Repricer na siedemnastą. Zostały ci dziś dwie rzeczy.");
  await expect(page.locator(".v-rc-undo")).toBeVisible();
  await expect(panel(page)).toBeHidden();

  // Over: up a moment to read, then folded, with the keys given back.
  await expect(glance(page)).toHaveAttribute("data-phase", "done", { timeout: 8000 });
  await expect(glance(page)).toBeVisible();
  await expect(glance(page)).toBeHidden({ timeout: 12_000 });
  expect((await calls(page, "voice_keys")).at(-1)).toEqual({ escape: false, enter: false });
  await expect(panel(page)).toBeHidden();
});

test("a tap is hands-free: it keeps listening with Enter and Esc on screen, and Enter sends", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await tap(page);
  await expect(glance(page)).toHaveAttribute("data-phase", "listening");
  await expect(glance(page)).toHaveAttribute("data-free", "true");
  await expect(page.locator(".v-lock")).toBeVisible();
  await expect(page.locator(".v-keys .v-key")).toHaveText(["Enter", "Esc"]);
  expect((await calls(page, "voice_keys")).at(-1)).toEqual({ escape: true, enter: true });
  // No key is held, and it goes on listening.
  await expect(page.locator(".v-time")).toHaveText(/^0:0[2-9]$/, { timeout: 5000 });
  expect(await count(page, "helm_transcribe")).toBe(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => count(page, "helm_transcribe")).toBe(1);
  // Enter goes back at once; Escape stays for the reply.
  expect((await calls(page, "voice_keys")).at(-1)).toEqual({ escape: true, enter: false });
  await expect(page.locator(".v-said-text")).toHaveText("Przesuń Repricer na jutro rano", { timeout: 5000 });
  await expect(glance(page)).toBeHidden({ timeout: 20_000 });
  expect((await calls(page, "voice_keys")).at(-1)).toEqual({ escape: false, enter: false });
});

test("hands-free: another tap sends, and Escape drops it without sending", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await tap(page);
  await page.waitForTimeout(1200);
  await tap(page);
  await expect.poll(() => count(page, "helm_transcribe")).toBe(1);
  await expect(glance(page)).toHaveAttribute("data-phase", /thinking|speaking/, { timeout: 5000 });
  await page.keyboard.press("Escape");
  await expect(glance(page)).toBeHidden();

  await tap(page);
  await expect(glance(page)).toHaveAttribute("data-free", "true");
  await page.waitForTimeout(900);
  await page.keyboard.press("Escape");
  await expect(glance(page)).toBeHidden();
  await page.waitForTimeout(800);
  expect(await count(page, "helm_transcribe")).toBe(1);
  expect((await calls(page, "voice_keys")).at(-1)).toEqual({ escape: false, enter: false });
});

test("barge-in: holding while it speaks stops the voice and listens; a tap while it speaks only stops it", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await say(page, 700);
  await expect(glance(page)).toHaveAttribute("data-phase", "speaking", { timeout: 6000 });
  const turn = (await calls(page, "voice_say"))[0].turn as number;

  await hold(page);
  await expect.poll(() => count(page, "voice_hush")).toBe(1);
  await expect(glance(page)).toHaveAttribute("data-phase", "listening");
  await page.waitForTimeout(700);
  await letGo(page);
  await expect.poll(() => count(page, "helm_send"), { timeout: 8000 }).toBe(2);
  await expect.poll(async () => (await calls(page, "voice_say")).filter(one => one.turn === turn + 1).length, { timeout: 8000 }).toBeGreaterThan(0);

  // A tap now stops the voice, and is not hands-free: the reply finishes as text.
  await tap(page);
  await expect.poll(() => count(page, "voice_hush")).toBe(2);
  await expect(glance(page)).toHaveAttribute("data-phase", "done");
  await expect(page.locator(".v-answer")).toContainText("dwie rzeczy", { timeout: 6000 });
  expect(await count(page, "helm_transcribe")).toBe(2);
});

/* ⚠️ The regression for "it recorded the first time, now it doesn't record my
 * speech" (AGENTS 851), with a microphone as slow to open as his Bluetooth
 * earbuds: hold, the reply, hold again, a barge-in, Escape, a tap that stops
 * the voice followed AT ONCE by a hold (the press the first build threw away),
 * a microphone that stops by itself, and a hold once more — every one but the
 * Escaped hold reaches Helm. */
test("turn after turn with a slow microphone: every hold records, the one after a tap and after a lost microphone too", async ({ page }) => {
  // Seven turns, each said out loud and read: longer than the default half-minute.
  test.setTimeout(120_000);
  await fakeMic(page, 700);
  await page.goto("/tasks.html?helm&noagents");
  const heard = () => count(page, "helm_transcribe");

  // 1. Hold, speak, let go.
  await say(page, 1600);
  await expect.poll(heard, { timeout: 5000 }).toBe(1);
  await expect(glance(page)).toHaveAttribute("data-phase", "speaking", { timeout: 6000 });
  await expect(glance(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
  // 2. Hold again, while the last answer is still up to read.
  await say(page, 1600);
  await expect.poll(heard, { timeout: 5000 }).toBe(2);
  // 3. Barge-in while it speaks.
  await expect(glance(page)).toHaveAttribute("data-phase", "speaking", { timeout: 6000 });
  await say(page, 1600);
  await expect.poll(heard, { timeout: 5000 }).toBe(3);
  await expect(glance(page)).toHaveAttribute("data-phase", "done", { timeout: 12_000 });
  // 4. A hold Escape ends: nothing goes.
  await hold(page);
  await page.waitForTimeout(900);
  await page.keyboard.press("Escape");
  await letGo(page);
  await page.waitForTimeout(600);
  expect(await heard()).toBe(3);
  // 5. A tap to stop the voice, and straight away a hold: inside the microphone's 700 ms start.
  await say(page, 1200);
  await expect(glance(page)).toHaveAttribute("data-phase", "speaking", { timeout: 8000 });
  await tap(page);
  await page.waitForTimeout(80);
  await say(page, 1600);
  await expect.poll(heard, { timeout: 5000 }).toBe(5);
  await expect(glance(page)).toHaveAttribute("data-phase", "done", { timeout: 12_000 });
  // 6. The microphone stops by itself mid-hold: what it caught goes, and nothing wedges.
  await hold(page);
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    for (const track of (window as unknown as { __mic: MediaStream }).__mic.getTracks()) {
      track.stop();
      track.dispatchEvent(new Event("ended"));
    }
  });
  await expect.poll(heard, { timeout: 5000 }).toBe(6);
  await letGo(page);
  await expect(glance(page)).toHaveAttribute("data-phase", "done", { timeout: 12_000 });
  // 7. And a hold once more.
  await say(page, 1600);
  await expect.poll(heard, { timeout: 5000 }).toBe(7);
  await expect(glance(page)).toBeHidden({ timeout: 25_000 });
  expect((await calls(page, "voice_keys")).at(-1)).toEqual({ escape: false, enter: false });
});

test("the glance: the pointer holds it up, a click opens the Guardian with the thread, Escape folds it at once", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents&voicecard");
  await say(page, 800);
  // Cards do not fit: the open key says how many are waiting.
  await expect(page.locator(".v-open")).toBeVisible({ timeout: 6000 });
  await expect(page.locator(".v-open-count")).toHaveText("1");
  await expect(glance(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
  // Held up while the pointer is on it, past the six seconds it would otherwise stay.
  const box = (await glance(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 12);
  await page.waitForTimeout(7500);
  await expect(glance(page)).toBeVisible();
  await expect(panel(page)).toBeHidden();
  // A click opens the Guardian, with the turn in its thread.
  await glance(page).click({ position: { x: box.width / 2, y: box.height - 12 } });
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('.screen[data-screen="guardian"]')).toBeVisible();
  await expect(page.locator(".g-mine").last()).toContainText("Przesuń Repricer na jutro rano");
  await expect(page.locator(".g-reply").last()).toContainText("dwie rzeczy");
  await expect(glance(page)).toBeHidden();

  // Escape folds a glance up to be read, at once.
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 500);
  await expect(panel(page)).toBeHidden({ timeout: 4000 });
  await say(page, 800);
  await expect(glance(page)).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(glance(page)).toBeHidden({ timeout: 1500 });
});

test("Cofnij on a receipt chip takes the change back", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents");
  await say(page, 800);
  await expect(page.locator(".v-rc-undo")).toBeVisible({ timeout: 8000 });
  await page.locator(".v-rc-undo").click();
  await expect(page.locator(".v-rc")).toHaveClass(/is-undone/);
  expect((await calls(page, "helm_undo"))[0]).toMatchObject({ index: 0 });
  await expect(panel(page)).toBeHidden();
});

test("in a call the reply is text only, says why, and stays up longer to read", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents&call");
  await say(page, 700);
  await expect(page.locator(".v-quiet")).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".v-quiet")).toHaveAttribute("data-tip", "Text only: you're in a call");
  await expect(page.locator(".v-answer")).toContainText("dwie rzeczy", { timeout: 6000 });
  expect(await calls(page, "voice_say")).toEqual([]);
  await expect(glance(page)).toHaveAttribute("data-phase", "done");
  await expect(page.locator(".v-quiet")).toBeVisible();
  await page.waitForTimeout(8000);
  await expect(glance(page)).toBeVisible();
});

test("with Spoken replies off it never asks for the voice", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents&spoken=off");
  await say(page, 700);
  await expect(page.locator(".v-quiet")).toHaveAttribute("data-tip", "Text only: spoken replies are off", { timeout: 5000 });
  await expect(page.locator(".v-answer")).toContainText("dwie rzeczy", { timeout: 6000 });
  expect(await calls(page, "voice_say")).toEqual([]);
  expect(await calls(page, "voice_quiet")).toEqual([]);
});

test("signed out, holding the key says so on the pill and opens nothing", async ({ page }) => {
  await page.goto("/tasks.html?noagents");
  await say(page, 800);
  await expect(page.locator("#island-collapsed .pill-label")).toContainText(/Guardian/, { timeout: 3000 });
  await expect(glance(page)).toBeHidden();
  expect(await calls(page, "helm_send")).toEqual([]);
});

/* Every moment of the glance, at device scale 2, for looking at. */
test.describe("pictures", () => {
  test.use({ deviceScaleFactor: 2 });
  test("each moment of the voice glance", async ({ page }) => {
    test.setTimeout(90_000);
    await fakeMic(page);
    await page.goto("/tasks.html?helm&noagents&pace=8");
    await hold(page);
    await page.waitForTimeout(1900);
    await picture(page, "1-listening-hold");
    await letGo(page);
    await expect(glance(page)).toHaveAttribute("data-phase", "transcribing");
    await page.waitForTimeout(900);
    await picture(page, "3-transcribing");
    await expect(glance(page)).toHaveAttribute("data-phase", "thinking", { timeout: 8000 });
    await page.waitForTimeout(900);
    await picture(page, "4-thinking");
    await expect.poll(() => page.locator(".v-answer .v-w").count(), { timeout: 12_000 }).toBeGreaterThan(5);
    await picture(page, "5-answer-streaming");
    await expect(page.locator(".v-rc-undo")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(400);
    await picture(page, "5b-answer-with-receipt");
    await page.keyboard.press("Escape");

    await tap(page);
    await page.waitForTimeout(2300);
    await picture(page, "2-listening-hands-free");
    await page.keyboard.press("Escape");

    await page.goto("/tasks.html?helm&noagents&call&voicecard");
    await say(page, 900);
    await expect(page.locator(".v-answer")).toContainText("dwie rzeczy", { timeout: 8000 });
    await page.waitForTimeout(600);
    await picture(page, "6-muted-with-card");
  });
});
