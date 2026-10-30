import { test, expect, type Page } from "@playwright/test";

/* Closing the day (batch 12): helm-close.ts against the preview's fake
 * `GET /api/notch/close` (task-client.ts `demoCloseDay`). Every row decision
 * is optimistic and turns back on a refusal; Zamknij dzień posts the pick for
 * tomorrow. What was sent is read back from `window.__helmCalls`; pictures go
 * where `MOMENT_SHOTS` says. */

async function calls(page: Page, command: string) {
  return page.evaluate(name => (window as unknown as { __helmCalls: { command: string; args: Record<string, unknown> }[] })
    .__helmCalls.filter(one => one.command === name).map(one => one.args), command);
}

async function picture(page: Page, name: string) {
  await page.waitForTimeout(700);
  const box = await page.locator("#island-expanded").boundingBox();
  if (!box) return;
  const dir = process.env.MOMENT_SHOTS ?? "test-results";
  await page.screenshot({ path: `${dir}/close-${name}.png`, clip: { x: box.x - 8, y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 } });
}

/** Through the palette, as he would without the moment. */
async function openClose(page: Page, more = "") {
  await page.goto(`/tasks.html?helm&noagents&nocal${more}`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Zamknij dzień");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Zamknij dzień$/ }).first().click();
  await expect(page.locator(".helm-close")).toBeVisible();
  await expect(page.locator(".hc-reading")).toBeVisible();
}

const row = (page: Page, key: string) => page.locator(`.hc-row[data-key="${key}"]`);
const logKey = (page: Page, project: number) => page.evaluate(id => {
  const d = new Date();
  return `log:${id}:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}, project);

test("the day's reading on top, then the three decisions and one button", async ({ page }) => {
  await openClose(page);
  await expect(page.locator(".hc-fig-value")).toHaveText(["5 h 10", "1 h 25", "6"]);
  await expect(page.locator(".hc-summary-text")).toContainText("Repricer domknięty");
  await expect(page.locator(".hc-sec-head")).toHaveText(["Czas z kodu", "Zostało", "Jutro na start"]);
  await expect(page.locator(".helm-close .hp-btn.is-primary")).toHaveCount(1);
  // Today's own header and list step aside.
  await expect(page.locator(".helm-list")).toBeHidden();
  await picture(page, "open");
});

test("coded time: the minutes are his to change, Zaloguj logs them, Pomiń only hides", async ({ page }) => {
  await openClose(page);
  const esono = row(page, await logKey(page, 3));
  await esono.locator(".hc-min-input").fill("60");
  await esono.locator(".hc-log").click();
  await expect(esono.locator(".hc-outcome")).toHaveText("Zalogowane 1 h");
  expect((await calls(page, "helm_queue")).map(a => a.action)).toEqual([{ act: "done", key: await logKey(page, 3), minutes: 60 }]);
  const codenotch = row(page, await logKey(page, 30));
  await codenotch.locator(".hc-skip").click();
  await expect(codenotch.locator(".hc-outcome")).toHaveText("Pominięte");
  expect((await calls(page, "helm_queue")).length).toBe(1);
});

test("what is left: Zrobione, Jutro (with a group's item keys), Odpuść", async ({ page }) => {
  await openClose(page);
  await row(page, "request:1").locator(".hc-act.is-done").click();
  await row(page, "small").locator(".hc-act.is-later").click();
  await row(page, "request:22").locator(".hc-act.is-drop").click();
  await expect(row(page, "small").locator(".hc-outcome")).toHaveText("Jutro");
  await expect(row(page, "request:22").locator(".hc-outcome")).toHaveText("Odpuszczone");
  expect((await calls(page, "helm_queue")).map(a => a.action)).toEqual([
    { act: "done", key: "request:1" },
    { act: "snooze", key: "small", keys: ["todo:4", "todo:5", "todo:6"] },
    { act: "today", key: "request:22", on: false },
  ]);
  await picture(page, "settled");
});

test("a refused row turns back", async ({ page }) => {
  await openClose(page, "&queue=fail");
  await row(page, "request:1").locator(".hc-act.is-done").click();
  await expect(row(page, "request:1").locator(".hc-outcome")).toHaveText("Zrobione");
  await expect(row(page, "request:1").locator(".hc-act.is-done")).toBeVisible();
});

test("Zamknij dzień posts the pick for tomorrow and goes back to Today", async ({ page }) => {
  await openClose(page);
  await expect(page.locator('.hc-first[aria-checked="true"]')).toHaveAttribute("data-key", "request:1");
  await page.locator('.hc-first[data-key="request:11"]').click();
  await expect(page.locator('.hc-first[aria-checked="true"]')).toHaveAttribute("data-key", "request:11");
  await page.locator(".hc-go").click();
  await expect(page.locator(".helm-close")).toBeHidden();
  await expect(page.locator(".helm-list")).toBeVisible();
  expect(await calls(page, "helm_notch_post")).toEqual([{ path: "/api/notch/close", body: { first: "request:11" } }]);
});

test("the moon in Today's header opens it, Escape goes back", async ({ page }) => {
  await page.goto("/tasks.html?helm&noagents&nocal");
  const pill = await page.locator("#island").boundingBox();
  await page.mouse.move(pill!.x + pill!.width / 2, pill!.y + pill!.height / 2);
  await expect(page.locator("#island-expanded")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Today");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Today$/ }).first().click();
  await expect(page.locator('.screen[data-screen="helm"]')).toBeVisible();
  await page.waitForTimeout(600);
  await picture(page, "today-header");
  await page.locator(".helm-close-day").click();
  await expect(page.locator(".helm-close")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".helm-close")).toBeHidden();
  await expect(page.locator(".helm-list")).toBeVisible();
});

test("a day already closed says so, with nothing to decide", async ({ page }) => {
  await openClose(page, "&close=done");
  await expect(page.locator(".hc-closed")).toHaveText("Dzień zamknięty");
  await expect(page.locator(".hc-sec")).toHaveCount(0);
  await expect(page.locator(".hc-go")).toHaveCount(0);
});
