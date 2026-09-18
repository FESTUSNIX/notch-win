/* The ring: every screen under the pointer, on one key.
 *
 * ⚠️ **This exists so the shortcut list stops growing.** Six global keys was
 * already the ceiling — every one of them is a combination taken away from
 * every other app on the machine, and on a Polish layout two of them turned out
 * to be letters. A ring is one key for all of it, and it scales with the
 * screens rather than against them.
 *
 * ⚠️ **Aim, do not read.** A radial menu is fast because the target is a
 * DIRECTION, not a word: the same screen is always at the same angle, so after
 * a week the hand goes there without the eyes. That is why the order is the
 * rail's own, why nothing is sorted by recency, and why there is now exactly
 * ONE label on screen — the thing being aimed at, under the ring, where it can
 * be as long as it likes.
 *
 * ⚠️ **Eight captions around a circle is a collision waiting for a long
 * word.** "Start a pomodoro" at the eight o'clock position ran back over the
 * wedges and into the middle, and the fix is not a smaller font: the labels
 * were doing the work of a legend for a menu whose whole promise is that you
 * stop reading it.
 */
import { call, native, preview } from "./task-client";
import { taskIcon, type TaskIcon } from "./task-icons";
import { setClicks, tick } from "./click";
import { SCREENS } from "./screens";
import {
  INNER, MIDDLE, OUTER, SEARCH, aiming, at, ringStops, sector, spanOf,
} from "./ring-geometry";
import { listen } from "@tauri-apps/api/event";
import "./ring.css";

const NS = "http://www.w3.org/2000/svg";

interface Prefs {
  railOrder: string[];
  railHidden: string[];
  railColours: Record<string, string>;
  accent: string;
  ringGlass?: boolean;
  /** ⚠️ The same preference that silences a finished countdown, read here
   *  too. An app that is "silent" except for one window is an app whose mute
   *  does not work, and this window is the one somebody uses in a call. */
  timerSound?: string;
}

const host = document.getElementById("ring-host")!;

let prefs: Prefs = {
  railOrder: [], railHidden: [], railColours: {}, accent: "#00ff88", ringGlass: true,
};

/** The label under the ring, and the only text on it. */
let say: HTMLElement | null = null;

/** How much a wedge swells when it is aimed at.
 *
 * ⚠️ Scaled about the ring's OWN middle, not translated along its angle.
 * Both read as "this one", and the translate leaves a gap at the inner edge
 * and hangs the outer arc off the disc — a slice sliding out of a pie. Scaled
 * concentrically the wedge stays part of its ring and simply comes forward. */
const SWELL = 1.035;

function draw() {
  const stops = ringStops(prefs, SCREENS);
  host.replaceChildren();
  document.documentElement.style.setProperty("--accent", prefs.accent);
  host.dataset.style = prefs.ringGlass === false ? "solid" : "glass";

  /* The frosted disc, behind everything. ⚠️ An HTML element rather than a
   * filter on the SVG: `backdrop-filter` samples what is painted BEHIND the
   * element, and an SVG shape is not a backdrop root — the blur would sample
   * the page, which is transparent, and come out as nothing at all. */
  const glass = document.createElement("div");
  glass.className = "ring-glass";
  glass.style.width = `${OUTER * 2}px`;
  glass.style.height = `${OUTER * 2}px`;
  host.append(glass);

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${MIDDLE * 2} ${MIDDLE * 2}`);
  svg.setAttribute("class", "ring");

  stops.forEach((screen, index) => {
    const span = spanOf(index, stops.length);
    const middle = (span.from + span.to) / 2;
    const mark = at(middle, (INNER + OUTER) / 2);

    const wedge = document.createElementNS(NS, "path");
    wedge.setAttribute("d", sector(span.from, span.to));
    wedge.setAttribute("class", "ring-wedge");
    wedge.dataset.screen = screen.id;
    /* ⚠️ The origin in USER UNITS, like the glyph's below: a transform on an
     * SVG child is about the origin of the whole coordinate system unless it
     * is told otherwise, and a wedge that swells about the top-left corner
     * slides across the ring. */
    wedge.style.transformOrigin = `${MIDDLE}px ${MIDDLE}px`;
    wedge.style.setProperty("--swell", String(SWELL));
    const tint = prefs.railColours[screen.id];
    if (tint) wedge.style.setProperty("--stop", tint);
    svg.append(wedge);

    const glyph = taskIcon(screen.icon as TaskIcon);
    glyph.setAttribute("class", "ring-glyph");
    glyph.setAttribute("x", String(mark.x - 11));
    glyph.setAttribute("y", String(mark.y - 11));
    glyph.setAttribute("width", "22");
    glyph.setAttribute("height", "22");
    glyph.dataset.screen = screen.id;
    /* ⚠️ The origin has to be said in USER UNITS. A `scale` on an SVG child
     * is about the origin of the coordinate system — the top-left corner of
     * the whole ring — so an icon that grows by 8% also travels a tenth of the
     * way across the window, which is the "weird animation" this had: the
     * middle's glyph swam off towards the corner every time it lit up. */
    glyph.style.transformOrigin = `${mark.x}px ${mark.y}px`;
    if (tint) glyph.style.setProperty("--stop", tint);
    svg.append(glyph);
  });

  /* The middle is the palette. ⚠️ A ring holds eight things and the app has
   * more than eight; the way out of a menu that cannot list everything is the
   * one surface that can. */
  const heart = document.createElementNS(NS, "circle");
  heart.setAttribute("class", "ring-heart");
  heart.setAttribute("cx", String(MIDDLE));
  heart.setAttribute("cy", String(MIDDLE));
  heart.setAttribute("r", String(INNER - 8));
  heart.dataset.screen = SEARCH;
  svg.append(heart);

  /* ⚠️ A GLYPH, not the word "Search". Every wedge around it is an icon, so
   * the one piece of text in the middle read as a label for the ring rather
   * than as the thing you can aim at — and it is the one target nobody has to
   * read anyway, being the only one that is not a direction. */
  const mark = taskIcon("search");
  mark.setAttribute("class", "ring-heart-mark");
  mark.setAttribute("x", String(MIDDLE - 13));
  mark.setAttribute("y", String(MIDDLE - 13));
  mark.setAttribute("width", "26");
  mark.setAttribute("height", "26");
  mark.dataset.screen = SEARCH;
  mark.style.transformOrigin = `${MIDDLE}px ${MIDDLE}px`;
  svg.append(mark);

  host.append(svg);

  /* ── The one label ────────────────────────────────────────────────────
   * Under the ring, in the middle, saying whatever is aimed at. It is HTML
   * rather than SVG text so it can wrap, ellipsis and carry a background
   * without any of that being arithmetic. */
  say = document.createElement("div");
  say.className = "ring-caption";
  say.append(document.createElement("span"));
  say.style.top = `${MIDDLE + OUTER + 16}px`;
  host.append(say);
}

/** What the pointer is aiming at, as a screen name. */
function aimedAt(x: number, y: number): string | null {
  const stops = ringStops(prefs, SCREENS);
  const found = aiming(x, y, stops.length);
  if (found === null) return null;
  if (found === "search") return SEARCH;
  return stops[found]?.id ?? null;
}

/** What to call whatever is aimed at. */
function labelFor(id: string | null): string {
  if (!id) return "";
  if (id === SEARCH) return "Search everything";
  return ringStops(prefs, SCREENS).find(stop => stop.id === id)?.label ?? "";
}

let aimed: string | null = null;

function aim(next: string | null) {
  if (next === aimed) return;
  aimed = next;
  for (const part of host.querySelectorAll<SVGElement>("[data-screen]")) {
    part.classList.toggle("is-at", part.dataset.screen === next);
  }
  /* ⚠️ A tick per wedge CROSSED, with the dial's own floor on it. Sweeping
   * the pointer round the ring crosses eight of them in a quarter of a second,
   * and eight clicks in a quarter second is a buzz rather than detents — see
   * `click.ts`, which has had this argument already. */
  if (next) tick(1.2);
  const word = labelFor(next);
  if (!say) return;
  const slot = say.querySelector("span")!;
  if (slot.textContent === word) return;
  say.classList.toggle("is-on", !!word);
  /* The swap: out blurred and down, in blurred and up — transitions.dev's
   * text-states-swap, the same one the pill's module slot uses. */
  slot.classList.add("is-exit");
  window.setTimeout(() => {
    slot.textContent = word;
    slot.classList.remove("is-exit");
    slot.classList.add("is-enter");
    // The reflow is what makes the enter animate. See AGENTS.
    void slot.offsetWidth;
    slot.classList.remove("is-enter");
  }, 90);
}

host.addEventListener("pointermove", event => {
  const box = host.getBoundingClientRect();
  aim(aimedAt(event.clientX - box.left, event.clientY - box.top));
});

/* The press, for the hand. ⚠️ On the HOST, not on each wedge: the gesture is
 * "press somewhere in the ring", and eight listeners would each have to know
 * about the corners, which are part of the window and mean "put it away". */
host.addEventListener("pointerdown", () => host.classList.add("is-pressing"));
for (const event of ["pointerup", "pointercancel", "pointerleave"] as const) {
  host.addEventListener(event, () => host.classList.remove("is-pressing"));
}

/** Take what is aimed at, or put the ring away. One path for a click and for
 *  the key being let go, so the two can never mean different things. */
function take(picked: string | null) {
  /* ⚠️ Nothing aimed at CLOSES it. The window is a square holding a circle,
   * so the corners are part of it — and a menu that ignores a press aimed at
   * its own background is one you have to hunt for a way out of. The same is
   * true of letting the key go while pointing at nothing: the gesture was
   * abandoned, and abandoning it should cost nothing. */
  if (!picked) { void call("ring_close").catch(() => {}); return; }
  /* ⚠️ A lower, louder tick than the aim, and no floor on it: this is the
   * one sound in the gesture that says something HAPPENED, and swallowing it
   * because the pointer crossed a wedge forty milliseconds ago is the control
   * going quiet at the one moment it was answering. */
  tick(0.62, 0);
  host.classList.add("is-taken");
  void call("ring_pick", { screen: picked }).catch(() => {});
}

host.addEventListener("click", event => {
  const box = host.getBoundingClientRect();
  take(aimedAt(event.clientX - box.left, event.clientY - box.top));
});

async function boot() {
  try { prefs = await call<Prefs>("get_prefs"); } catch { /* the defaults stand */ }
  setClicks(prefs.timerSound !== "");
  draw();
  if (!native) return;
  /* Where the pointer is inside this window. ⚠️ Not assumed to be the middle:
   * the window is clamped to the monitor, so near an edge the pointer is
   * somewhere else entirely and the ring has to be drawn around IT. */
  await listen<[number, number]>("ring:at", event => {
    const [x, y] = event.payload;
    host.style.setProperty("--nudge-x", `${x - MIDDLE}px`);
    host.style.setProperty("--nudge-y", `${y - MIDDLE}px`);
    /* ⚠️ Every opening is a fresh one. The class survives in a window that is
     * hidden rather than destroyed, so without this the second ring of the
     * session arrives already mid-exit. */
    host.classList.remove("is-taken", "is-pressing");
    aim(null);
  });
  await listen<Prefs>("notch:prefs", event => {
    prefs = event.payload;
    setClicks(prefs.timerSound !== "");
    draw();
  });
  /* ⚠️ The key was HELD and let go: that is the pick. Press, flick the
   * wrist, let go — one gesture, no click, and the hand never leaves the
   * position it was already in. A tap leaves the ring up instead, which is
   * what somebody reading the labels for the first week is doing. */
  await listen("ring:commit", () => take(aimed));
}

if (preview) {
  // The browser preview has no shortcut to open it, so it is simply always up.
  document.body.classList.add("is-preview");
}
void boot();
