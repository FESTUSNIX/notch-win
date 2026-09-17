import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIVE, LEAST, MOST, PER, STEP, clamp, free, offsetFor, ticks, wound } from '../src/dial.ts';

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

test('the ruler follows the hand between the marks', () => {
  /* ⚠️ FRACTIONAL, and this is the whole feel of the control. `wound` rounds
   * because it decides what the timer is SET to; `free` is where the strip is
   * drawn while a hand is on it, and rounding there made the ruler stand still
   * for seven pixels and then jump fifteen. */
  assert.equal(free(15, -PER / 2), 15.5);
  assert.equal(free(15, PER / 4), 14.75);
  assert.equal(free(15, 0), 15);
  // And it still reads the same direction as `wound`.
  assert.ok(free(15, -PER) > 15, 'left winds up');
});

test('the ends give rather than stopping dead', () => {
  /* ⚠️ Asymptotic. A hard stop reads as the control breaking under the
   * hand; an unbounded overshoot leaves the ruler somewhere that has to be
   * dragged back from. Neither end can travel a whole `GIVE`. */
  const under = free(LEAST, PER * 40);
  assert.ok(under < LEAST, 'it does move past the end');
  assert.ok(under > LEAST - GIVE, 'but never the whole give');
  assert.ok(free(LEAST, PER * 4000) > LEAST - GIVE, 'however hard you pull');

  const over = free(MOST, -PER * 40);
  assert.ok(over > MOST && over < MOST + GIVE);

  // Half the give at the point you have asked for a whole one.
  assert.equal(free(MOST, -PER * GIVE), MOST + GIVE / 2);

  // And nonsense is still the floor, never NaN into a transform.
  assert.equal(free(NaN, 0), LEAST);
  assert.equal(free(15, NaN), LEAST);
});
