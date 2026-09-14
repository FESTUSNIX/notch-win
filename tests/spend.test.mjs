import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byProject, sum, share, short, total } from '../src/spend.ts';

const run = (project, input, output, seconds = 60) =>
  ({day: '2026-09-15', project, input, output, seconds, endedMs: 0, waiting: true});

test('the usage notch says the window is going; this says what is eating it', () => {
  const rows = byProject([
    run('akcesfonia', 900_000, 20_000),
    run('codenotch', 300_000, 8_000),
    run('akcesfonia', 400_000, 12_000),
  ]);
  assert.deepEqual(rows.map(r => r.project), ['akcesfonia', 'codenotch']);
  assert.equal(rows[0].input, 1_300_000);
  assert.equal(rows[0].runs, 2);
  assert.equal(rows[0].seconds, 120);
});

test('a project that spent nothing is dropped, not listed as zero', () => {
  /* ⚠️ Runs recorded before tokens were counted carry zeros. Two weeks of
   * those at the top of the list — named, ordered, every one reading 0 — looks
   * like the feature is broken rather than like the history predates it. */
  const rows = byProject([run('old-work', 0, 0), run('akcesfonia', 5_000, 100)]);
  assert.deepEqual(rows.map(r => r.project), ['akcesfonia']);
});

test('a missing token field counts as nothing, never as NaN', () => {
  // The Rust side writes these with serde(default), so an old file has neither.
  const rows = byProject([{day: 'x', project: 'p', seconds: 10, endedMs: 0, waiting: true},
                          run('p', 12, 3)]);
  assert.equal(rows[0].input, 12);
  assert.equal(Number.isNaN(total(rows[0])), false);
});

test('shares add up, and an empty day is 0 rather than NaN', () => {
  const rows = byProject([run('a', 750, 0), run('b', 250, 0)]);
  const whole = sum(rows);
  assert.equal(total(whole), 1000);
  assert.equal(share(rows[0], whole), 0.75);
  // ⚠️ A bar whose width is `NaN%` silently renders at FULL width, so the
  // emptiest possible day would look like the busiest.
  assert.equal(share({project:'', input:0, output:0, runs:0, seconds:0},
                     {project:'', input:0, output:0, runs:0, seconds:0}), 0);
});

test('a token count is read at a glance or not at all', () => {
  assert.equal(short(900), '900');
  assert.equal(short(48_200), '48k');
  assert.equal(short(1_284_000), '1.3M');
  // Past ten million the decimal is noise, not precision.
  assert.equal(short(12_400_000), '12M');
});
