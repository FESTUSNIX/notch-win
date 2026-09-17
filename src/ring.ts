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
 * rail's own, why nothing is sorted by recency, and why the labels are drawn
 * quietly — they are for the first week, not for the hundredth time.
 */
import { call, native, preview } from "./task-client";
import { taskIcon } from "./task-icons";
import { SCREENS } from "./screens";
import {
  CAPTION, INNER, MIDDLE, OUTER, SEARCH, aiming, at, ringStops, sector, spanOf,
} from "./ring-geometry";
import { listen } from "@tauri-apps/api/event";
import "./ring.css";

const NS = "http://www.w3.org/2000/svg";

interface Prefs {
  railOrder: string[];
  railHidden: string[];
  railColours: Record<string, string>;
  accent: string;
}

const host = document.getElementById("ring-host")!;

let prefs: Prefs = { railOrder: [], railHidden: [], railColours: {}, accent: "#00ff88" };

function draw() {
  const stops = ringStops(prefs, SCREENS);
  host.replaceChildren();
  document.documentElement.style.setProperty("--accent", prefs.accent);

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 ${0} ${MIDDLE * 2} ${MIDDLE * 2}`);
  svg.setAttribute("class", "ring");

  stops.forEach((screen, index) => {
    const span = spanOf(index, stops.length);
    const wedge = document.createElementNS(NS, "path");
    wedge.setAttribute("d", sector(span.from, span.to));
    wedge.setAttribute("class", "ring-wedge");
    wedge.dataset.screen = screen.name;
    const tint = prefs.railColours[screen.name];
    if (tint) wedge.style.setProperty("--stop", tint);
    svg.append(wedge);

    const middle = (span.from + span.to) / 2;
    const mark = at(middle, (INNER + OUTER) / 2);
    const glyph = taskIcon(screen.icon);
    glyph.setAttribute("class", "ring-glyph");
    glyph.setAttribute("x", String(mark.x - 11));
    glyph.setAttribute("y", String(mark.y - 11));
    glyph.setAttribute("width", "22");
    glyph.setAttribute("height", "22");
    glyph.dataset.screen = screen.name;
    /* ⚠️ The glyph is a SIBLING of its wedge, not a child, so the custom
     * property has to be set on it too — it cannot inherit from a shape it is
     * merely drawn on top of. */
    if (tint) glyph.style.setProperty("--stop", tint);
    svg.append(glyph);

    const where = at(middle, CAPTION);
    const caption = document.createElementNS(NS, "text");
    caption.setAttribute("class", "ring-say");
    caption.setAttribute("x", String(where.x));
    caption.setAttribute("y", String(where.y));
    caption.setAttribute("text-anchor", "middle");
    caption.setAttribute("dominant-baseline", "middle");
    caption.dataset.screen = screen.name;
    caption.textContent = screen.label;
    svg.append(caption);
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

  const word = document.createElementNS(NS, "text");
  word.setAttribute("class", "ring-heart-say");
  word.setAttribute("x", String(MIDDLE));
  word.setAttribute("y", String(MIDDLE));
  word.setAttribute("text-anchor", "middle");
  word.setAttribute("dominant-baseline", "middle");
  word.dataset.screen = SEARCH;
  word.textContent = "Search";
  svg.append(word);

  host.append(svg);
}

/** What the pointer is aiming at, as a screen name. */
function aimedAt(x: number, y: number): string | null {
  const stops = ringStops(prefs, SCREENS);
  const found = aiming(x, y, stops.length);
  if (found === null) return null;
  if (found === "search") return SEARCH;
  return stops[found]?.name ?? null;
}

let aimed: string | null = null;

function aim(next: string | null) {
  if (next === aimed) return;
  aimed = next;
  for (const part of host.querySelectorAll<SVGElement>("[data-screen]")) {
    part.classList.toggle("is-at", part.dataset.screen === next);
  }
}

host.addEventListener("pointermove", event => {
  const box = host.getBoundingClientRect();
  aim(aimedAt(event.clientX - box.left, event.clientY - box.top));
});

host.addEventListener("click", event => {
  const box = host.getBoundingClientRect();
  const picked = aimedAt(event.clientX - box.left, event.clientY - box.top);
  /* ⚠️ A click on nothing CLOSES it. The window is a square holding a circle,
   * so the corners are part of it — and a menu that ignores a click aimed at
   * its own background is one you have to hunt for a way out of. */
  if (!picked) { void call("ring_close").catch(() => {}); return; }
  if (picked === SEARCH) {
    void call("ring_pick", { screen: SEARCH }).catch(() => {});
    return;
  }
  void call("ring_pick", { screen: picked }).catch(() => {});
});

async function boot() {
  try { prefs = await call<Prefs>("get_prefs"); } catch { /* the defaults stand */ }
  draw();
  if (!native) return;
  /* Where the pointer is inside this window. ⚠️ Not assumed to be the middle:
   * the window is clamped to the monitor, so near an edge the pointer is
   * somewhere else entirely and the ring has to be drawn around IT. */
  await listen<[number, number]>("ring:at", event => {
    const [x, y] = event.payload;
    host.style.setProperty("--nudge-x", `${x - MIDDLE}px`);
    host.style.setProperty("--nudge-y", `${y - MIDDLE}px`);
    aim(null);
  });
  await listen<Prefs>("notch:prefs", event => { prefs = event.payload; draw(); });
}

if (preview) {
  // The browser preview has no shortcut to open it, so it is simply always up.
  document.body.classList.add("is-preview");
}
void boot();
