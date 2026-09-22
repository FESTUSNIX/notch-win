import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* ⚠️ A localStorage stand-in, installed before `runs.ts` is imported. The
 * collection reads the store in its constructor — that is what makes a run
 * survive the window being reloaded — so a test with no store at all would be
 * testing a constructor that threw. */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { Runs, blankRun, counted, figureMs, running, runName, through } =
  await import('../src/runs.ts');
const { DEFAULT_LENGTHS, remaining } = await import('../src/timer.ts');

const lengths = () => DEFAULT_LENGTHS;
const make = () => new Runs(() => {}, lengths, () => {});

beforeEach(() => store.clear());

/* ── What the list is ──────────────────────────────────────────────────── */

test('an empty store opens with one pomodoro, not with nothing', () => {
  /* ⚠️ A list is allowed to be empty; the SCREEN is not — it would be a page
   * of controls with nothing to control. */
  const runs = make();
  assert.equal(runs.list.length, 1);
  assert.equal(runs.list[0].kind, 'pomodoro');
  assert.equal(runs.current?.id, runs.list[0].id);
});

test('there can be several of each kind', () => {
  const runs = make();
  runs.clear();
  const a = runs.add('timer');
  const b = runs.add('timer');
  const c = runs.add('stopwatch');
  assert.notEqual(a.id, b.id);
  assert.equal(runs.of('timer').length, 2);
  assert.equal(runs.of('stopwatch').length, 1);
  // Adding one makes it the one you are looking at.
  assert.equal(runs.current?.id, c.id);
});

test('removing the one you are on leaves you at its neighbour', () => {
  const runs = make();
  runs.clear();
  const a = runs.add('timer');
  const b = runs.add('timer');
  const c = runs.add('timer');
  runs.pick(b.id);
  runs.remove(b.id);
  /* ⚠️ The NEIGHBOUR, not the first: removing the run you are looking at
   * should leave you next to where you were, not at the top of a list you may
   * have scrolled a long way down. */
  assert.equal(runs.current?.id, c.id);
  runs.remove(c.id);
  assert.equal(runs.current?.id, a.id);
});

/* ── Counting down ─────────────────────────────────────────────────────── */

test('a countdown that has not been started reads as its full length', () => {
  /* ⚠️ Not zero. An unstarted timer reading 00:00 is a timer that looks
   * finished, which is the one thing it must not look like before it has
   * begun. */
  const runs = make();
  runs.clear();
  const timer = runs.add('timer');
  runs.setMinutes(timer.id, 17);
  assert.equal(figureMs(runs.current, DEFAULT_LENGTHS), 17 * 60_000);
  assert.equal(running(runs.current), false);

  const pom = runs.add('pomodoro');
  assert.equal(figureMs(pom, DEFAULT_LENGTHS), DEFAULT_LENGTHS.work * 60_000);
});

test('toggling starts it, pauses it, and picks it up where it stopped', () => {
  const runs = make();
  runs.clear();
  const timer = runs.add('timer');
  runs.setMinutes(timer.id, 10);

  runs.toggle(timer.id);
  assert.equal(running(timer), true);
  assert.ok(remaining(timer.count) > 9 * 60_000);

  runs.toggle(timer.id);
  assert.equal(running(timer), false);
  // ⚠️ Paused shows what is LEFT, which is what `remaining` reads off `left`.
  const held = remaining(timer.count);
  assert.ok(held > 9 * 60_000 && held <= 10 * 60_000);

  runs.toggle(timer.id);
  assert.equal(running(timer), true);
});

test('setting a length replaces a countdown that has not finished', () => {
  const runs = make();
  runs.clear();
  const timer = runs.add('timer');
  runs.toggle(timer.id);
  runs.toggle(timer.id);            // paused, part-way through
  runs.setMinutes(timer.id, 40);
  /* ⚠️ A set length REPLACES an unfinished countdown rather than fighting it:
   * a timer you have just set to forty minutes must not still be holding
   * twenty-four of the old one. */
  assert.equal(timer.count, null);
  assert.equal(figureMs(timer, DEFAULT_LENGTHS), 40 * 60_000);
});

test('a running timer will not have its length changed under it', () => {
  const runs = make();
  runs.clear();
  const timer = runs.add('timer');
  runs.setMinutes(timer.id, 10);
  runs.toggle(timer.id);
  runs.setMinutes(timer.id, 55);
  // ⚠️ Setting a length and changing one mid-count are different things, and
  // there is no control for the second because nobody means it.
  assert.equal(timer.minutes, 10);
});

/* ── Counting up ───────────────────────────────────────────────────────── */

test('a stopwatch banks what it counted and picks up from there', () => {
  const runs = make();
  runs.clear();
  const watch = runs.add('stopwatch');
  assert.equal(counted(watch, 1000), 0);

  watch.startedAt = 1000;
  assert.equal(counted(watch, 4000), 3000);

  // Pausing banks it; the figure does not move afterwards.
  watch.elapsed = 3000;
  watch.startedAt = null;
  assert.equal(counted(watch, 99_000), 3000);

  watch.startedAt = 99_000;
  assert.equal(counted(watch, 100_000), 4000);
});

test('a stopwatch has no phase, no target and no "through"', () => {
  /* ⚠️ It is not a countdown with the sign flipped: it cannot end, so there is
   * no fraction of it to be part-way through. The ring draws a full circle for
   * exactly this reason. */
  const watch = blankRun('stopwatch');
  assert.equal(watch.count, null);
  assert.equal(through(watch, DEFAULT_LENGTHS), 0);
  assert.equal(figureMs(watch, DEFAULT_LENGTHS, 0), 0);
});

/* ── Names, and what comes off disk ────────────────────────────────────── */

test('a run with no title of its own reads as its kind', () => {
  assert.equal(runName(blankRun('pomodoro')), 'Pomodoro');
  assert.equal(runName(blankRun('timer')), 'Timer');
  assert.equal(runName(blankRun('stopwatch')), 'Stopwatch');
  assert.equal(runName({ ...blankRun('timer'), title: 'Oven' }), 'Oven');
});

test('the list survives being written and read back', () => {
  const first = make();
  first.clear();
  const timer = first.add('timer');
  first.rename(timer.id, 'Oven');
  first.setMinutes(timer.id, 12);
  first.add('stopwatch');

  const again = make();
  assert.deepEqual(again.list.map(one => one.kind), ['timer', 'stopwatch']);
  assert.equal(again.list[0].title, 'Oven');
  assert.equal(again.list[0].minutes, 12);
  // And which one you were on.
  assert.equal(again.current?.kind, 'stopwatch');
});

test('a nonsense entry is repaired rather than dropping the whole list', () => {
  /* ⚠️ This is JSON in a browser store that a person can edit and an older
   * build can have written. Dropping the list to fix one field is somebody's
   * afternoon of runs gone. */
  store.set('codenotch.runs.v1', JSON.stringify({
    active: 'nope',
    list: [
      { id: 'a', kind: 'timer', minutes: 9 },
      null,
      'not a run',
      { id: 'b', kind: 'from-the-future', minutes: -4, title: 7 },
    ],
  }));
  const runs = make();
  assert.deepEqual(runs.list.map(one => one.id), ['a', 'b']);
  // An unknown kind reads as a timer, and a bad length as the default.
  assert.equal(runs.list[1].kind, 'timer');
  assert.equal(runs.list[1].minutes, 25);
  assert.equal(runs.list[1].title, '');
  // ⚠️ An `active` naming nothing settles onto something that exists.
  assert.equal(runs.current?.id, 'a');
});

test('the old one-each keys become runs in the new list', () => {
  /* ⚠️ The app had exactly one pomodoro and one timer, each with its own key.
   * Somebody four rounds into a pomodoro must not lose it to an update. */
  const soon = Date.now() + 5 * 60_000;
  store.set('codenotch.timer.pomodoro', JSON.stringify({
    phase: 'work', endsAt: soon, left: 0, round: 2, whole: 25 * 60_000,
  }));
  store.set('codenotch.timer.plain', JSON.stringify({
    phase: 'plain', endsAt: null, left: 90_000, round: 0, whole: 5 * 60_000, name: 'Tea',
  }));
  const runs = make();
  assert.deepEqual(runs.list.map(one => one.kind), ['pomodoro', 'timer']);
  assert.equal(runs.list[0].count?.round, 2);
  assert.equal(runs.list[1].title, 'Tea');
});

test('a countdown that ran out while the app was closed is dropped', () => {
  /* ⚠️ The rule the old engine had, kept: the one thing a timer must never do
   * is go off at the wrong time. */
  store.set('codenotch.timer.plain', JSON.stringify({
    phase: 'plain', endsAt: Date.now() - 60_000, left: 0, round: 0, whole: 60_000,
  }));
  const runs = make();
  assert.equal(runs.list.length, 1);
  assert.equal(runs.list[0].kind, 'pomodoro');   // the empty-list fallback
});

test('a run that finished while the list was stored comes back unstarted', () => {
  store.set('codenotch.runs.v1', JSON.stringify({
    active: 'a',
    list: [{
      id: 'a', kind: 'timer', title: '', minutes: 5,
      count: { phase: 'plain', endsAt: Date.now() - 1000, left: 0, round: 0, whole: 300_000 },
      elapsed: 0, startedAt: null,
    }],
  }));
  /* ⚠️ After a TICK. Loading leaves a finished phase exactly as it was — the
   * catch-up needs the pomodoro lengths and the constructor runs before the
   * app can supply them — so the shell's first tick a second later is what
   * clears it. A plain timer has nothing after it, so that is the end of it. */
  const runs = make();
  runs.tick();
  assert.equal(runs.list[0].count, null);
  assert.equal(figureMs(runs.list[0], DEFAULT_LENGTHS), 5 * 60_000);
});

test('clearing takes the lot, and the screen still has something to show', () => {
  const runs = make();
  runs.add('timer');
  runs.add('stopwatch');
  runs.clear();
  assert.deepEqual(runs.list, []);
  assert.equal(runs.current, null);
});

/* ── What survives the window being closed ─────────────────────────────── */

/** Reach into the store and put the run's phase end in the past, which is what
 *  closing the window and coming back later amounts to. */
function ranOutAgo(ms) {
  const held = JSON.parse(store.get('codenotch.runs.v1'));
  held.list[0].count.endsAt = Date.now() - ms;
  store.set('codenotch.runs.v1', JSON.stringify(held));
}

test('a phase that ran out while the window was shut is advanced, not thrown away', () => {
  const runs = make();
  const pom = runs.list[0];
  runs.toggle(pom.id);
  ranOutAgo(60_000);

  /* ⚠️ TICKED. The catch-up is in `tick`, not in the constructor: it needs the
   * pomodoro lengths, and the closure tasks.ts passes for those reads a const
   * declared after the collection itself — so reading them at construction
   * killed the app on boot. One tick is what the shell does a second later. */
  const back = make();
  back.tick();
  const one = back.list[0];
  /* ⚠️ The round is KEPT. Discarding a finished phase on load — which is what
   * this did — lost the rounds already worked, so a pomodoro left alone through
   * its own break came back looking as though it had reset itself while nobody
   * was at the desk. `next` exists for exactly that and `tick` always used it;
   * only the load path did not. */
  assert.ok(one.count, 'the run still has a phase');
  assert.equal(one.count.phase, 'rest', 'a finished focus round rolls into its break');
  assert.equal(one.count.round, 1, 'and the round it earned is counted');
});

test('a run left shut through work AND break parks on the next round, ready', () => {
  const runs = make();
  const pom = runs.list[0];
  runs.toggle(pom.id);
  ranOutAgo(6 * 60 * 60 * 1000);

  /* ⚠️ TICKED. The catch-up is in `tick`, not in the constructor: it needs the
   * pomodoro lengths, and the closure tasks.ts passes for those reads a const
   * declared after the collection itself — so reading them at construction
   * killed the app on boot. One tick is what the shell does a second later. */
  const back = make();
  back.tick();
  const one = back.list[0];
  /* ⚠️ READY, not running. `next` hands the following work round back on its
   * start button — a pomodoro app that has already begun your next twenty-five
   * minutes for you is one you end up fighting — and that is also what BOUNDS
   * the advance: a ready phase is not "done", so the loop stops there however
   * long the window was shut. */
  assert.equal(one.count.phase, 'work');
  assert.equal(running(one), false, 'it waits on the start button');
  assert.equal(one.count.round, 1, 'the round already worked is still counted');
});

test('a plain timer that ran out while shut simply ends', () => {
  const runs = make();
  const one = runs.add('timer');
  runs.toggle(one.id);
  const held = JSON.parse(store.get('codenotch.runs.v1'));
  held.list.find(r => r.kind === 'timer').count.endsAt = Date.now() - 60_000;
  store.set('codenotch.runs.v1', JSON.stringify(held));

  // ⚠️ A timer has one phase, so there is nothing for `next` to hand back and
  // the advance has to leave it idle rather than loop looking for one.
  const back = make();
  back.tick();
  const timer = back.list.find(r => r.kind === 'timer');
  assert.equal(timer.count, null);
  assert.equal(running(timer), false);
});
