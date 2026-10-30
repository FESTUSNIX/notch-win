import { test, expect, type Page } from "@playwright/test";

/* Peeks, second place and the wheel (batch 13): peeks.ts, peek-feed.ts and the
 * pill's wiring in tasks.ts. Staged by task-client.ts's peeks block: `?helm&
 * running` puts a Helm block on the pill (45) with the demo track second (40);
 * `&peek=` makes each peek cross into its window a few seconds after load, so
 * it arrives through the real readers. Click mode (`?click`), because hover
 * mode opens the panel under the pointer. Pictures go where `PEEK_SHOTS` says. */

const pill = (page: Page) => page.locator("#island-collapsed");
const base = "/tasks.html?click&helm&running&noagents&nocal";

async function picture(page: Page, name: string) {
  await page.waitForTimeout(450);
  const box = await page.locator("#island").boundingBox();
  if (!box) return;
  const dir = process.env.PEEK_SHOTS ?? "test-results";
  await page.screenshot({ path: `${dir}/peek-${name}.png`, clip: { x: box.x - 24, y: 0, width: box.width + 48, height: box.y + box.height + 16 } });
}

test("the block owns the pill and music is second place, as a mark at the end", async ({ page }) => {
  await page.goto(base);
  await expect(pill(page)).toHaveAttribute("data-kind", "focus");
  await expect(pill(page)).toHaveAttribute("data-view", "owner");
  await expect(pill(page).locator(".pill-label")).toHaveText("Rynek Czeski — poprawki w koszyku");
  await expect(pill(page).locator(".pill-second.is-eq.on")).toBeVisible();
  await picture(page, "owner-block-music-second");
});

test("a song change peeks for a few seconds, then the block comes back", async ({ page }) => {
  await page.goto(`${base}&peek=music&peekat=1200`);
  await expect(pill(page)).toHaveAttribute("data-kind", "peek", { timeout: 4000 });
  await expect(pill(page).locator(".pill-label")).toHaveText("Midnight City");
  await expect(pill(page).locator(".pill-value")).toHaveText("M83");
  await expect(pill(page).locator(".pill-second")).toHaveCount(0);
  await picture(page, "music");
  await expect(pill(page)).toHaveAttribute("data-kind", "focus", { timeout: 6000 });
  await expect(pill(page)).toHaveAttribute("data-view", "owner");
});

test("pointing at second place's mark shows it while the pointer stays; the rest of the pill keeps the owner", async ({ page }) => {
  await page.goto(base);
  await expect(pill(page)).toHaveAttribute("data-kind", "focus");
  // The pill itself hovered keeps the owner and its Pause.
  await pill(page).locator(".pill-copy").hover();
  await expect(pill(page)).toHaveAttribute("data-view", "owner");
  await pill(page).locator(".pill-second").hover();
  await expect(pill(page)).toHaveAttribute("data-view", "second");
  await expect(pill(page)).toHaveAttribute("data-kind", "media");
  await expect(page.locator("#island-expanded")).toBeHidden();
  // The mark at the end now stands for the owner it hides.
  await expect(pill(page).locator(".pill-second:not(.is-eq)")).toBeVisible();
  await picture(page, "hover-second");
  await page.mouse.move(640, 700);
  await expect(pill(page)).toHaveAttribute("data-view", "owner");
  await expect(pill(page)).toHaveAttribute("data-kind", "focus");
});

test("the wheel cycles owner → second → the last peek → owner, and idle returns", async ({ page }) => {
  await page.goto(`${base}&peek=music&peekat=800`);
  await expect(pill(page)).toHaveAttribute("data-kind", "peek", { timeout: 4000 });
  await expect(pill(page)).toHaveAttribute("data-kind", "focus", { timeout: 6000 });
  const box = (await pill(page).boundingBox())!;
  // The wheel without the hover: the pointer parked just off the pill's edge would
  // also be hover; dispatch the wheel straight at the pill instead.
  const wheel = () => pill(page).dispatchEvent("wheel", { deltaY: 120, deltaX: 0 });
  void box;
  await wheel();
  await expect(pill(page)).toHaveAttribute("data-view", "second");
  await expect(pill(page)).toHaveAttribute("data-kind", "media");
  await wheel();
  await expect(pill(page)).toHaveAttribute("data-view", "replay");
  await expect(pill(page).locator(".pill-label")).toHaveText("Midnight City");
  await picture(page, "wheel-replay");
  await wheel();
  await expect(pill(page)).toHaveAttribute("data-view", "owner");
  // The wheel never stepped a screen: the panel is still shut.
  await expect(page.locator("#island-expanded")).toBeHidden();
  await wheel();
  await expect(pill(page)).toHaveAttribute("data-view", "second");
  await expect(pill(page)).toHaveAttribute("data-view", "owner", { timeout: 7000 });
});

test("nothing peeks while the panel is open; the peek waits and shows after", async ({ page }) => {
  await page.goto(`${base}&peek=music&peekat=2000`);
  await expect(pill(page)).toHaveAttribute("data-kind", "focus");
  await pill(page).click();
  await expect(page.locator("#island-expanded")).toBeVisible();
  await page.waitForTimeout(2600);
  await expect(pill(page)).not.toHaveAttribute("data-kind", "peek");
  await page.keyboard.press("Escape");
  await expect(page.locator("#island-expanded")).toBeHidden();
  // A peek never starts under the pointer: away from the pill, it shows.
  await page.mouse.move(640, 700);
  await expect(pill(page)).toHaveAttribute("data-kind", "peek", { timeout: 3000 });
  await expect(pill(page).locator(".pill-label")).toHaveText("Midnight City");
});

const each: [string, string, RegExp, string?][] = [
  ["play", "pause", /potion shop/],
  ["block5", "block5", /^Zostało 5 min$/, "accent"],
  ["over", "over", /^Czas minął$/, "warn"],
  ["done", "done", /^Zrobione · 29 min$/, "good"],
  ["meeting", "meeting", /^Standup NXM$/, "accent"],
  ["leave&rain", "leave-rain", /^Czas wyjść · weź parasol$/, "accent"],
];
for (const [flag, name, title, tone] of each) {
  test(`peek: ${name}`, async ({ page }) => {
    await page.goto(`${base}&peek=${flag}&peekat=1000`);
    await expect(pill(page)).toHaveAttribute("data-kind", "peek", { timeout: 9000 });
    await expect(pill(page).locator(".pill-label")).toHaveText(title);
    if (tone) await expect(pill(page)).toHaveAttribute("data-tone", tone);
    if (name === "meeting") await expect(pill(page).locator(".pill-peek-act")).toBeVisible();
    await picture(page, name);
  });
}
