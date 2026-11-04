import { test, expect, type Page } from "@playwright/test";

/* A project for a to-do, chosen from Today; and Delete on the calendar asking first. */

async function openToday(page: Page) {
  await page.goto(`/tasks.html?click&noagents&nofollow&helm`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Today");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Today$/ }).first().click();
  await expect(page.locator(".helm-row").first()).toBeVisible();
  await page.waitForTimeout(500);
}

const queued = (page: Page) => page.evaluate(() =>
  (window as unknown as { __helmCalls: { command: string; args: { action: Record<string, unknown> } }[] }).__helmCalls
    .filter(one => one.command === "helm_queue").map(one => one.args.action));

const NAME = "Napisać post na blog HADA";

test("a to-do can be given a project from Today", async ({ page }) => {
  await openToday(page);
  await page.getByRole("button", { name: `Project: ${NAME}` }).click({ force: true });
  const menu = page.locator(".helm-project-menu");
  await expect(menu).toBeVisible();
  const first = menu.locator('[role="option"]').first();
  const label = (await first.textContent()) ?? "";
  expect(label).not.toBe("");
  await first.click();
  await expect(menu).toHaveCount(0);
  const action = (await queued(page)).find(one => one.act === "project");
  expect(action).toMatchObject({ act: "project", key: "todo:1" });
  expect(typeof action!.projectId).toBe("number");
});

test("the menu closes on a press elsewhere and on Escape, sending nothing", async ({ page }) => {
  await openToday(page);
  const open = page.getByRole("button", { name: `Project: ${NAME}` });
  await open.click({ force: true });
  await page.keyboard.press("Escape");
  await expect(page.locator(".helm-project-menu")).toHaveCount(0);
  await expect(page.locator('.screen[data-screen="helm"]')).toBeVisible();
  await open.click({ force: true });
  await expect(page.locator(".helm-project-menu")).toBeVisible();
  await page.mouse.click(5, 700);
  await expect(page.locator(".helm-project-menu")).toHaveCount(0);
  expect((await queued(page)).filter(one => one.act === "project")).toEqual([]);
});

test("Delete on a calendar event takes a second press", async ({ page }) => {
  await page.goto(`/tasks.html?click&noagents&nofollow&calwrite`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Calendar");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Calendar$/ }).first().click();
  await expect(page.locator(".cal-weekgrid")).toBeVisible();
  await page.waitForTimeout(600);
  const block = page.locator('.cal-block[data-cal-id="f1"]');
  await block.evaluate(one => {
    const host = document.querySelector("#calendar-body") as HTMLElement;
    host.scrollTop += one.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientHeight / 2;
  });
  await page.waitForTimeout(150);
  await block.click();
  const drop = page.locator(".cal-panel-drop");
  const writes = () => page.evaluate(() => (window as unknown as { __calWrites?: unknown[] }).__calWrites ?? []);
  await drop.click();
  await expect(drop).toContainText("Press again");
  expect(await writes()).toEqual([]);
  await page.waitForTimeout(3200);
  await expect(drop).toHaveText("Delete");
  expect(await writes()).toEqual([]);
  await drop.click();
  await drop.click();
  await page.waitForTimeout(200);
  expect(await writes()).toHaveLength(1);
  await expect(page.locator('.cal-block[data-cal-id="f1"]')).toHaveCount(0);
});
