import { test, expect } from "@playwright/test";

/* The arc off the island's far corner: what the open screen can do.
 *
 * ⚠️ Not `?quiet`. That is the preview's RESTING state — nothing playing, no
 * calendar — and the media tab only exists while something is playing, so
 * under it half of what this checks has no screen to change to. */
const HOME = "/tasks.html?agents";

/* ⚠️ Wider than the suite's default 900. The island's body is a fixed
 * design width — about 935 CSS px — so at 900 its far corner is off the right
 * of the preview viewport, and an arc struck outside that corner is somewhere
 * the pointer cannot go. Nothing errors; the hover simply never happens. (The
 * real window is sized to the island, so this is a preview artefact.) */
test.use({viewport: {width: 1280, height: 800}});

/** The point on the arc's own circle at `turn` of a full turn, in page
 *  coordinates — which is the only way to put the pointer ON a curve. */
async function onArc(page: import("@playwright/test").Page, turn: number) {
  return page.evaluate((t) => {
    const host = document.getElementById("island-tools")!.getBoundingClientRect();
    const d = document.getElementById("tools-arc")!.getAttribute("d")!;
    const radius = Number(/A([\d.]+)/.exec(d)![1]);
    const angle = t * 2 * Math.PI;
    return {
      x: host.left + radius * Math.cos(angle),
      y: host.top + radius * Math.sin(angle),
      radius,
    };
  }, turn);
}

test("the tool arc is struck off the island's corner and holds the screen's actions", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto(HOME);

  const tools = page.locator("#island-tools");
  await expect(tools).toBeHidden();

  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();

  await page.locator('[data-tab="calendar"]').click();
  await expect(tools).toBeVisible();
  await expect(tools.locator(".screen-tool")).toHaveCount(2);

  /* ⚠️ A GAP, not a join. The shape before this was welded to the island's
   * underside and read as a lump on the corner; the whole point of the arc is
   * that it is a separate thing following the contour. So: outside the
   * island's own box, everywhere along its length. */
  const clear = await page.evaluate(() => {
    const island = document.getElementById("island")!.getBoundingClientRect();
    /* The host's inner corner IS the centre of the island's corner arc, which
     * is what makes the two concentric — so the island's own corner radius is
     * the distance from there to its bottom edge.
     *
     * ⚠️ Its BOTTOM edge, not its right one. `notchPath` sets the rounded
     * corners a flare in from each end along the bezel, because the ends are
     * where the shape turns back out — so the along-axis distance is
     * `corner + flare` and only the across-axis is the corner alone. */
    const host = document.getElementById("island-tools")!.getBoundingClientRect();
    const path = document.getElementById("tools-arc") as unknown as SVGPathElement;
    const total = path.getTotalLength();
    let nearest = Infinity;
    for (let i = 0; i <= 20; i++) {
      const at = path.getPointAtLength((total * i) / 20);
      nearest = Math.min(nearest, Math.hypot(at.x, at.y));
    }
    const stroke = parseFloat(getComputedStyle(path).strokeWidth);
    return {corner: island.bottom - host.top, nearest, stroke};
  });
  /* ⚠️ Measured on the CURVE, not on its bounding box. The arc wraps the
   * corner, so its box legitimately starts inside the island on one axis —
   * a box test here passes for a line drawn straight through the panel.
   *
   * ⚠️ And to the stroke's EDGE, not its centreline. The clearance is small
   * on purpose — it is matched to the settings orb's — and half an eight-pixel
   * stroke is most of it. */
  expect(clear.nearest - clear.stroke / 2 - clear.corner).toBeGreaterThan(4);

  /* ⚠️ And the gap is the SAME all the way along, which is the claim the two
   * measurements above cannot make. They both start from the arc's own centre,
   * so they hold just as well for a circle struck about the wrong point — and
   * `notchPath` puts the rounded corners a flare in from each end, about 30px,
   * which is exactly the sort of offset that leaves the arc looking too far
   * out AND crooked while every radius involved is still correct.
   *
   * So: walk inward from the line at several angles and find where the island
   * actually begins. Concentric, that distance is the corner radius every
   * time; struck about the wrong point it ranges over tens of pixels. */
  const walk = await page.evaluate(() => {
    const host = document.getElementById("island-tools")!;
    const at = host.getBoundingClientRect();
    const path = document.getElementById("tools-arc") as unknown as SVGPathElement;
    const total = path.getTotalLength();
    const rays: number[] = [];
    for (let i = 0; i <= 8; i++) {
      const point = path.getPointAtLength((total * i) / 8);
      rays.push(Math.atan2(point.y, point.x));
    }
    /* ⚠️ Out of the way first. The invisible hit band lies over this very
     * region and would answer `elementFromPoint` in the island's place. */
    host.style.display = "none";
    const island = document.getElementById("island")!;
    const hits = rays.map(angle => {
      for (let r = 110; r > 4; r -= 0.5) {
        const el = document.elementFromPoint(
          at.left + r * Math.cos(angle), at.top + r * Math.sin(angle));
        if (el && island.contains(el)) return r;
      }
      return -1;
    });
    host.style.display = "";
    return hits;
  });
  expect(Math.min(...walk)).toBeGreaterThan(0);
  expect(Math.max(...walk) - Math.min(...walk)).toBeLessThan(3);

  /* ⚠️ Closed, the arc is BARE. The actions are in the DOM — they have to be,
   * for the keyboard — but nothing of them is on screen until it is reached
   * for. */
  const seen = () => page.evaluate(() =>
    [...document.querySelectorAll("#island-tools .screen-tool")]
      .filter(t => getComputedStyle(t).opacity !== "0").length);
  expect(await seen()).toBe(0);

  const grab = await onArc(page, 0.125);
  await page.mouse.move(grab.x, grab.y);
  await expect.poll(seen).toBe(2);

  /* ⚠️ And it stays open under a pointer that has not moved. */
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(90);
    expect(await tools.evaluate(e => e.className)).toBe("is-open");
  }

  /* ⚠️ The hit band spans every radius the line can swing through — back to
   * the island's own corner, and out past the widest the line ever gets. A
   * band that merely traced the line oscillates: the pointer opens it, the
   * line swings outward, the band goes with it, the pointer is left over
   * nothing, `pointerleave` fires, it shuts — and the pointer has not moved,
   * so it opens again.
   *
   * Asserted on the band's own geometry rather than by watching it flicker:
   * the screens here have one and two actions, and at those counts the line
   * barely moves, so the loop is not reachable from the outside. It becomes
   * reachable the day a screen grows a third. */
  const band = await page.evaluate(() => {
    const reach = document.getElementById("tools-reach")!;
    const island = document.getElementById("island")!.getBoundingClientRect();
    const host = document.getElementById("island-tools")!.getBoundingClientRect();
    const mid = Number(/A([\d.]+)/.exec(reach.getAttribute("d")!)![1]);
    const wide = Number(reach.getAttribute("stroke-width"));
    return {inner: mid - wide / 2, outer: mid + wide / 2, corner: island.bottom - host.top};
  });
  expect(band.inner).toBeLessThanOrEqual(band.corner + 2);
  expect(band.outer - band.inner).toBeGreaterThan(30);

  /* The actions are laid ON the circle — which is the thing the shape is for.
   * Same distance from the corner's centre, different angles, in order. */
  const laid = await page.evaluate(() => {
    const host = document.getElementById("island-tools")!.getBoundingClientRect();
    return [...document.querySelectorAll("#island-tools .screen-tool")].map(t => {
      const b = t.getBoundingClientRect();
      const dx = b.left + b.width / 2 - host.left;
      const dy = b.top + b.height / 2 - host.top;
      return {r: Math.hypot(dx, dy), turn: Math.atan2(dy, dx) / (2 * Math.PI), size: b.width};
    });
  });
  expect(Math.abs(laid[0].r - laid[1].r)).toBeLessThan(1);
  expect(laid[1].turn - laid[0].turn).toBeGreaterThan(0.04);

  /* ⚠️ And they keep the LINE'S CLEARANCE, not its radius. An action is a
   * disc three times the line's thickness; parked on the line's own circle its
   * inner edge lands inside the island's corner and the row looks welded on.
   * The shared invariant is the gap you can see, so that is what is asserted. */
  const gap = (r: number, size: number) => r - size / 2 - clear.corner;
  const onLine = gap(grab.radius, clear.stroke);
  const onDisc = gap(laid[0].r, laid[0].size);
  expect(Math.abs(onDisc - onLine)).toBeLessThan(1.5);
  expect(onDisc).toBeGreaterThan(4);

  /* It follows the screen, and Home has nothing to do — so there is no arc at
   * all rather than a bare one. */
  await page.locator('[data-tab="media"]').click();
  await expect(tools.locator(".screen-tool")).toHaveCount(1);
  const one = await onArc(page, 0.125);
  await page.mouse.move(one.x, one.y);
  await expect(tools.getByRole("button", {name: "Show what is next"})).toBeVisible();

  await page.locator('[data-tab="home"]').click();
  await expect(tools).toBeHidden();

  /* ⚠️ And the header does not keep a copy. The row used to live beside the
   * pin and the close; two homes for one control is how one of them goes
   * stale. */
  await expect(page.locator("#screen-tools")).toHaveCount(0);
});

/* ⚠️ The left edge, because the arc was top-edge-only in an earlier shape and
 * the failure was silent: the actions were simply not on the screen. */
test("on a side edge the arc moves to that island's own far corner", async ({page}) => {
  await page.emulateMedia({reducedMotion: "reduce"});
  await page.goto(`${HOME}&edge=left`);

  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();
  await page.locator('[data-tab="calendar"]').click();
  await expect(page.locator("#island-tools")).toBeVisible();

  const where = await page.evaluate(() => {
    const island = document.getElementById("island")!.getBoundingClientRect();
    const host = document.getElementById("island-tools")!.getBoundingClientRect();
    return {
      // The host is the quadrant OUTSIDE the corner it wraps — for a left-edge
      // island that is the bottom-right one, so it starts inside the island's
      // box and runs out past both of those edges.
      past: host.right > island.right && host.bottom > island.bottom,
      square: Math.abs(host.width - host.height) < 1,
    };
  });
  expect(where.past).toBe(true);
  expect(where.square).toBe(true);
  await page.screenshot({path: "test-results/arc-left.png"});
});
