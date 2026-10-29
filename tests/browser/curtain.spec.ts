import { test, expect, type Page } from "@playwright/test";

/* The curtain (curtain.rs), staged by `curtain.html?why=…` over a stand-in page:
 * earn, first-block, spend, focus, held, locked, limit; `&buy=off`, `&refuse`,
 * `&nothing`. What it asked Rust and Helm for is read back from
 * `window.__curtainCalls`. Pictures at device scale 2 go to `CURTAIN_SHOTS`
 * (default test-results/), for checking the look by eye. */

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

const shots = process.env.CURTAIN_SHOTS ?? "test-results";

async function open(page: Page, query: string) {
  await page.goto(`/curtain.html?${query}`);
  await expect(page.locator("#curtain")).toHaveClass(/is-up/);
  // The dim's 700 ms and the column's rise, settled.
  await page.waitForTimeout(1100);
}

async function calls(page: Page, command: string) {
  return page.evaluate(name => (window as unknown as { __curtainCalls: { command: string; args: Record<string, unknown> }[] })
    .__curtainCalls.filter(one => one.command === name).map(one => one.args), command);
}

/** The column, clipped with room around it; and the whole screen once. */
async function picture(page: Page, name: string, whole = false) {
  if (whole) return page.screenshot({ path: `${shots}/curtain-${name}.png` });
  const box = await page.locator(".column").boundingBox();
  await page.screenshot({ path: `${shots}/curtain-${name}.png`, clip: { x: box!.x - 48, y: box!.y - 48, width: box!.width + 96, height: box!.height + 96 } });
}

test("earned time spent: the line, the hours, back to work and five minutes for a price", async ({ page }) => {
  await open(page, "why=earn");
  await expect(page.locator("#title")).toHaveText("Zarobiony czas na dziś się skończył");
  await expect(page.locator("#where")).toHaveText("YouTube w Brave");
  await expect(page.locator("#body")).toHaveText("Na teraz: Koszyk w Esono.");
  await expect(page.locator("#worked")).toHaveText("Przepracowane 2 h 40 min");
  await expect(page.locator("#next")).toHaveText("Kolejne 15 min za 20 min pracy");
  await expect(page.locator("#work")).toBeVisible();
  await expect(page.locator("#work")).toBeFocused();
  await expect(page.locator("#buy")).toHaveText("5 minut za 10 zł");
  await expect(page.locator("#spend")).toBeHidden();
  await expect(page.locator("#freeText")).toContainText("Wolne od");
  expect(await calls(page, "curtain_ready")).toEqual([{ serial: 1 }]);
  await picture(page, "earn");
});

test("the way out shows after a few seconds; Escape works before it", async ({ page }) => {
  await open(page, "why=earn");
  await expect(page.locator("#out")).toBeHidden();
  await expect(page.locator("#out")).toBeVisible({ timeout: 6000 });
  await expect(page.locator("#out")).toHaveClass(/is-shown/);
  await page.waitForTimeout(500);
  await picture(page, "earn-full", true);

  await open(page, "why=earn");
  await expect(page.locator("#out")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#curtain")).toBeHidden();
  expect(await calls(page, "curtain_close")).toEqual([{ serial: 1, opened: false }]);
});

test("back to work and the way out both close it, as a decision", async ({ page }) => {
  await open(page, "why=earn");
  await page.locator("#work").click();
  await expect(page.locator("#curtain")).toBeHidden();
  expect(await calls(page, "curtain_close")).toEqual([{ serial: 1, opened: false }]);
  await open(page, "why=locked");
  await page.locator("#out").click({ timeout: 6000 });
  await expect(page.locator("#curtain")).toBeHidden();
});

test("buying asks Helm, says what it cost, and lifts as opened", async ({ page }) => {
  await open(page, "why=earn");
  await page.locator("#buy").click();
  await expect(page.locator("#note")).toHaveText("Otwarte na 5 min. Z funduszu poszło 10 zł.");
  await expect(page.locator("#note")).toHaveClass(/is-good/);
  expect(await calls(page, "helm_blocker")).toEqual([{ action: { action: "buy" } }]);
  await picture(page, "bought");
  await expect(page.locator("#curtain")).toBeHidden({ timeout: 4000 });
  expect(await calls(page, "curtain_close")).toEqual([{ serial: 1, opened: true }]);
});

test("Helm saying no is shown in its words, and the button comes back", async ({ page }) => {
  await open(page, "why=earn&refuse");
  await page.locator("#buy").click();
  await expect(page.locator("#note")).toHaveText("That's three times today. The rest can wait.");
  await expect(page.locator("#buy")).toBeEnabled();
  await expect(page.locator("#buy")).toHaveText("5 minut za 10 zł");
  await expect(page.locator("#curtain")).toBeVisible();
});

test("earned minutes left: open fifteen of them", async ({ page }) => {
  await open(page, "why=spend");
  await expect(page.locator("#spend")).toHaveText("Otwórz na 15 min");
  await expect(page.locator("#buy")).toBeHidden();
  await page.locator("#spend").click();
  expect(await calls(page, "helm_blocker")).toEqual([{ action: { action: "spend", minutes: 15 } }]);
  await expect(page.locator("#note")).toHaveText("Otwarte na 15 min.");
});

test("before the first hour, and when Helm's rules allow no buying", async ({ page }) => {
  await open(page, "why=first-block");
  await expect(page.locator("#title")).toHaveText("YouTube po pierwszej godzinie pracy");
  await expect(page.locator("#next")).toHaveText("Pierwsze 15 min za 25 min pracy");
  await expect(page.locator("#buy")).toBeHidden();
  await picture(page, "first-hour");
  await open(page, "why=earn&buy=off");
  await expect(page.locator("#buy")).toBeHidden();
  await expect(page.locator("#work")).toBeVisible();
});

test("a block or a lock: no bar and no money, only the wait", async ({ page }) => {
  await open(page, "why=focus");
  await expect(page.locator("#title")).toHaveText("Trwa blok: Repricer");
  await expect(page.locator("#earn")).toBeHidden();
  await expect(page.locator("#buy")).toBeHidden();
  await expect(page.locator("#free")).toBeHidden();
  await picture(page, "focus");
  await open(page, "why=held");
  await expect(page.locator("#freeText")).toHaveText(/^Otwiera się za 2 h 2\d min$/);
  await picture(page, "held");
});

test("a reading with no line closes itself rather than leave a dark screen", async ({ page }) => {
  await page.goto("/curtain.html?why=earn&nothing");
  await page.waitForTimeout(400);
  await expect(page.locator("#curtain")).toBeHidden();
  expect(await calls(page, "curtain_close")).toEqual([{ serial: 1, opened: false }]);
  expect(await calls(page, "curtain_ready")).toEqual([]);
});
