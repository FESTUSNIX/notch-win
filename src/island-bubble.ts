/* The countdown, beside the notch rather than on it.
 *
 * ⚠️ **A plain timer does not take the strip any more.** It raised a claim
 * like everything else, so for the twenty minutes it ran the notch said
 * "Timer" and a countdown — and the date, the clock and whatever module had
 * the third slot were gone. That is the whole strip spent on a number you
 * asked for yourself and can see the end of. A POMODORO still claims it,
 * because a pomodoro has a name and a phase and those are the things you look
 * down to be reminded of; a timer has neither.
 *
 * ⚠️ **A sibling of the island, like the arcs and the rail**, and for the same
 * reason: `#island` is `overflow: clip` with a clip path on it, so anything
 * inside it that reaches past the shape is simply erased. It is placed from
 * the island's own measured geometry every frame, and it is reported as its
 * own interactive rect — the window is click-through everywhere outside those,
 * so a circle drawn beside the island and left out of them would be visible
 * and unpressable, which is the exact failure the arcs already documented.
 *
 * ⚠️ **It is reachable in HOVER mode**, unlike the strip's own controls. That
 * is not an accident of the markup, it is the point: a control on the pill
 * cannot be pressed while pointing at the pill opens the panel over it, and
 * this one is outside the island, so nothing opens on the way to it.
 */
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { FRAME, cpx, isVertical, type Edge } from "./layout";

const NS = "http://www.w3.org/2000/svg";
/** 2πr for r=17. ⚠️ Explicit: `pathLength` does not normalise on nodes built
 *  with `createElementNS` — it draws a dotted line instead. See AGENTS.md. */
const RING = 106.81;

export interface BubbleReading {
  /** 0..1 of the countdown that has gone, drawn as the ring. */
  through: number;
  /** What the middle says at rest — whole minutes, or the seconds in the last
   *  one. There is room for two characters and no more. */
  text: string;
  /** The last minute, which is tinted so "45" cannot be read as 45 minutes. */
  final: boolean;
  /** Paused, so the control offers to start it again. */
  held: boolean;
  /** For the tooltip and for anything asking what this window is showing. */
  label: string;
}

export interface BubbleFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  edge: Edge;
  /** 0 collapsed, 1 open. The bubble belongs to the collapsed pill. */
  fold: number;
  /** The island is away, or a search has taken its place. */
  gone: boolean;
}

export class IslandBubble {
  readonly element = element("div", "island-bubble");
  /** Whether it is on screen, so the surface knows to report its rect. */
  hidden = true;

  private opener = element("button", "bub-open") as HTMLButtonElement;
  private act = element("button", "bub-act") as HTMLButtonElement;
  private mid = element("span", "bub-mid");
  private arc: SVGCircleElement;
  private reading: BubbleReading | null = null;
  private drawn = "";

  constructor(onOpen: () => void, onToggle: () => void) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.setAttribute("class", "bub-ring");
    svg.setAttribute("aria-hidden", "true");
    for (const cls of ["trk", "arc"]) {
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("class", cls);
      circle.setAttribute("cx", "20");
      circle.setAttribute("cy", "20");
      circle.setAttribute("r", "17");
      if (cls === "arc") circle.setAttribute("stroke-dasharray", String(RING));
      svg.append(circle);
    }
    this.arc = svg.querySelector<SVGCircleElement>(".arc")!;

    this.opener.type = "button";
    this.opener.append(svg, this.mid);
    this.act.type = "button";
    this.element.append(this.opener, this.act);
    this.element.hidden = true;

    this.opener.addEventListener("click", () => onOpen());
    /* ⚠️ Stopped. The middle button sits ON the one that opens the screen, so
     * without this a press does both — and the only way to pause would be to
     * accept the panel opening over whatever you were looking at. */
    this.act.addEventListener("click", event => {
      event.stopPropagation();
      onToggle();
    });
  }

  /** ⚠️ On the SHELL, beside the island rather than inside it. */
  mount(host: HTMLElement) {
    host.append(this.element);
  }

  setReading(reading: BubbleReading | null) {
    this.reading = reading;
    if (!reading) return;
    /* Written in place and only when something changed: this is repainted
     * every second, and an element rebuilt every second can never be hovered,
     * focused or animated. Same rule the pill and the header chips follow. */
    const key = [reading.text, reading.final, reading.held,
      Math.round(reading.through * 400)].join("|");
    if (key === this.drawn) return;
    this.drawn = key;
    this.mid.textContent = reading.text;
    this.element.classList.toggle("is-final", reading.final);
    this.element.classList.toggle("is-held", reading.held);
    const fraction = Math.max(0, Math.min(1, reading.through));
    this.arc.setAttribute("stroke-dashoffset", String(RING * (1 - fraction)));
    /* The glyph says what the press WILL do, not what is happening — the same
     * rule the player's equaliser follows, for the same reason. */
    const does = reading.held ? "Resume" : "Pause";
    paintIcon(this.act, reading.held ? "play" : "pause");
    this.act.setAttribute("aria-label", does);
    this.act.setAttribute("data-tip", does);
    this.opener.setAttribute("aria-label", reading.label);
    this.opener.setAttribute("data-tip", reading.label);
  }

  paint(frame: BubbleFrame) {
    const show = !!this.reading && !frame.gone && frame.fold < 0.5;
    this.hidden = !show;
    this.element.hidden = !show;
    if (!show) return;

    /* The notch's own depth, so the circle stands as tall as the thing it is
     * parked beside — which is what makes it read as part of the same object
     * rather than as a bubble that happens to be near one. */
    const size = cpx(FRAME.islandPillThin);
    const gap = cpx(FRAME.tailGap);
    const vertical = isVertical(frame.edge);
    let left: number;
    let top: number;
    if (vertical) {
      top = frame.y + frame.height + gap;
      left = frame.edge === "left" ? frame.x : frame.x + frame.width - size;
    } else {
      left = frame.x + frame.width + gap;
      /* ⚠️ Pinned to the BEZEL end of the island, not centred on its box. The
       * box grows as the panel opens, and a bubble centred on it slides down
       * the side of the panel while it fades — a control that drifts while it
       * goes is one the eye follows instead of ignoring. */
      top = frame.edge === "top" ? frame.y : frame.y + frame.height - size;
    }
    Object.assign(this.element.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${size}px`,
      height: `${size}px`,
      // The same curve the collapsed layer fades on, so the two leave together.
      opacity: String(Math.max(0, 1 - frame.fold / 0.38)),
    });
  }
}
