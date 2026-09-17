import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAST, MOST, PER, STEP, away, clamp, offsetFor, ticks, wound } from '../src/dial.ts';

test('dragging left winds the time up', () => {
  /* ⚠️ The ruler moves with the hand and its numbers run left to right, so
   * pulling it leftward brings the bigger ones under the mark. Backwards, the
   * dial reads like a scrollbar and every setting is a fight. */
  assert.equal(wound(15, -PER), 16, 'left by one minute');
  assert.equal(wound(15, PER), 14, 'right by one minute');
  assert.equal(wound(15, -PER * 10), 25);
  // A movement smaller than half a minute is no movement.
  assert.equal(wound(15, -PER * 0.4), 15);
  assert.equal(wound(15, -PER * 0.6), 16);
});

test('the dial cannot be wound past either end', () => {
  assert.equal(wound(1, PER * 50), LEAST, 'under a minute is not a timer');
  assert.equal(wound(MOST, -PER * 50), MOST, 'past two hours is a calendar');
  assert.equal(clamp(0), LEAST);
  assert.equal(clamp(-9), LEAST);
  assert.equal(clamp(9999), MOST);
  // ⚠️ Nonsense is the floor, never NaN propagated into a transform: a NaN
  // offset makes the whole strip vanish with nothing in the console.
  assert.equal(clamp(NaN), LEAST);
  assert.equal(clamp(Infinity), MOST);
});

test('the strip shifts so the chosen minute sits under the marker', () => {
  assert.equal(offsetFor(0), 0);
  assert.equal(offsetFor(15), -15 * PER);
  // Winding up moves the strip further left, which is what puts a bigger
  // number under a mark that does not move.
  assert.ok(offsetFor(25) < offsetFor(15));
});

test('every minute has a tick and every fifth carries its number', () => {
  const all = ticks();
  assert.equal(all.length, MOST + 1, 'zero through the maximum, inclusive');
  assert.equal(all[0].minute, 0);
  assert.equal(all[MOST].minute, MOST);
  for (const tick of all) {
    assert.equal(tick.at, tick.minute * PER);
    assert.equal(tick.major, tick.minute % STEP === 0, `minute ${tick.minute}`);
  }
  // The labelled ones are one in five, which is what keeps the ruler readable.
  assert.equal(all.filter(one => one.major).length, MOST / STEP + 1);
});

test('the ruler fades with distance from the mark', () => {
  const all = ticks();
  const reach = 120;
  // Under the marker: sharp.
  assert.equal(away(all[15], 15, reach), 0);
  // Half the reach away: half faded.
  assert.equal(away(all[15 + 4], 15, reach), (4 * PER) / reach);
  /* ⚠️ Clamped at 1 rather than growing. It drives an opacity and a blur, and
   * a value past 1 is a negative opacity — which paints nothing at all and
   * looks exactly like the ruler failing to render. */
  assert.equal(away(all[MOST], 0, reach), 1);
  assert.equal(away(all[0], 0, 0), 0, 'no reach, no fade, no divide by zero');
});
