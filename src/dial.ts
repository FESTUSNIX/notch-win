/* The timer's dial: a ruler of minutes you drag under a fixed marker.
 *
 * ⚠️ The MARKER is fixed and the ruler moves, not the other way round. A
 * pointer that has to land on a moving target is a pointer that has to chase
 * one; a strip that slides under a mark you are already looking at is the same
 * gesture as the rail, which this app already asks its user to know.
 *
 * ⚠️ Pure, and in its own file, so `node --test` can load it: the maths of
 * "which minute is under the mark" is exactly the kind of off-by-one that is
 * invisible on screen and obvious in a table. Same reason `ring-geometry.ts`
 * sits beside `ring.ts`.
 */

/** Pixels per minute on the ruler. ⚠️ Big enough that one minute is a
 *  deliberate movement of the hand: at 6px a shrug is five minutes, and a
 *  timer you cannot set exactly is a timer you set twice. */
export const PER = 15;

/** What the ruler can be wound to. Under a minute is not a timer; past two
 *  hours is a calendar. */
export const LEAST = 1;
export const MOST = 120;

/** Which minutes get a taller tick and a number under them. */
export const STEP = 5;

/** The minute under the marker after dragging `dx` from `startedAt`.
 *
 * ⚠️ Dragging LEFT winds the time UP. The ruler moves with the hand and the
 * numbers on it run left to right, so pulling the strip leftward brings the
 * bigger ones under the mark — the same direction sense as a physical dial,
 * and the opposite of what "drag right to increase" would suggest.
 */
export function wound(startedAt: number, dx: number): number {
  return clamp(Math.round(startedAt - dx / PER));
}

export function clamp(minutes: number): number {
  /* ⚠️ NaN only. An infinity clamps to the end it came from all by itself,
   * but NaN survives every comparison — `Math.min(MOST, NaN)` is NaN — and
   * reaches CSS as `translateX(NaNpx)`, which paints nothing and reports
   * nothing. */
  if (Number.isNaN(minutes)) return LEAST;
  return Math.min(MOST, Math.max(LEAST, Math.round(minutes)));
}

/** How far the strip is shifted so `minutes` sits under the marker. */
export function offsetFor(minutes: number): number {
  // `|| 0` folds negative zero away: `-0` is a real number in JavaScript, it
  // is not equal to 0 under Object.is, and it reaches CSS as `-0px`.
  return -minutes * PER || 0;
}

export interface Tick {
  minute: number;
  /** Where it sits along the strip, in px from the strip's own zero. */
  at: number;
  /** Every fifth is taller and carries its number. */
  major: boolean;
}

/** Every tick on the ruler. ⚠️ Built once for the whole range rather than
 *  windowed to what is visible: two hours of ticks is 121 elements, which is
 *  nothing, and a windowed ruler has to be rebuilt on every frame of a drag —
 *  which is the one moment it must not be. */
export function ticks(): Tick[] {
  const out: Tick[] = [];
  for (let minute = 0; minute <= MOST; minute++) {
    out.push({ minute, at: minute * PER, major: minute % STEP === 0 });
  }
  return out;
}

/** How far from the marker a tick is, as a fraction of `reach`.
 *
 * Used to fade and blur the ruler toward its ends — the depth-of-field that
 * says "this is a strip passing under a mark" rather than "this is a row of
 * lines". 0 is under the marker, 1 is `reach` pixels away or further.
 */
export function away(tick: Tick, minutes: number, reach: number): number {
  if (reach <= 0) return 0;
  return Math.min(1, Math.abs(tick.at - minutes * PER) / reach);
}
