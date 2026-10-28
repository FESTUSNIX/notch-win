/* The cockpit's small parts, shared by Today, the Agents screen and the
 * Guardian so a project looks the same wherever it appears.
 *
 * ⚠️ One builder each, never a copy per screen. A logo drawn three ways is
 * three projects to the eye (AGENTS on the run ring: "a second copy of a
 * drawing drifts the moment it exists").
 */
import { element } from "./dom";
import { paintIcon, type TaskIcon } from "./task-icons";
import { hueOf, monogram, spoken, type ChipTone, type NotchProject, type Suggestion } from "./helm-link";

/** Who a tile is for: a Helm project when there is one, else what the queue
 *  knows — the context's name and its hue. */
export interface Face {
  name: string;
  hue?: string | null;
  /** A data URL, once fetched. */
  logo?: string | null;
  /** A glyph instead of letters — the small things, his own to-dos. */
  icon?: TaskIcon;
}

export function faceOf(project: NotchProject | null, logo: string | null, fallback: { name: string; hue?: string | null } | null): Face | null {
  if (project) return { name: project.name, hue: project.hue, logo };
  return fallback?.name ? { name: fallback.name, hue: fallback.hue } : null;
}

/** A project's tile: its logo, else its letters on its own hue.
 *
 * ⚠️ The SLOT is always the same size, logo or not (AGENTS 725): rows where
 * some projects have a logo and some do not must not indent differently. And
 * the picture and the letters are separate children (AGENTS 419), so a logo
 * that fails to decode falls back without a broken-image glyph. */
export function logoTile(face: Face | null, size: "sm" | "md" | "lg" = "sm"): HTMLElement {
  const tile = element("span", `hp-logo is-${size}`);
  tile.setAttribute("aria-hidden", "true");
  if (!face) {
    tile.classList.add("is-blank");
    return tile;
  }
  tile.style.setProperty("--hue", face.icon ? "var(--iris)" : hueOf(face.hue, face.name));
  if (face.logo) {
    const img = element("img", "hp-logo-img") as HTMLImageElement;
    img.alt = "";
    img.src = face.logo;
    img.onerror = () => { img.remove(); tile.classList.remove("has-logo"); tile.append(letters(face)); };
    tile.classList.add("has-logo");
    tile.append(img);
  } else if (face.icon) {
    const glyph = element("span", "hp-logo-glyph");
    paintIcon(glyph, face.icon);
    tile.append(glyph);
  } else {
    tile.append(letters(face));
  }
  return tile;
}

function letters(face: Face): HTMLElement {
  return element("span", "hp-logo-letters", monogram(face.name));
}

/** A status chip: late, due today, your move, waiting. Colour WITH a word —
 *  never colour alone (DESIGN: status colours always pair with a label). */
export function chip(tone: ChipTone, label: string): HTMLElement {
  return element("span", `helm-chip is-${tone}`, label);
}

/** Claude Code's mark, small, in its own colour: an agent is on this. */
export function agentMark(tip: string): HTMLElement {
  const mark = element("span", "hp-agent");
  paintIcon(mark, "claude");
  mark.dataset.tip = tip;
  mark.setAttribute("aria-label", tip);
  return mark;
}

const NS = "http://www.w3.org/2000/svg";
/** 2πr for r = 15. ⚠️ Explicit, never `pathLength` — on nodes built with
 *  `createElementNS` it draws a dotted line (AGENTS, the Day Card #5). */
export const RING = 94.25;

/** The time spent against the estimate, as a ring. */
export function timeRing(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("class", "hp-ring");
  svg.setAttribute("aria-hidden", "true");
  for (const part of ["trk", "arc"]) {
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("class", part);
    circle.setAttribute("cx", "18");
    circle.setAttribute("cy", "18");
    circle.setAttribute("r", "15");
    if (part === "arc") {
      circle.setAttribute("stroke-dasharray", String(RING));
      circle.setAttribute("stroke-dashoffset", String(RING));
    }
    svg.append(circle);
  }
  return svg;
}

/** Fill a ring built by `timeRing`. */
export function setRing(svg: SVGSVGElement, fraction: number) {
  const arc = svg.querySelector(".arc");
  arc?.setAttribute("stroke-dashoffset", String(RING * (1 - Math.max(0, Math.min(1, fraction)))));
}

/** An icon button with its name in the tooltip. */
export function iconButton(icon: TaskIcon, label: string, className: string, run: () => void): HTMLButtonElement {
  const button = element("button", className) as HTMLButtonElement;
  button.type = "button";
  paintIcon(button, icon);
  button.setAttribute("aria-label", label);
  button.dataset.tip = label;
  button.onclick = event => { event.stopPropagation(); run(); };
  return button;
}

/** A labelled button: an icon and a word. */
export function wordButton(icon: TaskIcon | null, label: string, className: string, run: () => void): HTMLButtonElement {
  const button = element("button", className) as HTMLButtonElement;
  button.type = "button";
  if (icon) {
    const mark = element("span", "hp-btn-mark");
    paintIcon(mark, icon);
    button.append(mark);
  }
  button.append(element("span", "hp-btn-word", label));
  button.onclick = event => { event.stopPropagation(); run(); };
  return button;
}

/** One step of the minutes stepper: five under an hour, a quarter above it —
 *  so 1 h 30 to 45 min is three presses, not nine. */
export function step(minutes: number, direction: 1 | -1): number {
  const by = (direction > 0 ? minutes >= 60 : minutes > 60) ? 15 : 5;
  const next = direction > 0 ? Math.floor(minutes / by) * by + by : Math.ceil(minutes / by) * by - by;
  return Math.max(5, Math.min(12 * 60, next));
}

export interface LogHooks {
  minutes: number;
  busy: boolean;
  setMinutes: (minutes: number) => void;
  log: () => void;
  skip?: () => void;
  /** The words, where the surface speaks Polish — the Guardian's thread does,
   *  and an English "Log" in the middle of its Polish reply reads as a seam. */
  words?: { log: string; skip: string; uncapped: string; uncappedTip: string };
}

const ENGLISH = { log: "Log", skip: "Skip", uncapped: "uncapped", uncappedTip: "The agents ran past the estimate; Helm didn't cap it" };

/** What Done on a request answers, and the way to log it: the minutes (which
 *  can be changed), what they are made of, and Log.
 *
 * ⚠️ Figures with marks, not a sentence. "1 h 10 agent + 20 min you · est. 2 h"
 * is the same three numbers as Claude's mark, the person and the estimate
 * beside theirs — and the marks are read before the words would be. */
export function logControl(suggestion: Suggestion | null, hooks: LogHooks): HTMLElement {
  const box = element("div", "hp-log");
  const head = element("div", "hp-log-head");
  const stepper = element("div", "hp-stepper");
  const less = iconButton("minus", "Less", "hp-step", () => hooks.setMinutes(step(hooks.minutes, -1)));
  const more = iconButton("plus", "More", "hp-step", () => hooks.setMinutes(step(hooks.minutes, 1)));
  less.disabled = hooks.busy || hooks.minutes <= 5;
  more.disabled = hooks.busy;
  const value = element("output", "hp-log-value", spoken(hooks.minutes));
  value.setAttribute("aria-label", `Log ${spoken(hooks.minutes)}`);
  stepper.append(less, value, more);
  head.append(stepper);
  const words = hooks.words ?? ENGLISH;
  if (suggestion && !suggestion.capped) {
    const over = chip("late", words.uncapped);
    over.classList.replace("is-late", "is-uncapped");
    over.dataset.tip = words.uncappedTip;
    head.append(over);
  }
  box.append(head);

  if (suggestion) {
    const parts = element("div", "hp-log-parts");
    const part = (icon: TaskIcon, minutes: number, tip: string, cls: string) => {
      const one = element("span", `hp-part ${cls}`);
      const mark = element("span", "hp-part-mark");
      paintIcon(mark, icon);
      one.append(mark, element("span", "hp-part-value", spoken(minutes)));
      one.dataset.tip = tip;
      return one;
    };
    if (suggestion.agent) parts.append(part("claude", suggestion.agent, "The agents' time", "is-agent"));
    if (suggestion.you) parts.append(part("you", suggestion.you, "Your time", "is-you"));
    if (suggestion.estimate) parts.append(part("target", suggestion.estimate, "The estimate", "is-est"));
    if (parts.childElementCount) box.append(parts);
  }

  const acts = element("div", "hp-log-acts");
  const log = wordButton("check", `${words.log} ${spoken(hooks.minutes)}`, "hp-btn is-primary hp-log-go", hooks.log);
  log.disabled = hooks.busy;
  acts.append(log);
  if (hooks.skip) {
    const skip = wordButton(null, words.skip, "hp-btn is-ghost hp-log-skip", hooks.skip);
    skip.disabled = hooks.busy;
    acts.append(skip);
  }
  box.append(acts);
  return box;
}
