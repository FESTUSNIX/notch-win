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

/** How far past either end the ruler can be pulled, in minutes.
 *
 * ⚠️ The ends give rather than stopping dead, and the give is ASYMPTOTIC:
 * however hard you pull, the strip never travels more than this past the last
 * mark. A hard stop reads as the control having broken under the hand; an
 * unbounded one leaves the ruler somewhere it has to be dragged back from.
 */
export const GIVE = 6;

/** Where the ruler sits while a hand is on it — the exact, FRACTIONAL minute
 *  under the marker after dragging `dx` from `startedAt`.
 *
 * ⚠️ Dragging LEFT winds the time UP. The ruler moves with the hand and the
 * numbers on it run left to right, so pulling the strip leftward brings the
 * bigger ones under the mark — the same direction sense as a physical dial,
 * and the opposite of what "drag right to increase" would suggest.
 *
 * ⚠️ Fractional ON PURPOSE. Rounding here is what made the drag feel like a
 * ratchet: the strip stood still for seven pixels of hand movement and then
 * jumped fifteen. The number that is read out rounds; the ruler follows the
 * hand, and `clamp` puts it on a mark when the hand lets go.
 */
export function free(startedAt: number, dx: number): number {
  const raw = startedAt - dx / PER;
  /* ⚠️ NaN before anything else: it survives every comparison below and
   * reaches CSS as `translateX(NaNpx)`, which paints nothing and says
   * nothing. Same trap as `clamp`. */
  if (Number.isNaN(raw)) return LEAST;
  if (raw < LEAST) return LEAST - stretch(LEAST - raw);
  if (raw > MOST) return MOST + stretch(raw - MOST);
  return raw;
}

/** `over` minutes of pull, in minutes of actual travel. Half of `GIVE` at the
 *  point where you have asked for `GIVE`, and never the whole of it. */
function stretch(over: number): number {
  return GIVE * (1 - 1 / (1 + over / GIVE));
}

/** The minute the ruler lands on when the hand lets go. */
export function wound(startedAt: number, dx: number): number {
  return clamp(free(startedAt, dx));
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

/* There is no `away` here any more, and its absence is the point.
 *
 * ⚠️ The ruler's fade used to be computed per tick and written as an
 * opacity and a blur onto all 242 children on every frame of a drag. It cost
 * the drag its smoothness, and because the fade was measured in pixels from
 * the marker it also held the ruler inside a 210px window in the middle of a
 * 700px panel — a short ruler floating in a wide screen. It is a `mask-image`
 * on the dial now: the same picture, no work per frame, and full width.
 */
