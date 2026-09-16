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
/** Where the labels sit, just outside the ring. */
export const CAPTION = OUTER + 21;
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
}

/** Which screens the ring offers, in the rail's own order. */
export function ringStops(prefs: RingPrefs, all: ScreenDef[]): ScreenDef[] {
  const rank = (name: string) => {
    const at = prefs.railOrder.indexOf(name);
    return at < 0 ? all.findIndex(s => s.name === name) + all.length : at;
  };
  return all
    // Home is never hidden, for the same reason it is never off the rail.
    .filter(screen => screen.name === "home" || !prefs.railHidden.includes(screen.name))
    .sort((a, b) => rank(a.name) - rank(b.name))
    .slice(0, MOST);
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
export function aiming(x: number, y: number, count: number): number | null | "search" {
  const dx = x - MIDDLE;
  const dy = y - MIDDLE;
  const distance = Math.hypot(dx, dy);
  if (distance < INNER - 8) return "search";
  if (distance > CAPTION + 16) return null;
  if (count < 1) return null;
  const per = 1 / count;
  // Back to turns, with the same quarter-turn offset the drawing uses.
  const turn = (Math.atan2(dy, dx) / (Math.PI * 2) + 0.25 + per / 2 + 1) % 1;
  return Math.floor(turn / per) % count;
}
