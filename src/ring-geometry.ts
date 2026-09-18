/* Where the ring's segments are, and which one a pointer is aiming at.
 *
 * ⚠️ Split from `ring.ts` so `node --test` can import it: that file touches
 * the document on the first line, and this is the half that is arithmetic.
 * Same reason `media-format.ts` sits beside `screen-media.ts`.
 */
import type { ScreenDef } from "./screens";

/* ⚠️ A TYPE import and nothing else, so this file has no runtime imports at
 * all — which is what lets `node --test` load it. The screens are passed IN
 * rather than reached for: node's resolver does not do extensionless
 * specifiers the way vite does, and a geometry that has to be handed its list
 * is easier to test besides. */

/** In CSS pixels, against a 420-square window. */
export const MIDDLE = 210;
export const INNER = 62;
export const OUTER = 132;
/** How far past the ring an aim still counts.
 *
 * ⚠️ This used to be where the labels were drawn, and it kept the name for
 * a while after they went — there is now ONE label, under the ring, because
 * eight captions on a circle collide the moment one of them is longer than a
 * word. What the margin is FOR now is the hand: a flick that overshoots the
 * edge should still take the wedge it was plainly aimed at. */
export const REACH = OUTER + 21;

/** Past here, the gesture is abandoned rather than aimed.
 *
 * ⚠️ Generous, because a radial menu is aimed at by DIRECTION and a hand that
 * throws the pointer at a wedge routinely overshoots the ring entirely — and
 * a menu that drops what you are plainly pointing at the moment you move
 * decisively is a menu that punishes moving decisively. Out here only the
 * angle matters, which is how every marking menu worth using behaves; the
 * corners of the window are still far enough out to mean "no". */
export const CANCEL = 250;

/** How far into the next wedge the pointer has to go before it is the next
 *  wedge, as a fraction of one.
 *
 * ⚠️ Without this, a pointer resting on a boundary flickers between two stops
 * — and a boundary is exactly where a pointer that has just travelled fast
 * comes to rest. A fifth of a wedge is about nine degrees of eight, which is
 * far enough to be deliberate and near enough not to be felt. */
const STICK = 0.2;
/** Where to draw the ring, given where the pointer landed inside the window.
 *
 * @param value the pointer's offset inside the window, in PHYSICAL pixels.
 * @param ratio `devicePixelRatio`.
 *
 * ⚠️ The offset is the difference of two SCREEN coordinates, so it is in
 * physical pixels, and everything drawn here is in CSS ones. They are the same
 * number only at 100% scaling: at 150% the ring came out a hundred pixels down
 * and to the right of the pointer it is supposed to surround.
 *
 * ⚠️ Clamped, so an offset that is wrong for any reason at all cannot push
 * the ring out of its own window. Slightly off centre is a cosmetic fault;
 * off the edge is a menu that is invisible when pressed.
 */
export function nudge(value: number, ratio: number): number {
  const limit = MIDDLE - OUTER;
  const wanted = value / (ratio || 1) - MIDDLE;
  return Math.max(-limit, Math.min(limit, wanted));
}

/** What the middle of the ring means. */
export const SEARCH = "@search";

/** How many segments the ring will hold.
 *
 * ⚠️ EIGHT. Past that a segment is thinner than the hand is accurate, and the
 * whole advantage of a radial menu — aim rather than read — is gone. What does
 * not fit is in the palette, which is what the middle opens.
 */
export const MOST = 8;

export interface RingPrefs {
  railOrder: string[];
  railHidden: string[];
  /** What the ring holds, in order — screen names and `act:` ids mixed.
   *
   * ⚠️ Empty means "the rail's own screens", which is what it was before
   * any of this: a preference nobody has touched must not be an empty ring,
   * and "unset" and "deliberately empty" have to be different answers. */
  ringStops?: string[];
}

/** One thing the ring can offer — a screen to open, or a thing to DO.
 *
 * ⚠️ Actions are the reason the ring stops being a navigation menu. Every
 * one of them is a keystroke that would otherwise want a global shortcut of
 * its own, which is the exact problem the ring was built to end. */
export interface RingStop {
  /** A screen name, or `act:<verb>`. */
  id: string;
  icon: string;
  label: string;
}

/** The verbs the ring can carry, in the order they are offered.
 *
 * ⚠️ A short list on purpose. The ring holds eight things and the screens
 * are most of what anybody wants there; a verb earns its place only if it is
 * something you do WITHOUT looking at a screen first. */
export const RING_ACTS: RingStop[] = [
  { id: "act:task", icon: "plus", label: "Add a task" },
  { id: "act:note", icon: "note", label: "Write a note" },
  { id: "act:clip", icon: "shelf", label: "Shelve clipboard" },
  { id: "act:timer", icon: "timer", label: "Start a pomodoro" },
];

/** Everything that COULD be on the ring, screens first. For the settings list. */
export function ringChoices(all: ScreenDef[]): RingStop[] {
  const screens: RingStop[] = all.map(screen =>
    ({ id: screen.name, icon: screen.icon, label: screen.label }));
  return [...screens, ...RING_ACTS];
}

/** What the ring offers, in order.
 *
 * ⚠️ An explicit list wins outright, and is not filtered by `railHidden`:
 * putting something on the ring IS the decision, and a screen taken off the
 * rail is exactly the kind of thing somebody would then want here. Without a
 * list it falls back to the rail's own screens, which is what it always was.
 */
export function ringStops(prefs: RingPrefs, all: ScreenDef[]): RingStop[] {
  const every = ringChoices(all);
  const chosen = prefs.ringStops ?? [];
  if (chosen.length) {
    return chosen
      .map(id => every.find(one => one.id === id))
      .filter((one): one is RingStop => !!one)
      .slice(0, MOST);
  }
  const rank = (name: string) => {
    const at = prefs.railOrder.indexOf(name);
    return at < 0 ? all.findIndex(s => s.name === name) + all.length : at;
  };
  return all
    // Home is never hidden, for the same reason it is never off the rail.
    .filter(screen => screen.name === "home" || !prefs.railHidden.includes(screen.name))
    .sort((a, b) => rank(a.name) - rank(b.name))
    .slice(0, MOST)
    .map(screen => ({ id: screen.name, icon: screen.icon, label: screen.label }));
}

/** A point on the ring, `turn` in turns clockwise from straight up. */
export function at(turn: number, radius: number): { x: number; y: number } {
  const angle = (turn - 0.25) * Math.PI * 2;
  return { x: MIDDLE + Math.cos(angle) * radius, y: MIDDLE + Math.sin(angle) * radius };
}

/** The path of one annular sector. */
export function sector(from: number, to: number): string {
  const edge = (turn: number, radius: number) => {
    const point = at(turn, radius);
    return `${point.x} ${point.y}`;
  };
  /* ⚠️ The large-arc flag. A segment spanning more than half the ring — which
   * is what a ring of one looks like — draws itself inside out without it, and
   * the result is a shape that is still clickable and completely wrong. */
  const wide = to - from > 0.5 ? 1 : 0;
  return `M${edge(from, OUTER)}A${OUTER} ${OUTER} 0 ${wide} 1 ${edge(to, OUTER)}`
    + `L${edge(to, INNER)}A${INNER} ${INNER} 0 ${wide} 0 ${edge(from, INNER)}Z`;
}

/** Where segment `index` of `count` starts, in turns.
 *
 * ⚠️ The first is CENTRED at the top rather than started there. Aiming is at a
 * direction, and straight up is the one direction a hand finds without looking.
 */
export function spanOf(index: number, count: number): { from: number; to: number } {
  const per = 1 / count;
  const from = index * per - per / 2;
  return { from, to: from + per };
}

/** Which screen a point is aiming at, by ANGLE rather than by what is under it.
 *
 * ⚠️ By angle, because the glyph and the label are drawn on top of their own
 * wedge: hit-testing the element under the pointer reports the text for a third
 * of the ring, and a menu that goes dead where its own labels are is worse than
 * one with no labels at all.
 */
export function aiming(
  x: number,
  y: number,
  count: number,
  held: number | null | "search" = null,
): number | null | "search" {
  const dx = x - MIDDLE;
  const dy = y - MIDDLE;
  const distance = Math.hypot(dx, dy);
  if (distance < INNER - 8) return "search";
  /* ⚠️ Only out HERE is nothing aimed at. Between the ring's edge and this,
   * the angle is still the answer: a hand that throws the pointer at a wedge
   * overshoots the ring more often than not, and the direction it threw in is
   * not in doubt just because it went too far. */
  if (distance > CANCEL) return null;
  if (count < 1) return null;
  const per = 1 / count;
  // Back to turns, with the same quarter-turn offset the drawing uses.
  const turn = (Math.atan2(dy, dx) / (Math.PI * 2) + 0.25 + per / 2 + 1) % 1;
  const now = Math.floor(turn / per) % count;

  /* ── Sticky at the boundary ──────────────────────────────────────────
   * ⚠️ The wedge being aimed at holds until the pointer is properly into the
   * next one. A pointer that has just travelled fast comes to rest near a
   * boundary as often as not, and without this it sits there flickering
   * between two stops — which is both unreadable and a coin toss for whatever
   * letting go then picks. */
  if (typeof held === "number" && held !== now && held >= 0 && held < count) {
    const step = (now - held + count) % count;
    const into = (turn / per) % 1;
    // Only the two neighbours are sticky: a jump across the ring is a
    // decision, not a wobble.
    if (step === 1 && into < STICK) return held;
    if (step === count - 1 && into > 1 - STICK) return held;
  }
  return now;
}
