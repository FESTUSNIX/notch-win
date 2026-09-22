import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ⚠️ `widgets.ts` has no runtime imports, which is what lets this load at all.
 * The drawing lives in `widget-bodies.ts` and reaches for `./dom`; Node's
 * resolver will not find that without an extension. See AGENTS 645/672. */
const { clockMinutes, dayArc, moonPhase, moonName } =
  await import('../src/widgets.ts');

/* ── Reading a clock ───────────────────────────────────────────────────── */

test('a clock reads as minutes past midnight', () => {
  assert.equal(clockMinutes('06:42'), 6 * 60 + 42);
  assert.equal(clockMinutes('6:42'), 6 * 60 + 42);
  assert.equal(clockMinutes('19:05'), 19 * 60 + 5);
});

test('midnight is zero, and absent is NOT', () => {
  /* ⚠️ The whole reason this returns -1 rather than 0 or null: midnight IS
   * zero, so a caller testing truthiness would have treated a real midnight as
   * a missing reading — and the widget would have drawn an even 6-to-18 day
   * over the top of a perfectly good one. */
  assert.equal(clockMinutes('00:00'), 0);
  assert.equal(clockMinutes(undefined), -1);
  assert.equal(clockMinutes(''), -1);
  assert.equal(clockMinutes('nonsense'), -1);
  assert.equal(clockMinutes('25:00'), -1);
  assert.equal(clockMinutes('06:99'), -1);
});

test('an ISO stamp reads as its clock', () => {
  // `weather.rs` trims these itself, but a build that stopped doing so should
  // shift the sun by minutes rather than drop it on the horizon.
  assert.equal(clockMinutes('06:42:00'), 6 * 60 + 42);
});

/* ── Where in the day ──────────────────────────────────────────────────── */

const RISE = 6 * 60;         // 06:00
const SET = 20 * 60;         // 20:00

test('the sun crosses its own arc, not a fraction of the day', () => {
  /* ⚠️ Halfway between sunrise and sunset is the top of the arc — which on
   * this day is 13:00, not noon. A single fraction of the 24 hours would put
   * the sun at the top at noon on the equinox and nowhere near it in
   * December, which is the one time of year anybody looks at this. */
  assert.equal(dayArc(RISE, RISE, SET).share, 0);
  assert.equal(dayArc(13 * 60, RISE, SET).share, 0.5);
  assert.equal(dayArc(SET, RISE, SET).share, 1);
});

test('the parts of the day are the crossings and the middle', () => {
  assert.equal(dayArc(RISE + 5, RISE, SET).part, 'dawn');
  assert.equal(dayArc(12 * 60, RISE, SET).part, 'day');
  assert.equal(dayArc(SET - 5, RISE, SET).part, 'dusk');
  assert.equal(dayArc(23 * 60, RISE, SET).part, 'night');
  assert.equal(dayArc(2 * 60, RISE, SET).part, 'night');
});

test('the night arc wraps midnight and still runs forward', () => {
  /* ⚠️ Measured from SUNSET onward with a day added on the far side, so the
   * same sum works at 23:50 and at 00:10 — a branch on "which side of midnight
   * is it" is where this kind of thing goes wrong. */
  const late = dayArc(23 * 60, RISE, SET).share;
  const early = dayArc(1 * 60, RISE, SET).share;
  assert.ok(late > 0 && late < 1);
  assert.ok(early > late, 'an hour after midnight is further through the night');
  assert.ok(early < 1);
});

test('a reading that has not arrived draws an even day rather than nothing', () => {
  // ⚠️ Wrong by an hour beats a widget that draws a flat line at the horizon.
  const noon = dayArc(12 * 60, -1, -1);
  assert.equal(noon.part, 'day');
  assert.equal(noon.share, 0.5);
});

test('share never leaves 0..1, whatever the clock says', () => {
  for (const at of [-500, 0, 1, 719, 1439, 1440, 9999]) {
    for (const [rise, set] of [[RISE, SET], [-1, -1], [SET, RISE], [0, 1439]]) {
      const got = dayArc(at, rise, set);
      assert.ok(got.share >= 0 && got.share <= 1,
        `share ${got.share} out of range at ${at} (${rise}..${set})`);
    }
  }
});

/* ── The moon ──────────────────────────────────────────────────────────── */

test('a known new moon is a new moon', () => {
  // The epoch the arithmetic is anchored on.
  assert.ok(moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14))) < 0.01);
});

test('the phase runs forward and comes back round', () => {
  const start = moonPhase(new Date(Date.UTC(2026, 8, 1)));
  const later = moonPhase(new Date(Date.UTC(2026, 8, 8)));
  assert.ok(start >= 0 && start < 1);
  assert.ok(later >= 0 && later < 1);
  // A month on is the same phase again, to within a few hours of a cycle.
  const month = moonPhase(new Date(Date.UTC(2026, 8, 1) + 29.530588853 * 86400000));
  assert.ok(Math.abs(month - start) < 0.01 || Math.abs(month - start) > 0.99);
});

test('a full moon is fourteen and a bit days after a new one', () => {
  const newMoon = new Date(Date.UTC(2000, 0, 6, 18, 14));
  const full = new Date(newMoon.getTime() + (29.530588853 / 2) * 86400000);
  assert.equal(moonName(moonPhase(full)), 'Full moon');
});

test('every phase has a name, and the quarters are the exact ones', () => {
  assert.equal(moonName(0), 'New moon');
  assert.equal(moonName(0.25), 'First quarter');
  assert.equal(moonName(0.5), 'Full moon');
  assert.equal(moonName(0.75), 'Last quarter');
  assert.equal(moonName(0.125), 'Waxing crescent');
  assert.equal(moonName(0.375), 'Waxing gibbous');
  assert.equal(moonName(0.625), 'Waning gibbous');
  assert.equal(moonName(0.875), 'Waning crescent');
  // ⚠️ And 0.999 is new again, not "waning crescent" — the cycle closes.
  assert.equal(moonName(0.999), 'New moon');
});
