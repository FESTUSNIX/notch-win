import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, byAgent, byDay, byModel, byProject, dayBefore, spent } from '../src/usage.ts';

const bucket = (day, provider, model, project, input, output, runs = 1) =>
  ({ day, provider, model, project, input, output, runs, seconds: runs * 30 });

const WEEK = [
  bucket('2026-09-16', 'claude', 'claude-opus-5', 'akcesfonia', 900, 100, 3),
  bucket('2026-09-18', 'claude', 'claude-opus-5', 'akcesfonia', 400, 50, 2),
  bucket('2026-09-18', 'claude', 'claude-haiku-4-5', 'akcesfonia', 40, 10, 1),
  bucket('2026-09-18', 'codex', 'gpt-6-astra', 'esono', 200, 25, 1),
];

test('each agent names the model it spent the most on', () => {
  const rows = byAgent(WEEK);
  assert.deepEqual(rows.map(row => row.key), ['claude', 'codex']);
  assert.equal(spent(rows[0]), 1500);
  assert.equal(rows[0].runs, 6);
  /* ⚠️ The BIGGEST model, not the newest. A row that named whichever model
   * answered last would change under you for one cheap question. */
  assert.equal(rows[0].top, 'claude-opus-5');
  assert.equal(rows[1].top, 'gpt-6-astra');
});

test('the models are their own list, and a nameless one is not a row', () => {
  const rows = byModel([...WEEK, bucket('2026-09-18', 'claude', '', 'esono', 5000, 500)]);
  assert.deepEqual(rows.map(row => row.key),
    ['claude-opus-5', 'gpt-6-astra', 'claude-haiku-4-5']);
  /* ⚠️ The nameless bucket is real spend, and it is still dropped here: "" is
   * not a model, it is a session this app began watching mid-run. Gathered
   * into a blank row it would top the list — 5.5k against Opus's 1.45k — and
   * say nothing anybody could act on. */
  assert.equal(rows.length, 3);
});

test('projects fold across agents', () => {
  const rows = byProject(WEEK);
  assert.deepEqual(rows.map(row => row.key), ['akcesfonia', 'esono']);
  assert.equal(spent(rows[0]), 1500);
});

test('a week of days has no gaps in it', () => {
  const days = byDay(WEEK, '2026-09-18', 7);
  assert.equal(days.length, 7);
  assert.deepEqual(days.map(day => day.key), [
    '2026-09-12', '2026-09-13', '2026-09-14',
    '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
  ]);
  /* ⚠️ Zeros for the days nothing ran. Built from the days that HAVE data, a
   * week with three days off draws as three days of work in a row — which is
   * the exact opposite of what the chart is claiming. */
  assert.equal(spent(days[0]), 0);
  assert.equal(spent(days[4]), 1000);
  assert.equal(spent(days[5]), 0);
  assert.equal(spent(days[6]), 725);
  // Today is last, which is where the eye ends up.
  assert.equal(days.at(-1).key, '2026-09-18');
});

test('counting back over a month boundary lands on a real day', () => {
  assert.equal(dayBefore('2026-09-01', 1), '2026-08-31');
  assert.equal(dayBefore('2026-01-01', 1), '2025-12-31');
  // ⚠️ And over one where the clocks change: the counting is UTC precisely so
  // a 25-hour local day cannot produce the same column twice.
  assert.equal(dayBefore('2026-10-26', 1), '2026-10-25');
  assert.equal(dayBefore('2026-03-30', 1), '2026-03-29');
  assert.equal(dayBefore('2026-09-18', 0), '2026-09-18');
});

test('the total is the total, whichever way it was cut', () => {
  const whole = 900 + 100 + 400 + 50 + 40 + 10 + 200 + 25;
  assert.equal(spent(all(byAgent(WEEK))), whole);
  assert.equal(spent(all(byProject(WEEK))), whole);
  assert.equal(spent(all(byDay(WEEK, '2026-09-18', 7))), whole);
  assert.equal(all(byAgent(WEEK)).runs, 7);
});
