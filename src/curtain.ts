/* The curtain: a calm dim over a locked site in front (curtain.rs).
 *
 * Its own window, over the monitor the browser is on. It shows the Guardian's
 * line (Helm's, in Polish), what his hours have earned, and the ways on: back to
 * work, earned minutes to spend, five minutes for a price — and the time until
 * the sites open by themselves.
 *
 * ⚠️ It must never trap him. Escape closes it from the first frame, the plain
 * way out shows after `OUT_AFTER`, and if anything here fails to draw, the page
 * closes itself rather than leave a dark screen (Rust also puts the window away
 * when the page never says it drew).
 *
 * ⚠️ `invoke` directly, as ambient.ts does: task-client carries the island's
 * preview and fixtures, which this window doesn't need. The preview here is its
 * own (`?why=…`), below.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { barOf, offerOf, readReading, type Reading, type Showing, type Site } from "./curtain-view.ts";
import { paintIcon, type TaskIcon } from "./task-icons";
import { setMotion, still } from "./motion-pref";
import "./curtain.css";

const native = isTauri();
/** The plain way out appears after this. Escape and "back to work" work at once. */
const OUT_AFTER = 4000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const curtain = $("curtain");

/* What the preview was asked to do, for the browser tests (`window.__curtainCalls`). */
const calls: { command: string; args: Record<string, unknown> }[] = [];
if (!native) (window as unknown as { __curtainCalls: typeof calls }).__curtainCalls = calls;

const call = <T = void>(command: string, args: Record<string, unknown> = {}): Promise<T> =>
  native ? invoke<T>(command, args) : preview.call<T>(command, args);

let showing: (Showing & { reading: Reading }) | null = null;
let outTimer = 0;
let tick = 0;
let busy = false;

function show(next: Showing) {
  const reading = readReading(next.reading);
  if (!reading) {
    // Nothing to say is no reason to cover a screen.
    void call("curtain_close", { serial: next.serial, opened: false }).catch(() => {});
    return;
  }
  const replaying = showing?.serial === next.serial && curtain.classList.contains("is-up");
  showing = { ...next, reading };
  draw();
  if (replaying) return;
  busy = false;
  note("");
  for (const id of ["work", "spend", "buy"]) $<HTMLButtonElement>(id).disabled = false;
  curtain.hidden = false;
  curtain.classList.remove("is-closing");
  $("out").classList.remove("is-shown");
  $("out").hidden = true;
  // A frame later, so the fade starts from transparent rather than jumping in.
  requestAnimationFrame(() => requestAnimationFrame(() => curtain.classList.add("is-up")));
  clearTimeout(outTimer);
  outTimer = window.setTimeout(() => {
    $("out").hidden = false;
    requestAnimationFrame(() => $("out").classList.add("is-shown"));
  }, OUT_AFTER);
  clearInterval(tick);
  // The countdown and the next hour move with the clock between Helm's readings.
  tick = window.setInterval(draw, 30_000);
  $("work").focus({ preventScroll: true });
  void call("curtain_ready", { serial: next.serial }).catch(() => {});
}

function draw() {
  if (!showing) return;
  const r = showing.reading;
  const offer = offerOf(showing, new Date());
  $("where").textContent = offer.where;
  $("title").textContent = r.title;
  $("body").textContent = r.body;
  $("body").hidden = !r.body;

  $("earn").hidden = !offer.earning;
  if (offer.earning) {
    const bar = barOf(r.earn);
    const [spent, left, next] = Array.from($("bar").children) as HTMLElement[];
    spent.style.flexBasis = `${bar.spent * 100}%`;
    spent.hidden = bar.spent <= 0;
    left.style.flexBasis = `${bar.left * 100}%`;
    left.hidden = bar.left <= 0;
    next.style.flexBasis = `${bar.next * 100}%`;
    (next.firstElementChild as HTMLElement).style.width = `${bar.into * 100}%`;
    $("worked").textContent = offer.worked;
    $("next").textContent = offer.next ?? "";
  }

  const spend = $<HTMLButtonElement>("spend");
  spend.hidden = !offer.spend;
  if (offer.spend) spend.textContent = offer.spend.label;
  const buy = $<HTMLButtonElement>("buy");
  buy.hidden = !offer.buy;
  if (offer.buy) buy.textContent = offer.buy.label;

  // When earned time is the story the clock time says when it's free; otherwise
  // Helm's line already says when, and the wait is what's left to add.
  const free = offer.earning ? offer.free : null;
  $("free").hidden = !free && !offer.wait;
  $("freeText").textContent = free ?? (offer.wait ? `Otwiera się ${offer.wait}` : "");
  $("wait").textContent = free && offer.wait ? offer.wait : "";
}

function note(text: string, good = false) {
  $("note").textContent = text;
  $("note").hidden = !text;
  $("note").classList.toggle("is-good", good);
}

/** Fade, then tell Rust: the window is hidden after the page has, so the next
 *  opening never shows this one's last frame (AGENTS 763). */
function close(opened: boolean) {
  if (!showing) return;
  const serial = showing.serial;
  fadeOut(() => void call("curtain_close", { serial, opened }).catch(() => {}));
}

function fadeOut(then?: () => void) {
  clearTimeout(outTimer);
  clearInterval(tick);
  curtain.classList.add("is-closing");
  curtain.classList.remove("is-up");
  window.setTimeout(() => {
    curtain.hidden = true;
    curtain.classList.remove("is-closing");
    showing = null;
    then?.();
  }, still() ? 0 : 300);
}

async function act(body: Record<string, unknown>, button: HTMLButtonElement, done: string) {
  if (busy || !showing) return;
  busy = true;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Chwila…";
  note("");
  try {
    await call("helm_blocker", { action: body });
    note(done, true);
    /* Rust lifts it on Helm's next answer (read at once after the action); this
     * is only the fallback, for an answer that is slow to say so. */
    const serial = showing?.serial;
    window.setTimeout(() => { if (showing && showing.serial === serial) close(true); }, 2500);
  } catch (error) {
    note(String((error as Error)?.message ?? error) || "Helm said no.");
    button.disabled = false;
    button.textContent = label;
    busy = false;
  }
}

$("work").addEventListener("click", () => close(false));
$("out").addEventListener("click", () => close(false));
$("spend").addEventListener("click", e => {
  const minutes = showing ? offerOf(showing, new Date()).spend?.minutes : 0;
  if (minutes) void act({ action: "spend", minutes }, e.currentTarget as HTMLButtonElement, `Otwarte na ${minutes} min.`);
});
$("buy").addEventListener("click", e => {
  const buy = showing ? offerOf(showing, new Date()).buy : null;
  if (buy) void act({ action: "buy" }, e.currentTarget as HTMLButtonElement, "Otwarte na 5 min. Z funduszu poszło " + buy.label.replace(/^.* za /, "") + ".");
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { e.preventDefault(); close(false); }
});

/* ── The app's own preferences: the accent and the motion switch ───────── */
interface Prefs { accent: string; motion: string }
function applyPrefs(p: Prefs) {
  if (p.accent) document.documentElement.style.setProperty("--accent", p.accent);
  setMotion(p.motion);
}

async function boot() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-glyph]")) paintIcon(el, el.dataset.glyph as TaskIcon);
  if (!native) { preview.start(); return; }
  try { applyPrefs(await call<Prefs>("get_prefs")); } catch { /* the stock accent stands */ }
  await listen<Prefs>("notch:prefs", e => applyPrefs(e.payload));
  await listen<Showing>("curtain:show", e => show(e.payload));
  await listen<Showing>("curtain:reading", e => { if (showing && e.payload.serial === showing.serial) show(e.payload); });
  await listen<number>("curtain:lift", e => { if (showing && e.payload === showing.serial) fadeOut(); });
  /* ⚠️ Asked for, as well as listened for: the first opening BUILDS this window,
   * and its event is sent before the page has loaded to hear it. */
  const pending = await call<Showing | null>("curtain_pending").catch(() => null);
  if (pending) show(pending);
  void getCurrentWindow().setFocus().catch(() => {});
}

/* ── The browser preview ───────────────────────────────────────────────────
 * `curtain.html?why=earn` (and first-block, spend, focus, held, locked, limit)
 * draws a curtain over a stand-in page; `&buy=off` is a Helm whose rules allow no
 * buying, `&refuse` one that says no to it, `&nothing` a reading with no line.
 * ⚠️ Never reached in the app — `native` is true there. */
const preview = {
  start() {
    document.body.classList.add("is-preview");
    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    backdrop.innerHTML = `<div class="chrome"></div><div class="page"><div class="video"></div><div class="side"><i></i><i></i><i></i><i></i></div></div>`;
    document.body.prepend(backdrop);
    show(preview.showing());
  },
  showing(): Showing {
    const q = new URLSearchParams(location.search);
    const why = q.get("why") ?? "earn";
    const now = new Date();
    const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
    const site: Site = { domain: "youtube.com", name: "YouTube", tokens: ["YouTube"], earn: !["focus", "held", "locked", "limit"].includes(why) };
    const earn = why === "first-block"
      ? { perHour: 15, worked: 35, hours: 0, earned: 0, spent: 0, left: 0, nextIn: 25 }
      : why === "spend"
        ? { perHour: 15, worked: 160, hours: 2, earned: 30, spent: 0, left: 30, nextIn: 20 }
        : { perHour: 15, worked: 160, hours: 2, earned: 30, spent: 30, left: 0, nextIn: 20 };
    const opens = why === "focus" ? null : at(why === "limit" ? 48 : why === "held" ? 140 : 230);
    const clock = opens ? new Date(opens).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "";
    const lines: Record<string, [string, string]> = {
      "earn": ["Zarobiony czas na dziś się skończył", "Na teraz: Koszyk w Esono."],
      "first-block": ["YouTube po pierwszej godzinie pracy", "Na start: Koszyk w Esono."],
      "spend": ["Masz 30 min zarobionego czasu", "Wydaj go świadomie albo wróć do pracy."],
      "focus": ["Trwa blok: Repricer", "YouTube poczeka do końca bloku."],
      "held": ["Zablokowane na Twoje życzenie", `Do ${clock}.`],
      "locked": ["YouTube: dziś zamknięte", `Wstęp o ${clock}.`],
      "limit": ["Minuty na tę godzinę wykorzystane", `Wraca o ${clock}.`],
    };
    const [title, body] = lines[why] ?? lines.earn;
    const reading = {
      now: now.toISOString(), why, sites: [site], title: q.has("nothing") ? "" : title, body, earn,
      spend: why === "spend" ? 30 : null,
      buy: why === "earn" && q.get("buy") !== "off" ? { minutes: 5, price: 10 } : null,
      opens,
      until: at(20),
    } as unknown as Reading;
    return { serial: 1, reading, site, browser: "Brave" };
  },
  async call<T>(command: string, args: Record<string, unknown>): Promise<T> {
    calls.push({ command, args });
    if (command === "helm_blocker") {
      await new Promise(r => setTimeout(r, 250));
      if (new URLSearchParams(location.search).has("refuse")) throw new Error("That's three times today. The rest can wait.");
      return { ok: true, cost: 10 } as T;
    }
    return undefined as T;
  },
};

void boot();
