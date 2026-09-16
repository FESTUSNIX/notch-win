import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LENGTHS, ROUNDS, done, next, phaseName, remaining, spokenEnd } from '../src/timer.ts';

const at = (phase, endsAt, round = 0, left = 0) => ({ phase, endsAt, left, round });

test('what is left is arithmetic against the clock, not a ticked-down number', () => {
  const now = 1_000_000;
  // ⚠️ An end TIME, so the answer survives the window being reloaded, the
  // machine sleeping, and a second that the browser skipped.
  assert.equal(remaining(at('work', now + 90_000), now), 90_000);
  assert.equal(remaining(at('work', now - 5), now), 0, 'never negative');
  assert.equal(remaining(null, now), 0);
  // Paused: whatever was banked, whatever the clock says.
  assert.equal(remaining(at('work', null, 0, 42_000), now + 10 ** 9), 42_000);
});

test('a paused countdown never runs out', () => {
  const now = 1_000_000;
  assert.ok(done(at('plain', now - 1), now));
  assert.ok(!done(at('plain', now + 1), now));
  // ⚠️ The one that matters: paused sits at what was left, and a paused timer
  // that announces itself is a timer you cannot pause.
  assert.ok(!done(at('plain', null, 0, 1), now));
  assert.ok(!done(null, now));
});

test('work rolls into its break; a break does not roll into work', () => {
  const now = 1_000_000;
  const after = next(at('work', now, 0), DEFAULT_LENGTHS, now);
  assert.equal(after.phase, 'rest');
  assert.equal(after.round, 1);
  assert.equal(after.endsAt, now + DEFAULT_LENGTHS.rest * 60_000);

  /* ⚠️ Resting is the half people skip, so it starts itself. Working is the
   * half that should be a decision — an app that has already started your next
   * twenty-five minutes is one you end up fighting. */
  assert.equal(next(at('rest', now, 1), DEFAULT_LENGTHS, now), null);
  assert.equal(next(at('long', now, 4), DEFAULT_LENGTHS, now), null);
  // And a plain timer is just over.
  assert.equal(next(at('plain', now, 0), DEFAULT_LENGTHS, now), null);
});

test('the fourth round earns the long break', () => {
  const now = 1_000_000;
  for (let round = 0; round < ROUNDS * 2; round++) {
    const after = next(at('work', now, round), DEFAULT_LENGTHS, now);
    const long = (round + 1) % ROUNDS === 0;
    assert.equal(after.phase, long ? 'long' : 'rest', `round ${round + 1}`);
    assert.equal(
      after.endsAt - now,
      (long ? DEFAULT_LENGTHS.long : DEFAULT_LENGTHS.rest) * 60_000,
      `round ${round + 1} length`,
    );
  }
});

test('the lengths come from outside, so settings apply to the next phase', () => {
  const now = 1_000_000;
  const mine = { work: 50, rest: 10, long: 30 };
  assert.equal(next(at('work', now, 0), mine, now).endsAt - now, 10 * 60_000);
  assert.equal(next(at('work', now, ROUNDS - 1), mine, now).endsAt - now, 30 * 60_000);
});

test('each phase says what it is, in words rather than in a code', () => {
  assert.equal(phaseName(at('work', 1)), 'Focus');
  assert.equal(phaseName(at('rest', 1)), 'Break');
  assert.equal(phaseName(at('long', 1)), 'Long break');
  assert.equal(phaseName(at('plain', 1)), 'Timer');
  assert.equal(phaseName(null), 'Timer');
});

test('what the toast says matches what actually happened next', () => {
  // ⚠️ The count is of pomodoros FINISHED, so the first one to end says "1".
  const first = spokenEnd(at('work', 1, 0), DEFAULT_LENGTHS);
  assert.match(first.body, /^1 so far — 5 minute break started\.$/);
  // The fourth says the long break, because that is the one that started.
  const fourth = spokenEnd(at('work', 1, ROUNDS - 1), DEFAULT_LENGTHS);
  assert.match(fourth.body, /^4 so far — 15 minute break started\.$/);
  assert.equal(spokenEnd(at('rest', 1, 1), DEFAULT_LENGTHS).title, 'Break over');
  assert.equal(spokenEnd(at('plain', 1), DEFAULT_LENGTHS).title, 'Timer done');
});
