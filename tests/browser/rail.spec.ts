import { test, expect, type Page } from "@playwright/test";

/* The rail: where you are, under the middle of the island.
 *
 * ⚠️ Wider than the suite's default, because the island's body is a fixed
 * design width and its corners are off the left and right of a 900px preview. */
test.use({viewport: {width: 1400, height: 860}});

async function open(page: Page) {
  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();
  await expect(page.locator("#island-rail")).toBeVisible();
  /* ⚠️ And wait for it to STOP. The rail is placed from the island's measured
   * size every frame, so while the panel is still springing open every
   * measurement of it is of somewhere it is about to leave — and a press aimed
   * at the middle lands beside it. */
  let last = "";
  await expect.poll(async () => {
    const now = await page.locator("#island-rail").evaluate(el => {
      const b = el.getBoundingClientRect();
      return `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)}`;
    });
    const same = now === last;
    last = now;
    return same;
  }, {timeout: 5000}).toBe(true);
}

/** Which screen is under the middle. */
const here = (page: Page) =>
  page.locator(".rail-stop.is-here").getAttribute("data-tab");

test("the rail centres where you are and blurs the rest away", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto("/tasks.html?agents");
  await open(page);

  /* ⚠️ Exactly one stop is the one you are on, and it is the only one
   * captioned. The old strip captioned the selected tab too, and that was the
   * whole problem with it: one word and eight glyphs tells you where you are,
   * which you know. Here the word is on the thing in the MIDDLE, so the two
   * either side of it are a step away rather than a guess. */
  expect(await here(page)).toBe("home");
  await expect(page.locator(".rail-stop.is-here")).toHaveCount(1);
  expect(await page.locator(".rail-say").evaluateAll(says =>
    says.filter(s => s.getBoundingClientRect().width > 0).length)).toBe(1);

  /* The further from the middle, the less of it there is. ⚠️ Measured as a
   * monotonic fall, not against fixed numbers: the ramp is a judgement and will
   * be re-tuned, but "nearer the middle is always clearer" is the rule. */
  const fade = await page.locator(".rail-stop").evaluateAll(stops => {
    const rail = document.getElementById("island-rail")!.getBoundingClientRect();
    const mid = rail.left + rail.width / 2;
    return stops.map(s => {
      const box = s.getBoundingClientRect();
      const style = getComputedStyle(s);
      return {
        away: Math.abs(box.left + box.width / 2 - mid),
        seen: Number(style.opacity),
        blur: Number(/blur\(([\d.]+)px\)/.exec(style.filter)?.[1] ?? 0),
      };
    }).sort((a, b) => a.away - b.away);
  });
  for (let i = 1; i < fade.length; i++) {
    expect(fade[i].seen).toBeLessThanOrEqual(fade[i - 1].seen + 0.001);
    expect(fade[i].blur).toBeGreaterThanOrEqual(fade[i - 1].blur - 0.001);
  }
  /* ⚠️ The ends have to actually FALL AWAY, not merely not rise. A monotonic
   * check alone passes for a rail where every stop is equally sharp — which is
   * the row of nine identical icons this replaced, wearing a new shape. */
  expect(fade[0].blur).toBe(0);
  expect(fade[fade.length - 1].blur).toBeGreaterThan(1);
  expect(fade[fade.length - 1].seen).toBeLessThan(fade[0].seen - 0.4);
});

test("dragging the rail walks the screens, and a press still picks one", async ({page}) => {
  await page.goto("/tasks.html?agents");
  await open(page);
  expect(await here(page)).toBe("home");

  const rail = (await page.locator("#island-rail").boundingBox())!;
  const mid = {x: rail.x + rail.width / 2, y: rail.y + rail.height / 2};
  const pitch = await page.locator(".rail-stop").evaluateAll(stops => {
    const at = (el: Element) => el.getBoundingClientRect().left;
    return Math.abs(at(stops[1]) - at(stops[0]));
  });

  /* Drag one stop's worth to the left and the next screen comes to the middle.
   * ⚠️ In steps, not one jump: the drag reads a stream of positions and works
   * out a speed from them, and a single move has no speed at all. */
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x - pitch, mid.y, {steps: 8});

  /* ⚠️ The panel rides the rail while the drag is live — it moves with the
   * gesture and blurs, so the two read as one thing rather than a control that
   * happens to change a screen. */
  const carried = await page.locator("#island-expanded").evaluate(el => ({
    moved: Math.abs(parseFloat(getComputedStyle(el).translate) || 0),
    blurred: /blur\([\d.]+px\)/.test(getComputedStyle(el).filter),
    marked: el.classList.contains("is-carried"),
  }));
  expect(carried.marked).toBe(true);
  expect(carried.moved).toBeGreaterThan(0);
  expect(carried.blurred).toBe(true);

  await page.mouse.up();
  await expect.poll(() => here(page)).toBe("today");
  // And the panel is handed back, unblurred and where it belongs.
  await expect.poll(() => page.locator("#island-expanded").evaluate(el =>
    getComputedStyle(el).filter)).toBe("none");

  /* ⚠️ A press is still a press. The rail is draggable, so every click on a
   * stop is also a drag of a pixel or two — and without the slop threshold the
   * snap fights the click and the screen you pressed is never the one you get. */
  const next = page.locator('.rail-stop[data-tab="media"], .rail-stop[data-tab="agents"]').first();
  const want = await next.getAttribute("data-tab");
  await next.click();
  await expect.poll(() => here(page)).toBe(want);
});

test("the rail turns with the island, and never leaves it without one", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto("/tasks.html?agents&edge=left");
  await open(page);

  /* ⚠️ All four edges. It ran across the island's end only at first, which left
   * a left- or right-edge island with NO screen switcher at all — the header
   * strip had already gone, and nothing said so. */
  await expect(page.locator("#island-rail")).toHaveClass(/is-upright/);
  const shape = await page.locator("#island-rail").evaluate(el => {
    const box = el.getBoundingClientRect();
    return {upright: box.height > box.width};
  });
  expect(shape.upright).toBe(true);
  expect(await here(page)).toBe("home");
});
