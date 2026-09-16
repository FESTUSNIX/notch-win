import { test, expect, type Page } from "@playwright/test";
import { FRAME } from "../../src/layout";

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
  /* ⚠️ The name is in the HEADER, not on the stop. A caption on the middle
   * one made every slot as wide as a word, which put a rail of five over two
   * hundred pixels long with the screens marooned at either end. */
  await expect(page.locator("#island-where")).toHaveText("Home");
  await expect(page.locator(".rail-stop")).toHaveCount(9);

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
  /* ⚠️ Onto it first, then RE-MEASURE. Arriving is what opens the rail, and
   * opening changes what is in it — so a point worked out before the pointer
   * got there can be one the rail has since moved out from under. */
  await page.mouse.move(mid.x, mid.y);
  const on = (await page.locator("#island-rail").boundingBox())!;
  const from = {x: on.x + on.width / 2, y: on.y + on.height / 2};
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();

  /* Drag one stop's worth to the left and the next screen comes to the middle.
   *
   * ⚠️ DELIBERATELY — small steps with real gaps between them. Delivered as
   * one burst this is a flick, and a flick is travelling rather than choosing:
   * the rail deliberately shows nothing in between and saves it all for the
   * release. That behaviour has a test of its own; this one is about the
   * gesture that walks. */
  /* How far the finger goes for one stop.
   *
   * ⚠️ Measured from the page and scaled by a pure RATIO. `cpx()` converts
   * design pixels using a scale the browser works out from the screen, and
   * imported into Node it answers with something else entirely — so a distance
   * computed here would be the wrong one, and the drag would stop short of the
   * next screen. The ratio between the two constants is the same everywhere.
   *
   * ⚠️ And the pitch is read between two stops on the SAME side of the middle:
   * the centred one opens into a pill with its name in it and pushes its
   * neighbours out, so the step from it to the next is a pitch plus a push. */
  const pitch = await page.locator(".rail-stop").evaluateAll(stops => {
    const at = (el: Element) => el.getBoundingClientRect().left;
    return Math.abs(at(stops[3]) - at(stops[2]));
  });
  const grab = pitch * FRAME.railDragStep / FRAME.railStep;
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(from.x - (grab * i) / 8, from.y);
    await page.waitForTimeout(45);
  }
  // The gesture has to be taken as a drag before its effects can be.
  await expect(page.locator("#island-rail")).toHaveClass(/is-dragging/);

  /* ⚠️ The panel rides the rail while the drag is live — it moves with the
   * gesture and blurs, so the two read as one thing rather than a control that
   * happens to change a screen.
   *
   * ⚠️ Read HALF WAY between two stops, which is where the carry is at its
   * largest. It is measured from the distance to the nearest stop, so on a
   * stop it is zero by definition — sampled there, a working carry looks like
   * no carry at all. */
  const carried = await page.locator("#island-expanded").evaluate(el => ({
    moved: Math.abs(parseFloat(getComputedStyle(el).translate) || 0),
    blurred: /blur\([\d.]+px\)/.test(getComputedStyle(el).filter),
    marked: el.classList.contains("is-carried"),
  }));
  expect(carried.marked).toBe(true);
  expect(carried.moved).toBeGreaterThan(0);
  expect(carried.blurred).toBe(true);

  for (let i = 5; i <= 8; i++) {
    await page.mouse.move(from.x - (grab * i) / 8, from.y);
    await page.waitForTimeout(45);
  }

  /* ⚠️ The screen has ALREADY changed, with the drag still in the hand. It
   * used to wait for the release, which meant walking three screens was three
   * separate drags — and the panel spent the whole gesture showing something
   * the rail had left, which is what made the drag read as broken. */
  await expect.poll(() => here(page)).toBe("today");
  await expect(page.locator("#island-where")).toHaveText("Today");
  await expect(page.locator("#island-rail")).toHaveClass(/is-dragging/);

  /* ⚠️ And NO screen plays its entrance while the drag is in the hand. This
   * is the fault the live change created and the reason `show()` takes a
   * `live` flag: the rail already translates and blurs the whole panel through
   * the gesture, so a screen sliding in on top of that reads as the content
   * stuttering rather than as either animation. Watched rather than sampled —
   * the entrance lasts a couple of frames and a poll walks straight past it. */
  const entrances = await page.evaluate(() => {
    let seen = 0;
    /* ⚠️ Counts the moment a screen GAINS the class, not every class change
     * on a screen that happens to have it. A screen keeps `is-first` from the
     * island's own opening, and every later toggle of `active` or `hidden` on
     * that element is a mutation whose target still carries it — so the naive
     * check reports an entrance for a screen that is merely being hidden. */
    const had = new WeakMap<Element, boolean>();
    for (const el of document.querySelectorAll(".screen")) {
      had.set(el, el.classList.contains("is-first"));
    }
    const watch = new MutationObserver(list => {
      for (const one of list) {
        const el = one.target as HTMLElement;
        const now = el.classList.contains("is-first");
        if (now && !had.get(el)) seen++;
        had.set(el, now);
      }
    });
    for (const el of document.querySelectorAll(".screen")) {
      watch.observe(el, {attributes: true, attributeFilter: ["class"]});
    }
    (window as unknown as {entrances: () => number}).entrances = () => seen;
    return seen;
  });
  expect(entrances).toBe(0);

  /* A second stop in the same gesture, without letting go. ⚠️ Two, and no
   * further: past that the rail stops animating through them on purpose, which
   * has a test of its own. */
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x - grab - (grab * i) / 8, from.y);
    await page.waitForTimeout(45);
  }
  await expect.poll(() => here(page)).toBe("media");
  expect(await page.evaluate(() =>
    (window as unknown as {entrances: () => number}).entrances())).toBe(0);

  /* ⚠️ Let go SLOWLY. The release speed is read off the last two moves, and
   * a drag delivered in one burst releases at hundreds of pixels a second —
   * which is a flick, and a flick deliberately carries one stop further. This
   * test is about the drag; the carry is its own behaviour. */
  await page.waitForTimeout(220);
  await page.mouse.move(from.x - grab * 2 + 1, from.y);
  await page.mouse.up();
  await expect.poll(() => here(page)).toBe("media");
  // And the panel is handed back, unblurred and where it belongs.
  await expect.poll(() => page.locator("#island-expanded").evaluate(el =>
    getComputedStyle(el).filter)).toBe("none");

  /* ⚠️ A press is still a press. The rail is draggable, so every click on a
   * stop is also a drag of a pixel or two — and without the slop threshold the
   * snap fights the click and the screen you pressed is never the one you get. */
  /* ⚠️ Back onto the rail first. The drag ended two stops' worth to the left
   * of it, which is outside both the rail and the island's own mask — and the
   * island folds when the pointer is on neither, taking the rail with it. */
  /* ⚠️ Via the ISLAND, which is always on screen — collapsed or not. Aiming
   * straight at the rail races the fold: by the time its box is measured it
   * can already be gone, and `boundingBox()` answers null. */
  const isle = (await page.locator("#island").boundingBox())!;
  await page.mouse.move(isle.x + isle.width / 2, isle.y + isle.height / 2);
  await expect(page.locator("#island-rail")).toBeVisible();

  /* ⚠️ Wait for the name to finish arriving first. It opens the centred stop
   * into a pill and pushes its neighbours aside, so for half a second after
   * settling every stop is somewhere it is about to leave — and a click aimed
   * at one waits for it to hold still, which it will not until then. */
  await expect.poll(() => page.locator(".rail-stop.is-here .rail-say")
    .evaluate(el => el.getBoundingClientRect().width), {timeout: 4000})
    .toBeGreaterThan(20);

  const next = page.locator('.rail-stop[data-tab="agents"]');
  await next.click();
  await expect.poll(() => here(page)).toBe("agents");
});

test("the name waits for the rail to stop, and the ends do not carry", async ({page}) => {
  await page.goto("/tasks.html?agents");
  await open(page);

  /* ⚠️ The name arrives LATE, and that is the point. A caption is wider than
   * an icon, so showing one moves every stop beside it — fine once, and a
   * layout thrashing back and forth if it happens on every stop a drag passes.
   * It waits for the rail to be still. */
  const named = () => page.locator(".rail-stop.is-here .rail-say")
    .evaluate(el => el.getBoundingClientRect().width);
  await expect.poll(named, {timeout: 4000}).toBeGreaterThan(20);

  const rail = (await page.locator("#island-rail").boundingBox())!;
  const mid = {x: rail.x + rail.width / 2, y: rail.y + rail.height / 2};
  await page.mouse.move(mid.x, mid.y);
  const on = (await page.locator("#island-rail").boundingBox())!;
  const from = {x: on.x + on.width / 2, y: on.y + on.height / 2};
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 40, from.y, {steps: 5});
  await expect(page.locator("#island-rail")).toHaveClass(/is-dragging/);
  // Gone the instant it moves.
  await expect.poll(named).toBeLessThan(4);

  /* ⚠️ Past the FIRST stop there is no screen to be carried towards, so the
   * panel must not move. The rail itself rubber-bands — which is right, it
   * says "this is the end" — but carrying the content out there slides it off
   * and then snaps it back when the band returns, which is a jump nobody
   * asked for. */
  await page.mouse.move(from.x + 260, from.y, {steps: 10});
  await expect.poll(() => page.locator("#island-expanded").evaluate(el =>
    Math.abs(parseFloat(getComputedStyle(el).translate) || 0))).toBeLessThan(0.5);
  expect(await page.locator(".rail-stop.is-here").getAttribute("data-tab")).toBe("home");

  await page.mouse.up();
  /* ⚠️ Back onto the island first. The drag ended well outside it — that is
   * what pulling past the end means — and the island folds when the pointer
   * leaves, taking the rail with it. Asserting from out there measures a
   * hidden element and reads as the name never coming back. */
  const isle = (await page.locator("#island").boundingBox())!;
  await page.mouse.move(isle.x + isle.width / 2, isle.y + isle.height / 2);
  await expect(page.locator("#island-rail")).toBeVisible();
  // And once it is still again, the name comes back.
  await expect.poll(named, {timeout: 4000}).toBeGreaterThan(20);
});

test("a slow drag walks the screens; a long one saves them all for the release", async ({page}) => {
  await page.goto("/tasks.html?agents");
  await open(page);

  /** Every screen the panel actually showed, in order. */
  const watch = () => page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as {seen: string[]}).seen = seen;
    const eye = new MutationObserver(() => {
      const on = document.querySelector<HTMLElement>(".screen.active")?.dataset.screen;
      if (on && seen[seen.length - 1] !== on) seen.push(on);
    });
    for (const el of document.querySelectorAll(".screen")) {
      eye.observe(el, {attributes: true, attributeFilter: ["class"]});
    }
  });
  const seen = () => page.evaluate(() => (window as unknown as {seen: string[]}).seen);
  const railMid = async () => {
    const box = (await page.locator("#island-rail").boundingBox())!;
    return {x: box.x + box.width / 2, y: box.y + box.height / 2};
  };

  /* ⚠️ SLOWLY, two stops. Small steps with real gaps between them: this is
   * somebody choosing, and the panel is expected to follow them through. */
  await watch();
  let at = await railMid();
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(at.x - i * 12, at.y);
    await page.waitForTimeout(50);
  }
  expect(await seen()).toEqual(["today", "media"]);
  await page.mouse.up();
  at = await railMid();
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => here(page)).toBe("media");

  /* ⚠️ And a long flick shows NOTHING in between. Every screen has its own
   * width and height, so animating through six of them is six resizes of the
   * island inside half a second — each correct on its own and unreadable in a
   * row. Two stops is a correction; six is travelling, and travelling wants
   * one arrival. */
  await watch();
  at = await railMid();
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x - 450, at.y, {steps: 10});
  expect(await seen()).toEqual([]);
  await page.mouse.up();
  // ... and still lands where it was let go.
  await expect.poll(() => here(page)).not.toBe("media");
});

test("a long sweep does not rock the panel once it stops changing screens", async ({page}) => {
  await page.goto("/tasks.html?agents");
  await open(page);

  const pitch = await page.locator(".rail-stop").evaluateAll(stops => {
    const at = (el: Element) => el.getBoundingClientRect().left;
    return Math.abs(at(stops[3]) - at(stops[2]));
  });
  const grab = pitch * FRAME.railDragStep / FRAME.railStep;
  const box = (await page.locator("#island-rail").boundingBox())!;
  const from = {x: box.x + box.width / 2, y: box.y + box.height / 2};

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const trail: {screen: string; carry: number}[] = [];
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(from.x - (grab * i) / 8, from.y);
    await page.waitForTimeout(40);
    trail.push(await page.evaluate(() => ({
      screen: document.querySelector<HTMLElement>(".screen.active")?.dataset.screen ?? "",
      carry: parseFloat(getComputedStyle(document.getElementById("island-expanded")!).translate) || 0,
    })));
  }
  await page.mouse.up();

  /* ⚠️ Once the screens stop changing, the panel must stop rocking. The carry
   * used to be measured to the NEAREST stop, which flips from one side to the
   * other at every stop the rail passes — right while the screens are following
   * along, because the new one arrives on exactly that flip, and nonsense once
   * they stop: nothing changes at the crossing, so the panel simply slid left,
   * snapped right, and did it again for every screen gone past.
   *
   * So: from the last screen change onward, the carry may not reverse. */
  const settledOn = trail[trail.length - 1].screen;
  const after = trail.slice(trail.findIndex(
    (step, i) => step.screen === settledOn && trail.slice(i).every(s => s.screen === settledOn)));
  expect(after.length).toBeGreaterThan(8);
  for (let i = 1; i < after.length; i++) {
    expect(after[i].carry).toBeLessThanOrEqual(after[i - 1].carry + 0.5);
  }
  /* And it leans only as far as one screen's worth before holding — the rail
   * can travel the whole list from there; the panel is not going with it. */
  const leaned = Math.abs(after[after.length - 1].carry);
  expect(leaned).toBeGreaterThan(20);
  expect(leaned).toBeLessThan(90);
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
