import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ⚠️ `widgets.ts` has no runtime imports, which is what lets this load at all.
 * The drawing lives in `widget-bodies.ts` and reaches for `./dom`; Node's
 * resolver will not find that without an extension. See AGENTS 645/672. */
const { coinPrice, coinChange, sparkPath, sparkPoint, sparkIndex, tempTone, until } =
  await import('../src/widgets.ts');

/* ── A price ───────────────────────────────────────────────────────────── */

test('the decimals follow the SIZE of the price', () => {
  /* ⚠️ One rule for both prints either "67432.10000000" or, for a coin worth
   * four hundredths of a cent, "0.00" — which is a price of zero on a board
   * somebody might act on. */
  assert.deepEqual(coinPrice(67432.1), { whole: '67 432', rest: '' });
  assert.deepEqual(coinPrice(12.5), { whole: '12', rest: '.50' });
  assert.deepEqual(coinPrice(0.0432), { whole: '0', rest: '.0432' });
  assert.deepEqual(coinPrice(0.00004321), { whole: '0', rest: '.00004321' });
});

test('thousands are thin-spaced, and a negative keeps its sign', () => {
  // ⚠️ A narrow no-break space rather than a comma: the block already carries a
  // decimal point, and a number with both has a format you decode first.
  assert.equal(coinPrice(1234567).whole, '1 234 567');
  assert.equal(coinPrice(-4200).whole, '-4 200');
});

test('a price that is not a number says so rather than printing NaN', () => {
  assert.deepEqual(coinPrice(Number.NaN), { whole: '—', rest: '' });
  assert.deepEqual(coinPrice(Number.POSITIVE_INFINITY), { whole: '—', rest: '' });
});

test('a change is ALWAYS signed, even flat', () => {
  // ⚠️ "0.0%" reads as missing data; "+0.0%" reads as a quiet day.
  assert.equal(coinChange(1.94), '+1.9%');
  assert.equal(coinChange(-2.41), '-2.4%');
  assert.equal(coinChange(0), '+0.0%');
});

/* ── The line ──────────────────────────────────────────────────────────── */

test('the line is scaled to its OWN range, not to zero', () => {
  /* ⚠️ A coin that moved 2% in a month is a flat line against an axis at zero,
   * which is true and useless — the question the shape answers is "what shape
   * was the month". Low lands on the floor, high on the ceiling. */
  const path = sparkPath([10, 20, 15], 100, 30);
  assert.match(path, /^M0\.00 30\.00/, 'the lowest point is on the floor');
  assert.match(path, /L50\.00 0\.00/, 'the highest is on the ceiling');
});

test('a flat month is drawn down the middle, not divided by zero', () => {
  const path = sparkPath([7, 7, 7], 100, 30);
  assert.ok(!path.includes('NaN'), path);
  assert.match(path, /15\.00/);
});

test('one point or none is no line at all', () => {
  assert.equal(sparkPath([]), '');
  assert.equal(sparkPath([4]), '');
});

test('the marker lands ON the line it marks', () => {
  /* ⚠️ The same scaling, in one place. A second copy of "low, high, span" is a
   * marker that drifts off the curve the first time either is changed. */
  const values = [10, 20, 15];
  for (const at of [0, 1, 2]) {
    const spot = sparkPoint(values, at, 100, 30);
    assert.ok(sparkPath(values, 100, 30)
      .includes(`${spot.x.toFixed(2)} ${spot.y.toFixed(2)}`), `point ${at} is on the path`);
  }
});

test('the scrub cannot run off either end of the series', () => {
  assert.equal(sparkIndex(30, -0.4), 0);
  assert.equal(sparkIndex(30, 0), 0);
  assert.equal(sparkIndex(30, 1), 29);
  assert.equal(sparkIndex(30, 1.8), 29);
  assert.equal(sparkIndex(1, 0.5), 0);
});

/* ── Temperature ───────────────────────────────────────────────────────── */

test('a temperate day is not all one colour', () => {
  /* ⚠️ The bug this replaced: spread evenly over -10 to 38, the four tones each
   * covered twelve degrees, so 12° at dawn and 19° at noon came out identical
   * and the chart said nothing on exactly the days somebody looks at it. */
  const tones = [2, 8, 12, 16, 19, 25].map(one => tempTone(one).tone);
  assert.ok(new Set(tones).size >= 3, tones.join(' '));
  assert.equal(tempTone(-4).tone, 'cool');
  assert.equal(tempTone(30).tone, 'hot');
});

test('two hours in the same band are not the identical bar', () => {
  assert.notEqual(tempTone(6).weight, tempTone(13).weight);
});

test('every temperature names a real token and a sane weight', () => {
  const tokens = new Set(['cool', 'calm', 'warn', 'hot']);
  for (const one of [-40, -5, 0, 7, 14, 22, 23, 35, 60, Number.NaN]) {
    const got = tempTone(one);
    assert.ok(tokens.has(got.tone), `${one} -> ${got.tone}`);
    assert.ok(got.weight > 0 && got.weight <= 1, `${one} -> ${got.weight}`);
  }
});

/* ── How long until ────────────────────────────────────────────────────── */

test('a countdown that has arrived says so rather than reading zero', () => {
  // ⚠️ "in 0 min" is a countdown you check twice to see whether it is broken.
  assert.equal(until(0), 'now');
  assert.equal(until(-90_000), 'now');
  assert.equal(until(20_000), 'now');
});

test('the words are the ones anybody would say', () => {
  assert.equal(until(18 * 60_000), '18 min');
  assert.equal(until(90 * 60_000), '1h 30m');
  assert.equal(until(2 * 3600_000), '2h');
  assert.equal(until(26 * 3600_000), 'tomorrow');
  assert.equal(until(3 * 86400_000), '3 days');
});
