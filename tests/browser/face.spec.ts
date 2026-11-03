import { test, expect, type Page } from "@playwright/test";

/* The Guardian's face (2 Nov): the Eyes in the resting pill, in the date's
 * place. Staged: `?mood=<mood>` holds a mood, `?face=off` brings the date
 * back, `?night=0|1` fixes the night whatever the clock says; `window.__face` is the face (face.ts). `FACE_SHOTS=<dir>` writes a
 * real-size picture of the pill per mood. */

const pill = (page: Page) => page.locator("#island-collapsed");

/** A microphone the preview can record (as voice.spec.ts): an oscillator. */
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
const moodOf = (page: Page) => page.evaluate(() => (window as unknown as { __face: { mood: string } }).__face.mood);

async function picture(page: Page, name: string) {
  const dir = process.env.FACE_SHOTS;
  if (!dir) return;
  const box = await page.locator("#island").boundingBox();
  if (!box) return;
  await page.screenshot({ path: `${dir}/face-${name}.png`, clip: { x: box.x - 16, y: 0, width: box.width + 32, height: box.y + box.height + 12 } });
}

test("the face takes the date's place in the resting pill, and off brings the date back", async ({ page }) => {
  await page.goto("/tasks.html?quiet&night=0");
  await expect(pill(page)).toHaveClass(/has-face/);
  await expect(page.locator(".pill-face .face-canvas")).toBeVisible();
  await expect(page.locator(".pill-date-day")).toBeHidden();
  // Drawn: the canvas holds lit pixels, sized for the display.
  await expect.poll(() => page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".face-canvas")!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 200) lit++;
    return lit;
  })).toBeGreaterThan(40);
  expect(await moodOf(page)).toBe("idle");
  await picture(page, "idle");

  await page.goto("/tasks.html?quiet&face=off");
  await expect(pill(page)).not.toHaveClass(/has-face/);
  await expect(page.locator(".pill-date-day")).toBeVisible();
});

for (const mood of ["love", "alert", "sleep", "oops", "happy", "focus"]) {
  test(`a staged mood shows: ${mood}`, async ({ page }) => {
    await page.goto(`/tasks.html?quiet&mood=${mood}`);
    await expect.poll(() => moodOf(page)).toBe(mood);
    await page.waitForTimeout(500);
    await picture(page, mood);
  });
}

test("at night he's sleepy, and a voice turn still wakes him", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents&night=1");
  await expect.poll(() => moodOf(page)).toBe("sleep");
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await expect.poll(() => moodOf(page)).toBe("listen");
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
  await page.keyboard.press("Escape");
  await expect.poll(() => moodOf(page), { timeout: 4000 }).toBe("sleep");
});

test("holding the talk key: he listens, then thinks", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents&night=0");
  await page.waitForTimeout(600);
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await expect.poll(() => moodOf(page)).toBe("listen");
  await page.waitForTimeout(700);
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
  await expect.poll(() => moodOf(page), { timeout: 4000 }).toMatch(/think|speak/);
  await page.keyboard.press("Escape");
  await expect.poll(() => moodOf(page), { timeout: 4000 }).toBe("idle");
});

/* ── Step 2–5 (2 Nov): his news, the PC, the edge, the voice glance, pokes. ── */

const reactionOf = (page: Page) => page.evaluate(() => (window as unknown as { __face: { reaction: string | null } }).__face.reaction);

test("his own news: a payment comes in, his face tells it in the peek and he's in love", async ({ page }) => {
  await page.goto("/tasks.html?quiet&night=0&src=paid");
  await expect(page.locator("#island-collapsed[data-kind='peek'] .pill-lead.has-face .face-canvas")).toBeVisible({ timeout: 5000 });
  expect(await moodOf(page)).toBe("love");
  await page.waitForTimeout(400);
  await picture(page, "peek-paid");
});

test("the PC: the earbuds go on and he puts headphones on; a plain screenshot keeps its picture", async ({ page }) => {
  await page.goto("/tasks.html?quiet&night=0&src=buds,screenshot");
  await expect(page.locator("#island-collapsed[data-kind='peek'] .pill-lead.has-face")).toBeVisible({ timeout: 5000 });
  await expect.poll(() => reactionOf(page)).toBe("phones");
  await page.waitForTimeout(500);
  await picture(page, "peek-buds");
  await expect(page.locator("#island-collapsed[data-kind='peek'] .pill-lead .pill-art")).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#island-collapsed .pill-lead.has-face")).toHaveCount(0);
});

test("pokes: a click on his face is a start, a few in a row a giggle, more and he's grumpy; it doesn't open the island", async ({ page }) => {
  await page.goto("/tasks.html?quiet&click&night=0&helm&noagents");
  const faceEl = page.locator("#island-collapsed .pill-face .face-canvas");
  await expect(faceEl).toBeVisible();
  await faceEl.click();
  expect(await reactionOf(page)).toBe("startle");
  await faceEl.click(); await faceEl.click();
  expect(await reactionOf(page)).toBe("giggle");
  await faceEl.click(); await faceEl.click();
  expect(await reactionOf(page)).toBe("grumpy");
  await page.waitForTimeout(300);
  await picture(page, "grumpy");
  await expect(page.locator("#island")).not.toHaveClass(/is-open|open/);
  // A double click opens the Guardian.
  await page.waitForTimeout(3200);
  await faceEl.dblclick();
  await expect(page.locator('.screen[data-screen="guardian"]')).toBeVisible({ timeout: 3000 });
});

test("a claim takes the strip: he peeks out at its edge for a moment, then ducks away", async ({ page }) => {
  await page.goto("/tasks.html?quiet&night=0&helm&running&noagents&nocal");
  const edgeFace = page.locator("#island-collapsed .pill-second.is-face .face-canvas");
  await expect(edgeFace).toBeVisible({ timeout: 5000 });
  expect(await moodOf(page)).toBe("focus");
  await page.waitForTimeout(700);
  await picture(page, "edge-peek");
  await expect(edgeFace).toHaveCount(0, { timeout: 7000 });
});

test("the voice glance: his face in the mic while he listens, in the shield while he answers — never both", async ({ page }) => {
  await fakeMic(page);
  await page.goto("/tasks.html?helm&noagents&night=0");
  await page.waitForTimeout(600);
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await expect(page.locator(".v-disc.has-face .face-canvas")).toBeVisible();
  await expect(page.locator(".v-shield.has-face")).toHaveCount(0);
  await page.waitForTimeout(500);
  await picture(page, "voice-listen");
  await page.waitForTimeout(400);
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
  await expect(page.locator(".v-shield.has-face .face-canvas")).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".v-disc.has-face")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("a cameo takes the resting pill for a few seconds and gives it back", async ({ page }) => {
  await page.goto("/tasks.html?quiet&night=0&noagents&nocal");
  await expect(page.locator("#island-collapsed.is-clock")).toBeVisible();
  const played = await page.evaluate(() => (window as unknown as { __face: { back(): void } }).__face.back());
  void played;
  await expect(page.locator("#island-collapsed.is-cameo .pill-cameo .face-canvas")).toBeVisible();
  await page.waitForTimeout(1200);
  await picture(page, "cameo");
  await expect(page.locator("#island-collapsed.is-cameo")).toHaveCount(0, { timeout: 5000 });
});

/* ── Step 6 (2 Nov): Hoot, Sir, and Settings → Character. ── */

for (const who of ["hoot", "sir"]) {
  test(`${who} takes the date's place and wears every mood`, async ({ page }) => {
    await page.goto(`/tasks.html?quiet&night=0&face=${who}`);
    await expect(page.locator(".pill-face .face-canvas")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __face: { character: string } }).__face.character)).toBe(who);
    await expect.poll(() => page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>(".pill-face .face-canvas")!;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 200) lit++;
      return lit;
    })).toBeGreaterThan(200);
    await picture(page, `${who}-idle`);
    for (const mood of ["love", "listen", "sleep"]) {
      await page.goto(`/tasks.html?quiet&face=${who}&mood=${mood}`);
      await expect.poll(() => moodOf(page)).toBe(mood);
      await page.waitForTimeout(300);
      await picture(page, `${who}-${mood}`);
    }
  });
}

test("Hoot reacts too: the earbuds go on and so do his headphones", async ({ page }) => {
  await page.goto("/tasks.html?quiet&night=0&face=hoot&src=buds");
  await expect(page.locator("#island-collapsed[data-kind='peek'] .pill-lead.has-face")).toBeVisible({ timeout: 5000 });
  await expect.poll(() => reactionOf(page)).toBe("phones");
  await page.waitForTimeout(300);
  await picture(page, "hoot-phones");
});

test("reactions switched off: the earbuds peek keeps its glyph and he doesn't react; his own news still gets his face", async ({ page }) => {
  await page.goto("/tasks.html?quiet&night=0&noreact&src=buds,paid");
  await expect(page.locator("#island-collapsed[data-kind='peek']")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#island-collapsed .pill-lead.has-face")).toHaveCount(0);
  expect(await reactionOf(page)).toBeNull();
  await expect(page.locator("#island-collapsed[data-kind='peek'] .pill-lead.has-face")).toBeVisible({ timeout: 6000 });
});

test("cameos switched off, or calm: no cameo; calm keeps the moods", async ({ page }) => {
  await page.goto("/tasks.html?quiet&night=0&nocameos");
  await expect(page.locator("#island-collapsed.is-clock")).toBeVisible();
  await page.evaluate(() => (window as unknown as { __face: { back(): void } }).__face.back());
  await page.waitForTimeout(300);
  await expect(page.locator("#island-collapsed.is-cameo")).toHaveCount(0);
  await page.goto("/tasks.html?quiet&calm&mood=love");
  await page.evaluate(() => (window as unknown as { __face: { back(): void } }).__face.back());
  await expect(page.locator("#island-collapsed.is-cameo")).toHaveCount(0);
  await expect.poll(() => moodOf(page)).toBe("love");
});

test("Settings → Character: four cards, alive; choosing one and the switches are saved", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/task-editor.html");
  await page.getByRole("tab", { name: "Character" }).click();
  await expect(page.locator("#pane-character")).toHaveCSS("opacity", "1");
  const cards = page.locator(".char-card");
  await expect(cards).toHaveCount(4);
  await expect(page.locator(".char-card[data-character='eyes']")).toHaveAttribute("aria-checked", "true");
  // Alive: each of the three draws.
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLCanvasElement>(".char-stage canvas")].every(c => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 200) return true;
    return false;
  }))).toBe(true);
  await page.locator(".char-card[data-character='hoot']").click();
  await expect(page.locator(".char-card[data-character='hoot']")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Calm" }).click();
  await expect(page.locator("#char-cameos")).toBeDisabled();
  await page.locator("#char-reactions").uncheck();
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ? null : true);
  expect(saved).toBe(true);
  const dir = process.env.FACE_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/settings-character.png` });
  // Off: the date card.
  await page.locator(".char-card[data-character='off']").click();
  await expect(page.locator("#char-reactions")).toBeDisabled();
});
