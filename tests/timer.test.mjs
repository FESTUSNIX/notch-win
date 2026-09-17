import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LENGTHS, ROUNDS, cycle, done, next, phaseName, remaining, spokenEnd,
} from '../src/timer.ts';

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

test('work rolls into its break; a break hands back a round that waits', () => {
  const now = 1_000_000;
  const after = next(at('work', now, 0), DEFAULT_LENGTHS, now);
  assert.equal(after.phase, 'rest');
  assert.equal(after.round, 1);
  assert.equal(after.endsAt, now + DEFAULT_LENGTHS.rest * 60_000);

  /* ⚠️ Resting is the half people skip, so it starts itself. Working is the
   * half that should be a decision — an app that has already started your next
   * twenty-five minutes is one you end up fighting.
   *
   * ⚠️ But a decision is not the same as throwing the run away, which is
   * what returning null did: the state went, the track emptied and the rounds
   * already done were forgotten, so a pomodoro left alone through its break
   * looked like it had reset itself. */
  const waiting = next(at('rest', now, 1), DEFAULT_LENGTHS, now);
  assert.equal(waiting.phase, 'work');
  assert.equal(waiting.endsAt, null, 'ready, not running');
  assert.equal(waiting.ready, true);
  assert.equal(waiting.round, 1, 'the round it has already done is kept');
  assert.equal(waiting.left, DEFAULT_LENGTHS.work * 60_000);
  // Nothing has elapsed, so a ready round is never `done`.
  assert.ok(!done(waiting, now + 10_000_000));

  const afterLong = next(at('long', now, 4), DEFAULT_LENGTHS, now);
  assert.equal(afterLong.phase, 'work');
  assert.equal(afterLong.round, 4);

  // The name carries across the break and out the other side.
  const named = next({ ...at('rest', now, 1), name: 'Ship it' }, DEFAULT_LENGTHS, now);
  assert.equal(named.name, 'Ship it');

  // And a plain timer is just over.
  assert.equal(next(at('plain', now, 0), DEFAULT_LENGTHS, now), null);
});

test('a round that is waiting is where the track says it is', () => {
  /* ⚠️ The point of keeping the run: the track has to show round two as the
   * one to come, with round one behind it — not an empty track, which is what
   * "it reset itself" looked like. */
  const waiting = next(at('rest', 1_000_000, 1), DEFAULT_LENGTHS, 1_000_000);
  const track = cycle(DEFAULT_LENGTHS, waiting);
  assert.equal(track[0].state, 'done', 'round one');
  assert.equal(track[1].state, 'done', 'its break');
  assert.equal(track[2].state, 'now', 'round two, waiting on you');
  assert.equal(track[3].state, 'todo');
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

/** The track as a compact string: `W` focus, `b` break, `L` long, and the
 *  state as `.` to come, `>` running, `x` behind you. */
const track = state => cycle(DEFAULT_LENGTHS, state)
  .map(one => {
    const letter = one.phase === "work" ? "W" : one.phase === "long" ? "L" : "b";
    const mark = one.state === "done" ? "x" : one.state === "now" ? ">" : ".";
    return letter + mark;
  })
  .join(" ");

test('the track is always the same eight segments', () => {
  /* ⚠️ Four rounds and their breaks, whatever is running. A row of segments
   * that grows under you cannot be used to tell where you are, which is the
   * only job it has. */
  for (const state of [null, at('work', 1, 0), at('rest', 1, 1), at('long', 1, 4)]) {
    const all = cycle(DEFAULT_LENGTHS, state);
    assert.equal(all.length, ROUNDS * 2);
    assert.deepEqual(all.map(one => one.phase),
      ['work', 'rest', 'work', 'rest', 'work', 'rest', 'work', 'long']);
  }
  // Each carries its own length, so the track can be drawn to scale.
  const [focus, breather] = cycle(DEFAULT_LENGTHS, null);
  assert.equal(focus.minutes, DEFAULT_LENGTHS.work);
  assert.equal(breather.minutes, DEFAULT_LENGTHS.rest);
  assert.equal(cycle(DEFAULT_LENGTHS, null)[7].minutes, DEFAULT_LENGTHS.long);
});

test('where you are on the track is where you actually are', () => {
  // Nothing running: nothing is behind you and nothing is lit.
  assert.equal(track(null), 'W. b. W. b. W. b. W. L.');

  // The first focus round.
  assert.equal(track(at('work', 1, 0)), 'W> b. W. b. W. b. W. L.');

  /* ⚠️ The break after round ONE is the FIRST break, not the second. `round`
   * counts finished rounds, which is not a position — reading it as one put
   * three segments behind you the moment you skipped the first round. */
  assert.equal(track(at('rest', 1, 1)), 'Wx b> W. b. W. b. W. L.');

  // Second round running: the first break is behind you now.
  assert.equal(track(at('work', 1, 1)), 'Wx bx W> b. W. b. W. L.');
  assert.equal(track(at('rest', 1, 2)), 'Wx bx Wx b> W. b. W. L.');

  // The fourth round, and the long break it earns.
  assert.equal(track(at('work', 1, 3)), 'Wx bx Wx bx Wx bx W> L.');
  assert.equal(track(at('long', 1, 4)), 'Wx bx Wx bx Wx bx Wx L>');
});

test('a second cycle starts the track again rather than growing it', () => {
  /* ⚠️ After the fourth round `round % 4` is 0, which would empty the whole
   * track while the long break it earned is still running — so the long break
   * is the one case that reads as the END of a cycle rather than the start of
   * the next. */
  assert.equal(track(at('long', 1, 4)), 'Wx bx Wx bx Wx bx Wx L>');
  assert.equal(track(at('work', 1, 4)), 'W> b. W. b. W. b. W. L.', 'round five is a fresh track');
  assert.equal(track(at('rest', 1, 5)), 'Wx b> W. b. W. b. W. L.');
  assert.equal(track(at('long', 1, 8)), 'Wx bx Wx bx Wx bx Wx L>', 'and again after eight');
});
