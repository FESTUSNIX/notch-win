import { test, expect, type Page } from "@playwright/test";

/* Google turned the saved sign-in down: the calendar offers to sign in again with
 * the client it already has, keeping the last events on screen. */

async function openCalendar(page: Page, flags: string) {
  await page.goto(`/tasks.html?click&noagents&nofollow&${flags}`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-field").fill("Calendar");
  await page.locator(".palette-row .palette-title").filter({ hasText: /^Calendar$/ }).first().click();
  await expect(page.locator('.screen[data-screen="calendar"]')).toBeVisible();
  await page.waitForTimeout(700);
}

test("signed out: one button, no form, and the events stay", async ({ page }) => {
  await openCalendar(page, "calsignedout");
  const bar = page.locator(".cal-signin");
  await expect(bar).toContainText("Google signed the calendar out");
  await expect(page.locator(".screen-error")).toHaveCount(0);
  await expect(page.locator('.screen[data-screen="calendar"]')).toContainText("Design review");
  await bar.locator("button").click();
  await expect(bar).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __signIns: number }).__signIns)).toBe(1);
});

test("a failed try says why and offers it again", async ({ page }) => {
  await openCalendar(page, "calsignedout&calsignin=fail");
  await page.locator(".cal-signin button").click();
  await expect(page.locator(".screen-error")).toContainText("never arrived");
  await expect(page.locator(".cal-signin button")).toHaveText("Sign in again");
});

test("signed in: no bar", async ({ page }) => {
  await openCalendar(page, "x");
  await expect(page.locator(".cal-signin")).toHaveCount(0);
});
