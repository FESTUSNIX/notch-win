/* Tooltips that keep up with the pointer.
 *
 * ⚠️ The native `title` is the thing this replaces, and it is wrong in three
 * separate ways on a surface like this one. It waits about a second before it
 * appears, which is longer than most of the glances this island exists for; it
 * is drawn by the OS in the OS's own colours, on a window that is otherwise
 * entirely painted by us; and on a `WS_EX_NOACTIVATE` window it is not reliably
 * drawn at all.
 *
 * The behaviour it should have instead is the one every good tooltip has and
 * almost none explain:
 *
 *  - a WAIT before the first one, so brushing past a row of buttons on the way
 *    somewhere else does not light up four of them;
 *  - and NO wait between them once one is up, so moving along that row reads as
 *    one label changing rather than four appearing and disappearing;
 *  - and a short grace on the way out, so crossing a one-pixel gap between two
 *    buttons is not "left, waited, arrived".
 *
 * ⚠️ One element for the whole app, moved and refilled. A tooltip per control
 * is a tooltip that animates in from nothing every time it moves, which is the
 * thing being avoided — and nine of them on the rail is nine nodes that exist
 * to be empty.
 */
import { element } from "./dom";

/** How long the pointer has to rest before the FIRST tip.
 *
 * ⚠️ Long enough to be a DECISION. At 380 it appeared while the pointer was
 * still travelling across the panel, so crossing the island lit up whatever
 * happened to be on the way — which reads as the surface being twitchy rather
 * than helpful. */
const WAIT = 650;
/** How long the row stays "warm" after one closes, during which the next is
 *  immediate. Long enough to cross a gap, short enough that coming back to the
 *  same row a moment later still feels deliberate. */
const WARM = 700;
/** Grace on the way out, so a gap between two controls is not an exit. */
const LEAVE = 90;

const GAP = 9;

let tip: HTMLElement | null = null;
let showing: HTMLElement | null = null;
let armed = 0;
let leaving = 0;
let warmUntil = 0;

function node(): HTMLElement {
  if (tip) return tip;
  tip = element("div", "tip");
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("aria-hidden", "true");
  document.body.append(tip);
  return tip;
}

/** What this element wants to say, if anything.
 *
 * ⚠️ `data-tip` ONLY. It fell back to `aria-label` at first, on the reasoning
 * that most controls here already carry the same sentence for a screen reader
 * and asking twice is how the two drift apart — and the result was a tooltip on
 * every single thing on the surface, because everything that can be pressed is
 * labelled for a reason that has nothing to do with wanting a tooltip. A
 * tooltip on everything is a tooltip nobody reads. Saying it twice is the
 * price of saying it only where it helps. */
function labelOf(el: Element): string {
  return el.getAttribute("data-tip") ?? "";
}

/** Whether this control already says what it is.
 *
 * ⚠️ A tooltip on something that is already captioned is the caption again,
 * a beat later, in a box — and with two dozen of them on the surface that is
 * most of what you see while the pointer crosses the panel. So the rule is
 * automatic rather than a list somebody maintains: if the thing shows its own
 * text, it does not get a tip.
 *
 * It falls out exactly right on the rail, where the same control is captioned
 * in the middle and an icon everywhere else: the one you are on stays quiet,
 * its neighbours explain themselves. */
function speaks(el: HTMLElement): boolean {
  /* ⚠️ The text's own BOX, not `innerText`. A caption clipped to nothing —
   * `max-width: 0; overflow: hidden`, which is how the rail hides every name
   * but the middle one — is still in `innerText`, so the obvious one-liner
   * decides that all nine stops are captioned and none of them ever gets a
   * tip. A `Range` measures what is actually on screen. */
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (!node.textContent?.trim()) continue;
    /* ⚠️ The text's PARENT box, not a `Range` over the text. A range measures
     * the text's own layout and ignores an ancestor clipping it — so a caption
     * held at `max-width: 0` still measures 32 by 16, and the check decides
     * every rail stop is captioned. The element holding it measures zero,
     * which is the thing actually on screen. */
    const box = node.parentElement?.getBoundingClientRect();
    if (box && box.width > 2 && box.height > 2) return true;
  }
  return false;
}

function target(from: EventTarget | null): HTMLElement | null {
  const el = from instanceof Element ? from.closest<HTMLElement>("[data-tip]") : null;
  if (!el || !labelOf(el) || speaks(el)) return null;
  return el;
}

/** Put it beside the control, inside the window.
 *
 * ⚠️ Flipped rather than clamped when it will not fit above. Clamped, it lands
 * ON the control it is describing, and a label covering the thing it labels is
 * worse than one on the other side. */
function place(over: HTMLElement) {
  const box = over.getBoundingClientRect();
  const self = node().getBoundingClientRect();
  const above = box.top - self.height - GAP;
  const below = box.bottom + GAP;
  const top = above >= 4 ? above : below;
  let left = box.left + box.width / 2 - self.width / 2;
  left = Math.max(6, Math.min(window.innerWidth - self.width - 6, left));
  node().style.translate = `${Math.round(left)}px ${Math.round(top)}px`;
  node().dataset.side = above >= 4 ? "above" : "below";
}

function reveal(over: HTMLElement) {
  const el = node();
  const said = labelOf(over);
  if (!said) return hide();
  /* ⚠️ The text is swapped and the box is re-placed WITHOUT re-running the
   * entrance. Moving along a row of controls is one label changing, not four
   * tooltips appearing — re-entering on each would be the flicker this is
   * meant to replace. */
  const moving = showing !== null;
  el.textContent = said;
  showing = over;
  el.classList.toggle("is-moving", moving);
  el.classList.add("is-on");
  place(over);
}

function hide() {
  showing = null;
  node().classList.remove("is-on", "is-moving");
  warmUntil = performance.now() + WARM;
}

function onOver(event: PointerEvent) {
  const over = target(event.target);
  clearTimeout(leaving);
  if (!over) {
    /* ⚠️ Delayed, not immediate. Two controls a pixel apart send a leave and an
     * enter in that order, and hiding on the leave makes every crossing a
     * blink. */
    if (showing) leaving = window.setTimeout(hide, LEAVE);
    return;
  }
  if (showing === over) return;
  clearTimeout(armed);
  /* Warm, or already showing something: change now. Cold: wait. */
  if (showing || performance.now() < warmUntil) reveal(over);
  else armed = window.setTimeout(() => reveal(over), WAIT);
}

function away() {
  clearTimeout(armed);
  clearTimeout(leaving);
  hide();
}

/** Start answering the pointer. Safe to call more than once. */
export function tips() {
  if ((window as unknown as {__tips?: boolean}).__tips) return;
  (window as unknown as {__tips?: boolean}).__tips = true;
  /* ⚠️ On the document, and `pointerover` rather than `pointerenter`. The
   * controls are rebuilt constantly — the rail on every screen change, the arcs
   * on every render — so anything bound per element is bound to a node that is
   * about to be replaced. */
  document.addEventListener("pointerover", onOver, true);
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") away();
  }, true);
  /* Leaving the window entirely, and the island folding under the pointer,
   * both end it. */
  document.documentElement.addEventListener("pointerleave", away);
  window.addEventListener("blur", away);
}

/** Take it down now — the island is folding, or a screen is changing under it. */
export function dropTip() { away(); }
