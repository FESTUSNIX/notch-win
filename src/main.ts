import { Spring } from "./motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { GLYPHS } from "./glyphs";
import { spoken } from "./media-format";
import {
  arcPath,
  DPX,
  band,
  bodyDepth,
  cardHeight,
  cardFontSize,
  cellPitch,
  cpx,
  Edge,
  fontSize,
  FRAME,
  gearPath,
  isVertical,
  notchPath,
  notchTransform,
  orbOverhang,
  padStart,
  px,
  restingTrim,
  ringCenter,
  shapeLength,
} from "./layout";

/* ------------------------------------------------------------------ model */

/** The shape Rust emits. Mirrors model.rs / UsageModel.swift. */
interface LimitWindow {
  id: string;
  label: string;
  used_fraction: number;
  resets_at: string;
}

interface Snapshot {
  id: string;
  displayName: string;
  glyph: string;
  fidelity: string;
  status: { state: string; message?: string; retry_after_secs?: number };
  windows: LimitWindow[];
  headlineId: string;
  readAtMs: number | null;
  stale: boolean;
}

type Activity = "working" | "waiting" | "idle";
interface ProviderActivity {
  provider: string;
  state: Activity;
}

/** A run that has just ended. Rust emits this once, on the tick it happens. */
interface Finished {
  provider: string;
  project: string;
  seconds: number;
  /** Whether the run ended waiting for you, or the session simply stopped. */
  waiting: boolean;
}

let snapshots: Snapshot[] = [];
let activity = new Map<string, Activity>();
/** The last run to finish, until it has been looked at. */
let finished: Finished | null = null;
/** Which way each window's reading last moved, so the card can animate it in
 *  the direction it went. Rebuilt when readings land, not when the card is
 *  re-rendered — a hover moving between cells must not replay the animation. */
let deltas = new Map<string, "up" | "down">();
let edge: Edge = "right";
let expanded = false;
/** Which cell the pointer is over, or -1. Drives the tooltip. */
let hoveredIndex = -1;

const stage = document.getElementById("stage") as HTMLDivElement;

/* -------------------------------------------------------------- utilities */

function headlineWindow(snapshot: Snapshot): LimitWindow | undefined {
  return (
    snapshot.windows.find((w) => w.id === snapshot.headlineId) ??
    snapshot.windows[0]
  );
}

/** Nothing read is not the same as nothing used, so a missing reading is a
 *  dash and no arc — never a zero, which would be a claim.
 *
 *  A *stale* reading is different again: it is a true figure that has stopped
 *  being refreshed. It keeps its number and its arc, and is dimmed instead. */
function headlineFraction(snapshot: Snapshot): number | null {
  const window = headlineWindow(snapshot);
  return window ? window.used_fraction : null;
}

/** "4 min ago", for a reading that is no longer current. */
function ageCopy(readAtMs: number | null): string {
  if (!readAtMs) return "not read yet";
  const minutes = Math.round((Date.now() - readAtMs) / 60000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

/** Why a figure has stopped moving, in the card's own voice. */
function staleReason(snapshot: Snapshot): string {
  const reason =
    {
      needsAuth: "Signed out",
      credentialExpired: "Token expired",
      rateLimited: "Rate limited",
    }[snapshot.status.state] ?? "Not reachable";

  // The age only means something when there is a figure to be aged. Without
  // one, "read not read yet" is worse than saying nothing.
  return snapshot.readAtMs
    ? `${reason} · read ${ageCopy(snapshot.readAtMs)}`
    : reason;
}

function svg(tag: string, attrs: Record<string, string | number>): string {
  const pairs = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<${tag} ${pairs} />`;
}

function escapeHTML(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

/* "Resets in 51 min" under an hour, "Resets Thu 12:00 AM" within the week,
   "Resets Sep 28" beyond it. A port of Sources/Model/ResetCopy.swift. */
function resetCopy(iso: string): string {
  const resets = new Date(iso);
  if (Number.isNaN(resets.getTime())) return "";
  const seconds = (resets.getTime() - Date.now()) / 1000;
  if (seconds <= 0) return "Resetting…";

  // Rounding, not truncation, so 50m40s reads as 51 rather than 50. A value
  // that rounds up to 60 falls through to the absolute form, so "Resets in
  // 60 min" never appears.
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Resets in ${Math.max(1, minutes)} min`;

  // A weekday only identifies a day inside the coming week. Codex's monthly
  // window resets 26 days out, and "Resets Mon 3:55 PM" reads as *this*
  // Monday — six days away rather than nearly four weeks.
  if (daysApart(new Date(), resets) >= 7) {
    // Day and month only, matching how the vendors write it. A time that far
    // out is noise: nobody plans around 3:55 PM in four weeks.
    return `Resets ${resets.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })}`;
  }

  const weekday = resets.toLocaleDateString(undefined, { weekday: "short" });
  const time = resets.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Resets ${weekday} ${time}`;
}

/** Whole days between two instants, counted by calendar day rather than by
 *  dividing seconds — so a clock change cannot shift the answer. */
function daysApart(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

/* ---------------------------------------------------------------- glyphs */

/** A traced outline scaled into a box, filled even-odd so the counters inside
 *  a knot stay open. `scale` is the optical correction: boxes of equal size are
 *  not marks of equal size, and the eye reads the mark. */
function glyphSVG(name: string, size: number, className: string): string {
  const glyph = GLYPHS[name] ?? GLYPHS[name === "gemini" ? "antigravity" : ""];
  if (!glyph) return "";
  const inset = (100 * (1 - glyph.scale)) / 2;
  return `<svg class="${className}" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">
    <g transform="translate(${inset.toFixed(2)} ${inset.toFixed(2)}) scale(${glyph.scale})">
      <path d="${glyph.d}" fill-rule="evenodd" />
    </g>
  </svg>`;
}

/* ------------------------------------------------------------------ rings */

/** The ring around a provider glyph: a grey track with a coloured arc that
 *  starts at 12 o'clock and sweeps clockwise by the fraction used.
 *
 *  Both circles sit on the same radius. SwiftUI's `strokeBorder` draws the
 *  track inside the frame, and the progress arc is inset by half the track — so
 *  the coloured line runs down the middle of the grey one. */
function ringSVG(snapshot: Snapshot): string {
  const D = FRAME.ringDiameter;
  const radius = (D - FRAME.trackStroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = headlineFraction(snapshot);
  const centre = D / 2;

  const track = svg("circle", {
    class: "ring__track",
    cx: centre,
    cy: centre,
    r: radius,
    "stroke-width": FRAME.trackStroke,
  });

  const sweep = fraction === null ? 0 : Math.min(Math.max(fraction, 0), 1);
  const arc =
    fraction === null
      ? ""
      : svg("circle", {
          class: `ring__progress is-${band(sweep)}`,
          cx: centre,
          cy: centre,
          r: radius,
          "stroke-width": FRAME.progressStroke,
          "stroke-dasharray": circumference.toFixed(3),
          "stroke-dashoffset": (circumference * (1 - sweep)).toFixed(3),
        });

  // The activity arc sits *inside* the ring, in the gap between the glyph and
  // the track: a different radius, a different weight and a neutral colour, so
  // it reads as a separate fact rather than as the usage number moving.
  const state = activity.get(snapshot.id) ?? "idle";
  const inner = (FRAME.activityDiameter - FRAME.activityStroke) / 2;
  const innerCircumference = 2 * Math.PI * inner;
  const activityArc =
    state === "idle"
      ? ""
      : `<circle class="ring__activity is-${state}" cx="${centre}" cy="${centre}" r="${inner}"
                 stroke-width="${FRAME.activityStroke}"
                 stroke-dasharray="${state === "working" ? `${(innerCircumference * 0.25).toFixed(2)} ${innerCircumference.toFixed(2)}` : innerCircumference.toFixed(2)}" />`;

  return `<svg class="ring" viewBox="0 0 ${D} ${D}" width="${px(D)}" height="${px(D)}" aria-hidden="true">
    ${track}${arc}${activityArc}
  </svg>`;
}

function cellHTML(snapshot: Snapshot, index: number): string {
  const fraction = headlineFraction(snapshot);
  const percent = fraction === null ? "—" : `${Math.round(fraction * 100)}%`;
  const spent = fraction !== null && band(fraction) === "exhausted";

  // Each cell trails the one above it, so the stack unfurls rather than
  // appearing all at once — NotchMotion.stagger.
  return `<div class="cell${snapshot.stale ? " is-stale" : ""}" data-index="${index}" style="--i:${index}">
    <div class="cell__ring">
      ${ringSVG(snapshot)}
      <div class="cell__glyph${spent ? " is-spent" : ""}">
        ${glyphSVG(snapshot.glyph, px(FRAME.glyphSize), "glyph")}
      </div>
    </div>
    <div class="cell__percent">${percent}</div>
  </div>`;
}

/** Which way each window moved between two rounds of readings.
 *
 * A limit only ever climbs until it resets, so "down" is the reset itself —
 * which is the one change worth announcing. The threshold keeps floating-point
 * noise from animating a figure that has not actually moved. */
function directionsFrom(
  before: Snapshot[],
  after: Snapshot[],
): Map<string, "up" | "down"> {
  const previous = new Map<string, number>();
  for (const snapshot of before) {
    for (const w of snapshot.windows) {
      previous.set(`${snapshot.id}:${w.id}`, w.used_fraction);
    }
  }

  const moved = new Map<string, "up" | "down">();
  for (const snapshot of after) {
    for (const w of snapshot.windows) {
      const key = `${snapshot.id}:${w.id}`;
      const was = previous.get(key);
      if (was === undefined) continue;
      if (w.used_fraction > was + 0.0005) moved.set(key, "up");
      else if (w.used_fraction < was - 0.0005) moved.set(key, "down");
    }
  }
  return moved;
}

/* ---------------------------------------------------------------- tooltip */

function barHTML(fraction: number): string {
  const track = FRAME.cardWidth - 2 * FRAME.cardPadding;
  const fill = Math.max(
    FRAME.barHeight,
    track * Math.min(Math.max(fraction, 0), 1),
  );
  return `<div class="bar">
    <div class="bar__fill is-${band(fraction)}" style="width:${cpx(fill)}px"></div>
  </div>`;
}

function tooltipHTML(snapshot: Snapshot): string {
  const rows = snapshot.windows
    .map(
      (w) => {
        const moved = deltas.get(`${snapshot.id}:${w.id}`);
        return `<div class="block">
        <div class="row">
          <span class="row__label">${escapeHTML(w.label)}</span>
          <span class="row__value">${escapeHTML(resetCopy(w.resets_at))}</span>
        </div>
        ${barHTML(w.used_fraction)}
        <div class="block__used${moved ? ` is-${moved}` : ""}">${Math.round(w.used_fraction * 100)}% Used</div>
      </div>`;
      },
    )
    .join("");

  // With no windows at all there is nothing to be stale *from*, so the reason
  // has to be stated here instead. "Waiting for the first reading" is only
  // true before anything has been attempted; after a refusal it is a worse
  // answer than the refusal itself.
  const body =
    snapshot.windows.length > 0
      ? rows
      : `<div class="block"><div class="row__value">${escapeHTML(
          snapshot.status.state === "pending"
            ? "Waiting for the first reading…"
            : (snapshot.status.message ?? staleReason(snapshot)),
        )}</div></div>`;

  // A stale figure explains itself before it is read, not after: the number
  // below is true but old, and that changes what it means.
  const note = snapshot.stale
    ? `<div class="card__stale">${escapeHTML(staleReason(snapshot))}</div>`
    : "";

  return `<div class="card__header">
      ${glyphSVG(snapshot.glyph, cpx(FRAME.glyphSize), "glyph")}
      <span class="card__title">${escapeHTML(snapshot.displayName)} Usage</span>
    </div>
    ${note}${body}`;
}

/* ------------------------------------------------------------- the shape */

/* Folding open and shut. SwiftUI's spring(response:dampingFraction:),
   integrated here rather than approximated with a bezier: the notch, the
   contents and the tooltip all have to move like one object, and a cubic
   cannot be made to settle the way the others do. */

const fold = new Spring(0, 0.42, 0.78);
/** The orb's two states. Its own spring, quicker and slightly looser than the
 *  fold — it is a small control answering a pointer, not a panel opening. */
const orbHover = new Spring(0, 0.36, 0.7);

/** Collapsed and expanded geometry in design-frame pixels, per edge. */
function geometry(cellCount: number) {
  const vertical = isVertical(edge);
  return {
    collapsed: {
      depth: FRAME.pillThin,
      length: FRAME.pillLong,
    },
    expanded: {
      depth: bodyDepth(edge),
      length: shapeLength(cellCount, edge),
    },
    vertical,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

let lastFrame = 0;
let running = false;

function tick(now: number) {
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0.016;
  lastFrame = now;
  fold.step(dt);
  orbHover.step(dt);
  paintShape();

  if (!fold.settled || !orbHover.settled) {
    requestAnimationFrame(tick);
  } else {
    running = false;
    lastFrame = 0;
    reportRects();
  }
}

function startAnimating() {
  if (running) return;
  running = true;
  lastFrame = 0;
  requestAnimationFrame(tick);
}

const shapePath = document.getElementById("notch-path") as unknown as SVGPathElement;
const shapeSVG = document.getElementById("notch-svg") as unknown as SVGSVGElement;
const shapeGroup = document.getElementById("notch-group") as unknown as SVGGElement;
const orbSVG = document.getElementById("orb-svg") as unknown as SVGSVGElement;
const orbArc = document.getElementById("orb-arc") as unknown as SVGPathElement;
const orbDisc = document.getElementById("orb-disc") as unknown as SVGCircleElement;
const orbGear = document.getElementById("orb-gear") as unknown as SVGPathElement;

/** The orb's centre, in shape coordinates — kept from the last paint so the
 *  hover test does not have to re-derive the geometry. */
let orbCentre = { x: 0, y: 0 };

/** The window's own size, in design-frame pixels — the expanded shape plus the
 *  room the tooltip needs beside it. Fixed for a given cell count, so nothing
 *  resizes the OS window mid-fold. */
function windowFrame(cellCount: number) {
  const vertical = isVertical(edge);
  // Two scales meet here, so both sides are converted before they are added.
  // Room for the orb goes at *both* ends rather than the one it hangs off, so
  // the shape stays centred in the window and the placement maths is unchanged.
  const notch = px(shapeLength(cellCount, edge) + 2 * orbOverhang);
  // The card can be taller than a short stack of rings — one provider with
  // three windows against a single cell — and a card clipped by its own window
  // is the kind of thing that only shows up on somebody else's account.
  const card = cpx(cardHeight(4) + 2 * FRAME.cardPadding);
  const along = Math.max(notch, card);
  const across =
    px(bodyDepth(edge)) +
    cpx(FRAME.tailGap + FRAME.tailLength + FRAME.cardWidth);
  return vertical
    ? { width: across, height: along }
    : { width: along, height: across };
}

function paintShape() {
  const cells = snapshots.length;
  const { collapsed, expanded: open } = geometry(cells);
  const t = fold.value;

  const depth = lerp(collapsed.depth, open.depth, t);
  const length = lerp(collapsed.length, open.length, t);
  // The flare grows with the fold: a 10pt pill has no room for a 103pt curl,
  // and clampCorners would eat the corner to make space for it.
  const flare = lerp(FRAME.pillThin / 2, FRAME.curlRadius, t);

  const vertical = isVertical(edge);
  const w = vertical ? depth : length;
  const h = vertical ? length : depth;

  const viewBox = `0 0 ${w.toFixed(2)} ${h.toFixed(2)}`;
  for (const element of [shapeSVG, orbSVG]) {
    element.setAttribute("viewBox", viewBox);
  }
  // One box for the shape, the orb and the stack, so an arc drawn in shape
  // coordinates lands where the shape actually is.
  const root = document.documentElement.style;
  root.setProperty("--shape-w", `${px(w)}px`);
  root.setProperty("--shape-h", `${px(h)}px`);

  shapeGroup.setAttribute("transform", notchTransform(edge, depth));
  shapePath.setAttribute("d", notchPath(depth, length, flare));

  // The stack rides inside the shape, pinned to the same start pad the ring
  // centres are measured from.
  const rings = document.getElementById("rings") as HTMLDivElement;
  const lead = flare + padStart(edge);
  rings.style.setProperty("--lead", `${px(lead)}px`);

  // The orb hangs off the far flare, concentric with it.
  const along = length;
  const orbCentreAcross = depth - flare;
  const [from, to] = restingTrim(edge);
  const radius = Math.max(1, flare - FRAME.orbGap);
  const cx = vertical ? orbCentreAcross : along;
  const cy = vertical ? along : orbCentreAcross;
  orbCentre = { x: cx, y: cy };

  // Revealed with the fold, then the two states crossfade on their own spring.
  const reveal = Math.max(0, (t - 0.5) / 0.5);
  const gear = orbHover.value;

  orbArc.setAttribute("d", arcPath(cx, cy, radius, from, to));
  orbArc.setAttribute("stroke-width", `${FRAME.orbStroke}`);
  orbArc.style.opacity = `${reveal * (1 - gear)}`;
  orbArc.setAttribute(
    "transform",
    `translate(${cx} ${cy}) scale(${lerp(1, 0.86, gear)}) translate(${-cx} ${-cy})`,
  );

  orbDisc.setAttribute("cx", `${cx}`);
  orbDisc.setAttribute("cy", `${cy}`);
  orbDisc.setAttribute("r", `${FRAME.orbDiameter / 2}`);
  orbDisc.style.opacity = `${reveal * gear}`;
  orbDisc.setAttribute(
    "transform",
    `translate(${cx} ${cy}) scale(${lerp(1.1, 1, gear)}) translate(${-cx} ${-cy})`,
  );

  const g = FRAME.orbGlyph / 2;
  orbGear.setAttribute("d", gearPath(cx, cy, g, g * 0.72, g * 0.3));
  orbGear.style.opacity = `${reveal * gear}`;
  // Turns as it arrives, so it reads as a control settling into place rather
  // than a picture being faded in.
  orbGear.setAttribute(
    "transform",
    `translate(${cx} ${cy}) rotate(${lerp(-60, 0, gear)}) scale(${lerp(0.5, 1, gear)}) translate(${-cx} ${-cy})`,
  );
}

/* ---------------------------------------------------------------- render */

function render() {
  stage.dataset.edge = edge;
  paintPip();

  const ringHost = document.getElementById("rings") as HTMLDivElement;
  ringHost.innerHTML = snapshots.map(cellHTML).join("");

  const root = document.documentElement.style;
  root.setProperty("--cell-pitch", `${px(cellPitch(edge))}px`);
  root.setProperty("--cell-gap", `${px(FRAME.cellSpacing)}px`);

  const frame = windowFrame(snapshots.length);
  invoke("set_notch_size", {
    width: Math.ceil(frame.width),
    height: Math.ceil(frame.height),
  }).catch(() => {});

  renderTooltip();
  paintShape();
  reportRects();
}

function renderTooltip() {
  const card = document.getElementById("tooltip") as HTMLDivElement;
  const snapshot = snapshots[hoveredIndex];

  if (!expanded || dragging || !snapshot) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  const body = card.querySelector(".card__body") as HTMLDivElement;
  body.innerHTML = tooltipHTML(snapshot);

  const height = cardHeight(snapshot.windows.length);
  card.style.setProperty("--card-h", `${cpx(height)}px`);

  // The tail's point is aimed at the hovered cell, so the card is placed by
  // that cell's ring centre rather than by its own middle.
  //
  // ⚠️ Measured from the shape's own box, not from the window's top. The window
  // carries orb overhang at both ends, so the shape no longer starts where the
  // window does — reading the ring centre as a window offset put the card a
  // whole overhang out, pointing its tail at nothing.
  const box = shapeSVG.getBoundingClientRect();
  const along = px(ringCenter(hoveredIndex, edge));
  card.style.setProperty(
    "--aim",
    isVertical(edge) ? `${box.top + along}px` : `${box.left + along}px`,
  );
}

/* The window is transparent and mostly a hole; it may only take the pointer
   over chrome that is actually painted. Rust polls the cursor against these. */
/** The orb's centre in window coordinates, from the shape box it is drawn in. */
function orbCentreInWindow(): { x: number; y: number } {
  const box = shapeSVG.getBoundingClientRect();
  return {
    x: box.left + px(orbCentre.x),
    y: box.top + px(orbCentre.y),
  };
}

function reportRects() {
  const rects: { x: number; y: number; width: number; height: number }[] = [];
  const shapeBox = shapeSVG.getBoundingClientRect();
  const pad = px(FRAME.pillHotZone) / 2;
  rects.push({
    x: shapeBox.left - pad,
    y: shapeBox.top - pad,
    width: shapeBox.width + pad * 2,
    height: shapeBox.height + pad * 2,
  });

  // The orb reaches past the shape's own box, so it needs its own rect or the
  // window is a hole exactly where the control is. Generous, like the pill's —
  // it is a small target on a screen edge.
  if (expanded) {
    const centre = orbCentreInWindow();
    const reach = px(FRAME.orbHotZone) / 2;
    rects.push({
      x: centre.x - reach,
      y: centre.y - reach,
      width: reach * 2,
      height: reach * 2,
    });
  }

  const card = document.getElementById("tooltip") as HTMLDivElement;
  if (!card.hidden) {
    const cardBox = card.getBoundingClientRect();
    rects.push({
      x: cardBox.left,
      y: cardBox.top,
      width: cardBox.width,
      height: cardBox.height,
    });
  }

  invoke("set_interactive_rects", { rects }).catch(() => {});
}

/* ------------------------------------------------------------------- pip */

/** What the collapsed pill says.
 *
 *  Three states and no more: the shape is 83 x 10 CSS pixels and there is room
 *  for one fact. `done` outranks `working` on purpose — a second session
 *  starting does not un-finish the first one, and the finish is the news. */
function paintPip() {
  const pip = document.getElementById("pip");
  if (!pip) return;
  const states = [...activity.values()];
  /* ⚠️ Waiting outranks working, and `done` outranks both. With one session
   * thinking and another blocked on you, the one that needs you is the news —
   * the other will carry on by itself. */
  const waiting = states.includes("waiting");
  const working = states.includes("working");
  const state = finished ? "done" : waiting ? "waiting" : working ? "working" : "idle";
  if (pip.dataset.state !== state) pip.dataset.state = state;
  pip.title = finished
    ? `${finished.project} ${finished.waiting ? "needs you" : "stopped"} after ${spoken(finished.seconds)}`
    : waiting
      ? "Waiting for you"
      : working
        ? "Working"
        : "";
}

/* ----------------------------------------------------------------- hover */

/** Folding shut waits; opening does not. Unfolding is a bigger movement than
 *  a tooltip, and doing it the instant the pointer strays reads as twitchy. */
const FOLD_GRACE_MS = 450;
let foldTimer: number | undefined;
let orbHovered = false;
/** A drag in progress. The card stays down for its duration. */
let dragging = false;

/** Which cell the pointer is over, from its position in the window. The stack
 *  is evenly pitched, so this is the same sum ringCenter walks. */
function cellAt(alongCSS: number): number {
  if (!expanded || snapshots.length === 0) return -1;

  // ⚠️ Window coordinates, not shape coordinates. The window carries orb
  // overhang at both ends, so the shape starts one overhang in — and treating
  // the pointer's window offset as a shape offset biases every cell's hit zone
  // by exactly that much (31px here). The ring still resolved, because the
  // zone is ±117 design px wide, so it read as a hitbox sitting too high
  // rather than as one that missed. Same correction as the tooltip's aim.
  const box = shapeSVG.getBoundingClientRect();
  const origin = isVertical(edge) ? box.top : box.left;
  const along = (alongCSS - origin) / DPX;
  const first = ringCenter(0, edge);
  const pitch = cellPitch(edge);
  const index = Math.round((along - first) / pitch);
  if (index < 0 || index >= snapshots.length) return -1;
  // Only within the cell's own extent, not the spacing either side of it.
  const centre = ringCenter(index, edge);
  return Math.abs(along - centre) <= FRAME.ringDiameter ? index : -1;
}


function onHover(hover: boolean, x: number, y: number) {
  window.clearTimeout(foldTimer);

  const apply = () => {
    const changed = expanded !== hover;
    expanded = hover;
    // Opening the notch *is* the acknowledgement. There is no dismiss control
    // on a 10px pill, and asking for one would mean a second gesture to clear
    // something you have already read.
    if (hover && finished) {
      finished = null;
      paintPip();
    }
    stage.dataset.state = hover ? "expanded" : "collapsed";
    fold.setTarget(hover ? 1 : 0);
    if (!hover) hoveredIndex = -1;
    if (changed) startAnimating();
    renderTooltip();
    reportRects();
  };

  if (hover) {
    apply();

    // The orb takes the pointer before the stack does: it overlaps the last
    // cell's hot zone, and a card appearing while you reach for settings is
    // the wrong answer to the same gesture.
    const centre = orbCentreInWindow();
    const reach = px(FRAME.orbHotZone) / 2;
    const onOrb =
      Math.abs(x - centre.x) <= reach && Math.abs(y - centre.y) <= reach;
    if (onOrb !== orbHovered) {
      orbHovered = onOrb;
      orbHover.setTarget(onOrb ? 1 : 0);
      startAnimating();
    }

    const along = isVertical(edge) ? y : x;
    const next = onOrb ? -1 : cellAt(along);
    if (next !== hoveredIndex) {
      hoveredIndex = next;
      renderTooltip();
      reportRects();
    }
  } else {
    if (orbHovered) {
      orbHovered = false;
      orbHover.setTarget(0);
      startAnimating();
    }
    foldTimer = window.setTimeout(apply, FOLD_GRACE_MS);
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  // Hidden together with the island, and animated the same way — the class
  // drives a transform on #stage, which nothing else writes to.
  await listen<boolean>("chrome:hidden", event => {
    document.documentElement.classList.toggle("chrome-hidden", event.payload);
  });

  stage.dataset.state = "collapsed";
  fold.snap(0);

  const root = document.documentElement.style;
  root.setProperty("--font-percent", `${fontSize(FRAME.capPercent)}px`);
  root.setProperty("--percent-line", `${px(FRAME.percentLine)}px`);
  root.setProperty("--ring-label-gap", `${px(FRAME.ringLabelGap)}px`);
  root.setProperty("--body-depth", `${px(bodyDepth(edge))}px`);

  // The card, at its own anchor.
  root.setProperty("--font-card-title", `${cardFontSize(FRAME.capCardTitle)}px`);
  root.setProperty("--font-card-body", `${cardFontSize(FRAME.capCardBody)}px`);
  // ⚠️ The line boxes are set from the frame, not left to `line-height: normal`.
  // The frame's vertical rhythm is quoted in whole line boxes, and cardHeight()
  // adds them up to size the card; letting the font decide instead makes every
  // gap drift by whatever Segoe UI's default leading happens to be, and leaves
  // the card taller than its contents by the accumulated difference.
  root.setProperty("--card-title-line", `${cpx(FRAME.cardTitleLine)}px`);
  root.setProperty("--card-body-line", `${cpx(FRAME.cardBodyLine)}px`);
  root.setProperty("--card-w", `${cpx(FRAME.cardWidth)}px`);
  root.setProperty("--card-corner", `${cpx(FRAME.cardCorner)}px`);
  root.setProperty("--card-pad", `${cpx(FRAME.cardPadding)}px`);
  root.setProperty("--card-glyph", `${cpx(FRAME.glyphSize)}px`);
  root.setProperty("--tail-l", `${cpx(FRAME.tailLength)}px`);
  root.setProperty("--tail-h", `${cpx(FRAME.tailHeight)}px`);
  root.setProperty("--tail-gap", `${cpx(FRAME.tailGap)}px`);
  root.setProperty("--bar-h", `${cpx(FRAME.barHeight)}px`);
  root.setProperty("--header-gap", `${cpx(FRAME.headerGap)}px`);
  root.setProperty("--header-to-block", `${cpx(FRAME.headerToBlock)}px`);
  root.setProperty("--label-to-bar", `${cpx(FRAME.labelToBar)}px`);
  root.setProperty("--bar-to-used", `${cpx(FRAME.barToUsed)}px`);
  root.setProperty("--block-gap", `${cpx(FRAME.blockSpacing)}px`);

  // Nothing is known until the first poll answers.
  snapshots = [
    {
      id: "claude",
      displayName: "Claude",
      glyph: "claude",
      fidelity: "official",
      status: { state: "pending" },
      windows: [],
      headlineId: "session",
      readAtMs: null,
      stale: false,
    },
  ];
  render();

  await listen<Snapshot[]>("notch:readings", (event) => {
    deltas = directionsFrom(snapshots, event.payload);
    snapshots = event.payload;
    render();
  });

  // The settings panel can move the notch to another edge while it runs.
  await listen<Edge>("notch:edge", (event) => {
    edge = event.payload;
    render();
  });

  await listen<ProviderActivity[]>("notch:activity", (event) => {
    activity = new Map(event.payload.map((a) => [a.provider, a.state]));
    render();
  });

  await listen<Finished>("notch:finished", (event) => {
    finished = event.payload;
    paintPip();
  });

  // The first poll answers before this listener exists, so the event alone
  // would leave the notch on its placeholder until the next tick a minute
  // later. Ask once for whatever has already been read.
  const known = await invoke<Snapshot[]>("get_readings").catch(() => []);
  if (known.length > 0) {
    snapshots = known;
    render();
  }
  const running = await invoke<ProviderActivity[]>("get_activity").catch(() => []);
  if (running.length > 0) {
    activity = new Map(running.map((a) => [a.provider, a.state]));
    render();
  }

  await listen<{ hover: boolean; x: number; y: number }>(
    "notch:hover",
    (event) => onHover(event.payload.hover, event.payload.x, event.payload.y),
  );

  window.addEventListener("resize", reportRects);
  installDragGesture();
}

/* The notch can be dragged along its edge to reposition it.
 *
 * The gesture is recognised here but *performed* in Rust: once the window
 * itself starts moving, the WebView's own mousemove stops being reliable, so
 * the backend follows the system cursor instead. 4px of slop separates a drag
 * from a click. */
function installDragGesture() {
  let press: { x: number; y: number } | null = null;

  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    press = { x: event.clientX, y: event.clientY };
  });

  document.addEventListener("mousemove", (event) => {
    if (!press || dragging) return;
    const moved =
      Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y);
    if (moved <= 4) return;
    dragging = true;
    // The card must not ride along: it is anchored to a cell, and a card
    // gliding beside a window being dragged reads as two things coming apart.
    window.clearTimeout(foldTimer);
    renderTooltip();
    invoke("drag_begin").catch(() => {
      dragging = false;
    });
  });

  document.addEventListener("mouseup", () => {
    // A press that never became a drag, over the orb, is a click on the gear.
    if (press && !dragging && orbHovered) {
      invoke("open_settings").catch(() => {});
    }
    press = null;
  });

  listen("notch:drag_end", () => {
    dragging = false;
    press = null;
    renderTooltip();
    reportRects();
  }).catch(() => {});
}

boot();
