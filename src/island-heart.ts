/* Gabi's heart, beside the notch (4 Nov, his call: "next to the notch in a circle
 * which is its own floating thing", as the countdown is). What's left when a note
 * of hers folded without an answer: pressing or pointing at it opens the note again.
 *
 * ⚠️ On the OTHER side from the countdown, so the two can be up together. Same
 * reasons as island-bubble.ts otherwise: a sibling of the island (which clips what
 * reaches past its shape), placed from its measured geometry every frame, and
 * reported as a passive rect, or it's visible and unpressable.
 */
import { element } from "./dom";
import { paintIcon } from "./task-icons";
import { FRAME, cpx, isVertical } from "./layout";
import type { BubbleFrame } from "./island-bubble";

/** Pointing at it counts after this, so a pointer passing by opens nothing. */
const HOVER_MS = 180;

export class IslandHeart {
  readonly element = element("button", "island-heart") as HTMLButtonElement;
  hidden = true;
  private badge = element("em", "heart-count");
  private count = 0;
  private hoverTimer = 0;

  constructor(onOpen: () => void) {
    this.element.type = "button";
    this.element.hidden = true;
    const icon = element("span", "heart-icon");
    paintIcon(icon, "heart");
    this.element.append(icon, this.badge);
    this.badge.hidden = true;
    this.element.addEventListener("click", () => { window.clearTimeout(this.hoverTimer); onOpen(); });
    this.element.addEventListener("pointerenter", () => { this.hoverTimer = window.setTimeout(onOpen, HOVER_MS); });
    this.element.addEventListener("pointerleave", () => window.clearTimeout(this.hoverTimer));
  }

  mount(host: HTMLElement) { host.append(this.element); }

  setCount(count: number) {
    if (count === this.count) return;
    this.count = count;
    this.badge.hidden = count < 2;
    this.badge.textContent = String(count);
    const label = count === 1 ? "Gabi: nieodpowiedziana wiadomość" : `Gabi: ${count} nieodpowiedziane`;
    this.element.setAttribute("aria-label", label);
    this.element.dataset.tip = label;
  }

  paint(frame: BubbleFrame) {
    const show = this.count > 0 && !frame.gone && frame.fold < 0.5;
    this.hidden = !show;
    this.element.hidden = !show;
    if (!show) return;
    const size = Math.round(cpx(FRAME.islandPillThin) * 0.82);
    const gap = 7;
    /* The countdown's sum, mirrored: set in from the START of the box by the
     * flare, so the gap is from the shape and not the empty corner. */
    let left: number;
    let top: number;
    if (isVertical(frame.edge)) {
      top = frame.y + frame.curl - gap - size;
      left = frame.edge === "left" ? frame.x + frame.width - size : frame.x;
    } else {
      left = frame.x + frame.curl - gap - size;
      top = frame.edge === "top" ? frame.y + frame.height - size : frame.y;
    }
    Object.assign(this.element.style, {
      left: `${left}px`, top: `${top}px`, width: `${size}px`, height: `${size}px`,
      opacity: String(Math.max(0, 1 - frame.fold / 0.38)),
    });
  }
}
