/* The circle a run is drawn as, built once and painted every tick.
 *
 * ⚠️ ONE builder for the timer screen and the three board widgets. The screen
 * had its own and the widgets had a simpler one, and the two drifted
 * immediately: the widget's ring was a plain arc for every kind, so a pomodoro
 * on a board looked like a timer while the same pomodoro on the screen was
 * eight segments. The ring is the one thing that says which kind you are
 * looking at — see the note in `screen-timer.ts` — so it cannot be drawn twice.
 *
 * ⚠️ The CLASSES are the screen's (`tm-seg`, `tm-arc`, `tm-seg-back`) and the
 * stroke rules in tasks.css are written on those names alone rather than under
 * `.tm-ring`, which is what lets a widget reuse them by giving its own wrapper
 * the positioning. Only the wrapper class differs between the two callers.
 */
import { cycle, type Lengths } from "./timer";
import { through, type Run } from "./runs";

const NS = "http://www.w3.org/2000/svg";

/** The geometry both callers draw at. ⚠️ A 100-unit box whatever the element's
 *  real size is, so a 58px widget ring and a 200px screen ring are the same
 *  picture at two scales and the stroke thins with it. */
const R = 44;
const ROUND = 2 * Math.PI * R;

/** ⚠️ Wide enough to SEE. At 2.4 units out of a 276-unit circumference the gaps
 *  were under a percent each and the eight arcs read as one continuous ring —
 *  which is the timer's look, not the pomodoro's, and the segments are the only
 *  thing that tells the two apart. */
const GAP = 9;

/** The parts a tick writes to. ⚠️ Separate from `Ring` so a caller that kept
 *  only the circles — the screen holds them on `this.face` and rebuilds the
 *  element around them — can repaint without inventing an element to satisfy a
 *  type. */
export interface RingParts {
  arc: SVGCircleElement | null;
  segs: SVGCircleElement[];
}

export interface Ring extends RingParts {
  el: SVGSVGElement;
}

function circle(cls: string, extra: Record<string, string> = {}): SVGCircleElement {
  const one = document.createElementNS(NS, "circle") as SVGCircleElement;
  for (const [key, value] of Object.entries({
    cx: "50", cy: "50", r: String(R), class: cls, ...extra,
  })) one.setAttribute(key, value);
  return one;
}

/** The circle for a run of this kind. Segmented for a pomodoro, whole for the
 *  other two — see the note at the top of `screen-timer.ts`. */
export function buildRing(run: Run, lengths: Lengths): Ring {
  const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");
  const segs: SVGCircleElement[] = [];
  let arc: SVGCircleElement | null = null;

  if (run.kind === "pomodoro") {
    /* ⚠️ One arc per LEG of the cycle — work, break, work, break — because
     * what a pomodoro is is a shape you move along, and the gaps are what say
     * where one leg ends. `cycle()` is the same list the collapsed pill draws
     * its track from, so the two can never disagree about where you are. */
    const legs = cycle(lengths, run.count);
    const each = ROUND / legs.length;
    legs.forEach((leg, at) => {
      svg.append(circle("tm-seg-back", {
        "stroke-dasharray": `${each - GAP} ${ROUND - each + GAP}`,
        "stroke-dashoffset": String(-at * each),
      }));
      const fill = circle(
        `tm-seg${leg.phase === "rest" || leg.phase === "long" ? " is-rest" : ""}`,
        { "stroke-dashoffset": String(-at * each) },
      );
      fill.dataset.each = String(each - GAP);
      fill.dataset.rest = String(ROUND - each + GAP);
      svg.append(fill);
      segs.push(fill);
    });
  } else {
    svg.append(circle("tm-seg-back"));
    /* ⚠️ `pathLength` does NOT normalise a dash array on a circle built with
     * `createElementNS` — it draws a dotted line instead. The real
     * circumference, spelled out. Same note as the pill's ring. */
    arc = circle("tm-arc", { "stroke-dasharray": String(ROUND) });
    svg.append(arc);
  }
  return { el: svg, arc, segs };
}

/** Move the ring to where the run actually is. Called every tick. */
export function paintRing(ring: RingParts, run: Run, lengths: Lengths, live: boolean) {
  if (ring.arc) {
    /* ⚠️ A stopwatch draws the WHOLE circle. It has no target, so there is no
     * fraction of it to be part-way through — and an arc creeping round would
     * be claiming a finish line it does not have. */
    const share = run.kind === "stopwatch" ? 1 : through(run, lengths);
    ring.arc.setAttribute("stroke-dashoffset", String(ROUND * (1 - share)));
    ring.arc.classList.toggle("is-idle", !live);
  }
  if (!ring.segs.length) return;
  const legs = cycle(lengths, run.count);
  ring.segs.forEach((seg, at) => {
    const leg = legs[at];
    const each = Number(seg.dataset.each ?? 0);
    const rest = Number(seg.dataset.rest ?? 0);
    /* A leg behind you is full, the one you are on is part-way, the rest are
     * empty. ⚠️ Drawn by shortening the DASH rather than by opacity: a
     * half-finished leg has to look half finished, not half transparent. */
    const share = leg?.state === "done" ? 1
      : leg?.state === "now" ? through(run, lengths) : 0;
    seg.setAttribute("stroke-dasharray", `${each * share} ${ROUND - each * share + rest}`);
    /* ⚠️ A zero-length dash with a ROUND cap draws a DOT, not nothing — so an
     * untouched pomodoro came up as eight bright beads around a grey circle.
     * The cap is what makes a part-filled leg look drawn rather than cut, so
     * the fix is to stop painting the empty ones rather than to square the
     * ends. */
    seg.classList.toggle("is-empty", share <= 0);
    seg.classList.toggle("is-now", leg?.state === "now");
  });
}
