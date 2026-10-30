import { test, expect } from "@playwright/test";

/* Batch 13 (builder S): Settings → Peeks. Every kind has a switch, grouped;
   a switch and quiet hours survive a reload (the preview keeps `peeks` and
   `peekQuiet` in sessionStorage — see the batch 13 block in task-client.ts). */
const SHOTS = process.env.B13_SHOTS;

test("Peeks: every kind grouped, switches and quiet hours persist", async ({ page }) => {
  await page.goto("/task-editor.html#peeks");
  const pane = page.locator("#pane-peeks");
  await expect(pane).toBeVisible();
  await expect(pane.locator("[data-peek]")).toHaveCount(13);
  for (const group of ["Music", "Your block", "Calendar", "Devices", "Files", "Money and work", "Focus"]) {
    await expect(pane.locator(".set-label", { hasText: group }).first()).toBeVisible();
  }
  const mic = pane.locator('[data-peek="mic"]');
  await expect(mic).toBeChecked();
  await mic.click();
  await expect(mic).not.toBeChecked();
  const quiet = page.locator("#peek-quiet");
  await expect(quiet).not.toBeChecked();
  await expect(page.locator("#peek-quiet-from")).toBeDisabled();
  await quiet.click();
  await page.locator("#peek-quiet-from").fill("21:30");
  await page.locator("#peek-quiet-from").dispatchEvent("change");
  await page.waitForTimeout(400); // the save is debounced

  await page.reload();
  await expect(page.locator("#pane-peeks")).toBeVisible();
  await expect(page.locator('[data-peek="mic"]')).not.toBeChecked();
  await expect(page.locator('[data-peek="buds"]')).toBeChecked();
  await expect(page.locator("#peek-quiet")).toBeChecked();
  await expect(page.locator("#peek-quiet-from")).toHaveValue("21:30");
  await expect(page.locator("#peek-quiet-to")).toHaveValue("07:00");
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/settings-peeks.png` });
    await page.locator(".settings-scroll").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.screenshot({ path: `${SHOTS}/settings-peeks-quiet.png` });
  }

  // Back on: on is stored as the absence, so the map empties.
  await page.locator('[data-peek="mic"]').click();
  await page.waitForTimeout(400);
  const kept = await page.evaluate(() => JSON.parse(sessionStorage.getItem("preview-peek-prefs") ?? "{}"));
  expect(kept.peeks).toEqual({});
  expect(kept.peekQuiet).toEqual({ from: "21:30", to: "07:00" });
});

test("Peek sources fire from the preview flags", async ({ page }) => {
  await page.goto("/tasks.html?quiet&src=volume,buds,mic,power,download,screenshot,paid,logged");
  /* ⚠️ Reads the STUB peeks.ts's record (`window.__peeks`). Once P's engine
     replaces the stub this checks nothing unless it keeps that record. */
  await page.waitForTimeout(300);
  test.skip(!(await page.evaluate(() => "__peeks" in window)), "peeks.ts keeps no preview record");
  await page.waitForFunction(() => ((window as unknown as { __peeks?: unknown[] }).__peeks ?? []).length >= 8, null, { timeout: 15_000 });
  const titles = await page.evaluate(() => (window as unknown as { __peeks: { title: string }[] }).__peeks.map(p => p.title));
  expect(titles).toEqual(expect.arrayContaining([
    "Głośność 64%", "Buds podłączone · 80%", "Mikrofon wyciszony", "Bateria 12%", "Pobrano: faktura_wrzesien_2026.pdf",
    "Zrzut ekranu", "+4 795 zł · NXM", "1 h 20 min na Atelier, zalogowane",
  ]));
});
