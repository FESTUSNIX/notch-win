/* What the collapsed island says.
 *
 * The pill is one glyph and one line. So the screens do not each get a slot —
 * they compete for the single one, and the winner is whatever is most *live*:
 * a meeting about to start beats a running timer, which beats something
 * playing, which beats the resting state.
 *
 * Each screen returns its own claim and the shell picks the highest. A screen
 * with nothing to say returns null rather than a placeholder, so the pill can
 * never show "—" while something real is happening one screen over.
 */
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { setDigits, setText } from "./tween";
import type { ModuleReading } from "./pill-modules";

export type ScreenName =
  | "home" | "today" | "agents" | "shelf"
  | "calendar" | "system" | "review"
  /** ⚠️ Real, but its tab is only on screen while something is playing — see
   *  `paintMediaTab`. Everything that walks `ScreenName` has to cope with a tab
   *  that is not there. */
  | "media"
  | "notes";

/** What the resting pill shows: the date, the time, and at most one module. */
export interface Resting {
  /** `14` and `SEP` — see `buildClock` on why the numeral leads. */
  day: string;
  month: string;
  time: string;
  module: ModuleReading | null;
}

export interface Activity {
  /** Higher wins. The scale is documented at each call site, not here, so the
   *  reasons live next to the thing being ranked. */
  priority: number;
  /** Which screen the claim belongs to, for the tab dot. */
  screen: ScreenName;
  kind: "media" | "focus" | "event" | "day" | "clock";
  label: string;
  value: string;
  icon?: TaskIcon;
  artwork?: string;
  playing?: boolean;
  /** 0..1, drawn as a ring. */
  progress?: number;
  accent?: string;
}

export function pick(claims: (Activity | null)[]): Activity | null {
  let best: Activity | null = null;
  for (const claim of claims) {
    if (claim && (!best || claim.priority > best.priority)) best = claim;
  }
  return best;
}

const NS = "http://www.w3.org/2000/svg";
/** 2πr for r=13. Explicit: `pathLength` does not normalise on nodes built with
 *  createElementNS — it draws a dotted line instead. See AGENTS.md. */
const RING = 81.68;

function ring(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("class", "pill-ring");
  svg.setAttribute("aria-hidden", "true");
  for (const cls of ["trk", "arc"]) {
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("class", cls);
    circle.setAttribute("cx", "16");
    circle.setAttribute("cy", "16");
    circle.setAttribute("r", "13");
    if (cls === "arc") circle.setAttribute("stroke-dasharray", String(RING));
    svg.append(circle);
  }
  return svg;
}

/** Bars that only move while something is actually playing — and, in click
 *  mode, the play/pause control they turn into under the pointer.
 *
 * ⚠️ A real `<button>`, always. It is only *reachable* in click mode — with
 * hover opening, the pointer arriving here has already turned the pill into a
 * panel, so there is nothing to press — but building two different elements for
 * the two modes would mean the pill's markup changed when a preference did.
 * CSS decides whether it looks like a control; `pointer-events` decides whether
 * it is one. */
function equaliser(): HTMLElement {
  const wrap = element("button", "pill-eq");
  (wrap as HTMLButtonElement).type = "button";
  wrap.setAttribute("aria-label", "Play or pause");
  for (let i = 0; i < 3; i++) wrap.append(element("i"));
  wrap.append(element("span", "pill-eq-mark"));
  return wrap;
}

/* ── At rest: three slots ─────────────────────────────────────────────────
 *
 * `[ 14 ]   14:53   [ module ]`, where the module is whatever `pill-modules`
 * decided is worth the space this second.
 *
 * The date is the numeral over the month, not "Mon, Sep 14" on one line: the
 * number is what you are actually looking for, and stacked it costs a third of
 * the width the sentence did. The month is what stops a lone `14` reading as a
 * count of something.
 *
 * ⚠️ The grid is `1fr auto 1fr` so the **time stays dead centre** whatever the
 * two sides weigh. With `auto auto auto` the clock slides left and right as the
 * module changes from "22°" to "3 tasks left", which is a clock that cannot be
 * glanced at — the eye has to find it first. The sides are allowed to be
 * different widths; the middle is not allowed to move.
 */
function buildClock(host: HTMLElement) {
  host.replaceChildren();
  const date = element("div", "pill-date");
  date.append(element("span", "pill-date-day"), element("span", "pill-date-month"));
  const module = element("div", "pill-module");
  module.append(
    element("div", "pill-module-mark"),
    element("div", "pill-module-copy t-text-swap"),
  );
  host.append(date, element("div", "pill-clock t-digit-group"), module);
  host.dataset.kind = "clock";
}

/** Swap what the module slot says, through a blurred up-and-down.
 *
 * transitions.dev's text-states-swap. ⚠️ Only when the *subject* changes: a
 * countdown ticking from "in 2h 10m" to "in 2h 09m" is the same module saying
 * the same thing more precisely, and animating that is a slot that never holds
 * still. The id is what tells the two apart. */
function paintModule(slot: HTMLElement, reading: ModuleReading | null) {
  const copy = slot.querySelector<HTMLElement>(".pill-module-copy")!;
  const mark = slot.querySelector<HTMLElement>(".pill-module-mark")!;
  const same = slot.dataset.module === (reading?.id ?? "");

  const write = () => {
    slot.dataset.module = reading?.id ?? "";
    slot.dataset.tone = reading?.tone ?? "";
    copy.replaceChildren();
    if (!reading) {
      mark.replaceChildren();
      delete mark.dataset.icon;
      return;
    }
    paintIcon(mark, reading.icon);
    copy.append(element("span", "pill-module-text", reading.text));
  };

  if (same) {
    // Same subject: update the words in place, and let `setText` bump them.
    if (!reading) return;
    paintIcon(mark, reading.icon);
    const text = copy.querySelector<HTMLElement>(".pill-module-text");
    if (text) {
      setText(text, reading.text);
      slot.dataset.tone = reading.tone ?? "";
      return;
    }
    write();
    return;
  }

  // A new subject rises in as the old one leaves. The exit runs on the node
  // that is going, which is why the write waits for it rather than racing it.
  const leaving = slot.dataset.module !== undefined && slot.dataset.module !== "";
  if (!leaving) {
    write();
    return;
  }
  copy.classList.add("is-exit");
  window.setTimeout(() => {
    write();
    copy.classList.remove("is-exit");
    copy.classList.add("is-enter-start");
    // ⚠️ The reflow is what makes the enter animate. Without it the browser
    // never computes the offset state and the new text simply appears.
    void copy.offsetWidth;
    copy.classList.remove("is-enter-start");
  }, 150);
}

function build(host: HTMLElement, activity: Activity) {
  host.replaceChildren();
  const lead = element("div", "pill-lead");
  if (activity.kind === "media" && activity.artwork) {
    const image = element("img", "pill-art") as HTMLImageElement;
    image.alt = "";
    lead.append(image);
  } else if (activity.progress !== undefined) {
    lead.append(ring());
  } else if (activity.icon) {
    paintIcon(lead, activity.icon);
  } else {
    paintIcon(lead, "media");
  }
  const copy = element("div", "pill-copy");
  copy.append(element("span", "pill-label"), element("span", "pill-value"));
  host.append(lead, copy);
  if (activity.kind === "media") host.append(equaliser());
  host.dataset.kind = activity.kind;
}

/** Draw the claim, reusing the nodes whenever the shape has not changed.
 *
 * ⚠️ Not `replaceChildren` every time. The pill updates once a second, and
 * rebuilding it means the text can never animate — there is no old node left to
 * animate away from — and any hover or focus inside it is thrown away on every
 * tick. A rebuild only happens when the *kind* of claim changes. */
/** Draw the resting pill. Separate from `renderActivity` because at rest the
 *  pill is not one claim with blanks in it — it is three independent slots. */
export function renderResting(host: HTMLElement, resting: Resting) {
  if (host.dataset.kind !== "clock") buildClock(host);
  host.classList.add("is-clock");
  setDigits(host.querySelector<HTMLElement>(".pill-clock")!, resting.time);
  setText(host.querySelector<HTMLElement>(".pill-date-day")!, resting.day);
  setText(host.querySelector<HTMLElement>(".pill-date-month")!, resting.month);
  paintModule(host.querySelector<HTMLElement>(".pill-module")!, resting.module);
}

export function renderActivity(host: HTMLElement, activity: Activity | null) {
  if (!activity) {
    if (host.dataset.kind !== "empty") {
      host.replaceChildren(element("span", "pill-label muted", "Codenotch"));
      host.dataset.kind = "empty";
    }
    return;
  }
  host.classList.remove("is-clock");
  if (host.dataset.kind !== activity.kind) build(host, activity);

  const label = host.querySelector<HTMLElement>(".pill-label");
  const value = host.querySelector<HTMLElement>(".pill-value");
  if (label) setText(label, activity.label);
  if (value) setText(value, activity.value);

  // The icon is repainted every time, not only on a rebuild. Two claims can
  // share a `kind` and carry different icons — System and Calendar both raise
  // an "event" — and without this the pill keeps whichever one it built with.
  // paintIcon is a no-op when the name has not changed.
  const lead = host.querySelector<HTMLElement>(".pill-lead");
  if (lead && activity.icon && !activity.artwork && activity.progress === undefined) {
    paintIcon(lead, activity.icon);
  }

  const art = host.querySelector<HTMLImageElement>(".pill-art");
  if (art && art.src !== activity.artwork) art.src = activity.artwork || "";

  const arc = host.querySelector<SVGCircleElement>(".pill-ring .arc");
  if (arc) {
    const fraction = Math.max(0, Math.min(1, activity.progress ?? 0));
    arc.setAttribute("stroke-dashoffset", String(RING * (1 - fraction)));
    arc.setAttribute("stroke", activity.accent || "var(--accent)");
  }
  const eq = host.querySelector<HTMLElement>(".pill-eq");
  if (eq) {
    eq.classList.toggle("on", !!activity.playing);
    /* The glyph says what the press WILL do, not what is happening — the bars
     * beside it already say that, and a pause icon over moving bars read as a
     * label for them rather than as a button. */
    const mark = eq.querySelector<HTMLElement>(".pill-eq-mark");
    if (mark) paintIcon(mark, activity.playing ? "pause" : "play");
  }
}
