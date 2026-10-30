import { test, expect, type Page } from "@playwright/test";

/* The wake word (30 Oct): "Jarvis", heard natively by wake.rs, starts exactly
 * what a tap of Alt+Q starts — a hands-free turn that Enter or another tap
 * sends and Escape drops — and every turn records from the microphone picked
 * in Settings → Voice. Staged: `&wake=<ms>` switches it on and hears the word
 * once (`wake:heard` on previewBus), `window.__wake()` hears it again, and
 * Settings → Voice keeps its prefs in sessionStorage (task-client.ts).
 * `WAKE_SHOTS=<dir>` writes a picture of the settings section. */

// ⚠️ The word arrives with no gesture, as from a room: the fake microphone's AudioContext must still run.
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

const USB = "Microphone (USB Audio Device)";

/** His microphones as the webview lists them, and a getUserMedia that keeps what it was asked for. */
async function fakeMics(page: Page, kept: Record<string, unknown> | null) {
  await page.addInitScript(([usb, prefs]) => {
    if (prefs && !sessionStorage.getItem("preview-wake-prefs")) sessionStorage.setItem("preview-wake-prefs", JSON.stringify(prefs));
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: "audioinput", deviceId: "default", label: "Default - Headset (Mateusz's Buds3 Pro Hands-Free)", groupId: "b" },
      { kind: "audioinput", deviceId: "buds", label: "Headset (Mateusz's Buds3 Pro Hands-Free)", groupId: "b" },
      { kind: "audioinput", deviceId: "usb", label: `${usb} (0c76:161f)`, groupId: "u" },
    ] as MediaDeviceInfo[];
    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const w = window as unknown as { __asked: unknown[] };
      (w.__asked ??= []).push(constraints?.audio);
      const ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.4;
      const out = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(out);
      osc.start();
      return out.stream;
    };
  }, [USB, kept] as const);
}

const calls = (page: Page, command: string) => page.evaluate(name => (window as unknown as { __helmCalls: { command: string; args: Record<string, unknown> }[] })
  .__helmCalls.filter(one => one.command === name).map(one => one.args), command);
const asked = (page: Page) => page.evaluate(() => (window as unknown as { __asked?: { deviceId?: unknown }[] }).__asked ?? []);
const glance = (page: Page) => page.locator("#island-voice");
const chosen = { wakeWord: true, wakeMic: "{0.0.1.00000000}.{usb}", wakeMicName: USB, wakeSensitivity: "normal", hasKey: true };

test("the word starts a hands-free turn on the chosen microphone, and Enter sends it", async ({ page }) => {
  await fakeMics(page, chosen);
  await page.goto("/tasks.html?helm&noagents&wake=1500");
  await expect(glance(page)).toHaveAttribute("data-phase", "listening", { timeout: 6000 });
  await expect(glance(page)).toHaveAttribute("data-free", "true");
  await expect(page.locator(".v-keys .v-key")).toHaveText(["Enter", "Esc"]);
  // ⚠️ The USB microphone by its webview id, never the default (his earbuds).
  expect((await asked(page)).at(-1)?.deviceId).toEqual({ exact: "usb" });
  expect(await calls(page, "wake_turn")).toEqual([{ live: true }]);
  await page.waitForTimeout(900);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page, "helm_transcribe")).length).toBe(1);
  await expect(glance(page)).toBeHidden({ timeout: 20_000 });
  expect((await calls(page, "wake_turn")).at(-1)).toEqual({ live: false });
});

test("a word inside a turn, or with the switch off, starts nothing; Escape drops a woken turn", async ({ page }) => {
  await fakeMics(page, chosen);
  await page.goto("/tasks.html?helm&noagents");
  await page.waitForTimeout(800);
  await page.evaluate(() => (window as unknown as { __wake: () => void }).__wake());
  await expect(glance(page)).toHaveAttribute("data-free", "true", { timeout: 4000 });
  // Heard again mid-turn: the same turn goes on, nothing new opens.
  const opened = (await asked(page)).length;
  await page.evaluate(() => (window as unknown as { __wake: () => void }).__wake());
  await page.waitForTimeout(600);
  await expect(glance(page)).toHaveAttribute("data-phase", "listening");
  expect((await asked(page)).length).toBe(opened);
  await page.keyboard.press("Escape");
  await expect(glance(page)).toBeHidden();
  expect((await calls(page, "helm_transcribe")).length).toBe(0);

  // Switched off: the word is just a word.
  await page.evaluate(() => sessionStorage.setItem("preview-wake-prefs", JSON.stringify({ wakeWord: false, hasKey: true })));
  await page.reload();
  await page.waitForTimeout(800);
  await page.evaluate(() => (window as unknown as { __wake: () => void }).__wake());
  await page.waitForTimeout(800);
  await expect(glance(page)).toBeHidden();
});

test("with no microphone chosen, Alt+Q records from the default as before", async ({ page }) => {
  await fakeMics(page, null);
  await page.goto("/tasks.html?helm&noagents");
  await page.keyboard.down("Alt");
  await page.keyboard.down("q");
  await page.waitForTimeout(120);
  await page.keyboard.up("q");
  await page.keyboard.up("Alt");
  await expect(glance(page)).toHaveAttribute("data-free", "true");
  expect((await asked(page)).at(-1)?.deviceId).toBeUndefined();
  await page.keyboard.press("Escape");
});

test("Settings → Voice: the switch, the microphone, sensitivity and the key persist; the lamp lights on the word", async ({ page }) => {
  await page.goto("/task-editor.html#voice");
  const pane = page.locator("#pane-voice");
  await expect(pane).toBeVisible();
  const on = page.locator("#wake-on");
  await expect(on).not.toBeChecked();
  await expect(page.locator("#wake-lamp")).toHaveAttribute("data-tip", "Off");
  const mics = pane.locator(".wake-mic");
  await expect(mics).toHaveCount(4);
  // The earbuds' hands-free microphone is marked; the others are not.
  const buds = mics.filter({ hasText: "Buds3 Pro" });
  await expect(buds.locator(".wake-warn")).toHaveAttribute("data-tip", "Keeps your earbuds in call quality");
  await expect(pane.locator(".wake-warn")).toHaveCount(1);
  await expect(pane.locator(".wake-mic.is-chosen")).toHaveCount(0);

  await mics.filter({ hasText: USB }).click();
  await page.locator('#wake-level [data-level="high"]').click();
  await on.click();
  await expect(page.locator("#wake-lamp")).toHaveAttribute("data-tip", "Needs your AccessKey");
  await page.locator("#wake-key").fill("test-key==");
  await page.locator("#wake-key-save").click();
  await expect(page.locator("#wake-saved")).toBeVisible();
  await expect(page.locator("#wake-key")).toHaveValue("");
  await page.waitForTimeout(400); // the save is debounced
  await expect(page.locator("#wake-lamp")).toHaveClass(/is-listening/);
  await expect(page.locator("#wake-lamp")).toHaveAttribute("data-tip", "Listening for “Jarvis”");

  await page.reload();
  await expect(page.locator("#pane-voice")).toBeVisible();
  await expect(page.locator("#wake-on")).toBeChecked();
  await expect(page.locator(".wake-mic.is-chosen")).toContainText(USB);
  await expect(page.locator('#wake-level [data-level="high"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#wake-saved")).toBeVisible();
  // ⚠️ The key is never shown back, only that one is saved.
  await expect(page.locator("#wake-key")).toHaveValue("");

  await page.evaluate(() => (window as unknown as { __wake: () => void }).__wake());
  await expect(page.locator("#wake-lamp")).toHaveClass(/is-heard/);
  const shots = process.env.WAKE_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/settings-voice.png` });
  await expect(page.locator("#wake-lamp")).not.toHaveClass(/is-heard/, { timeout: 4000 });
  if (shots) {
    await buds.locator(".wake-warn").hover();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${shots}/settings-voice-tip.png` });
  }
});
