import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MomentQueue, AgentWatch, FOLD_MS, LEAVE_MS, STALE_MS, lowWindows, plannedStart, inMinutes, resetsIn,
  finishedMoment, restAfterOpen,
} from '../src/moments.ts';

const m = (key, kind, extra = {}) => ({ key, kind, icon: 'check', title: key, line: '', buttons: [], sticky: false, at: 0, ...extra });
const free = { blocked: false, hovering: false };

test('one at a time, by priority, then oldest', () => {
  const q = new MomentQueue();
  q.push(m('done', 'finished', { at: 1 }));
  q.push(m('ask', 'question', { at: 2, sticky: true }));
  q.push(m('meet', 'meeting', { at: 3 }));
  assert.equal(q.step(10, free).key, 'meet');
  assert.equal(q.step(10 + FOLD_MS, free).key, 'ask');
  // The question is sticky: it stays however long, and the finished one waits behind it.
  assert.equal(q.step(10 + FOLD_MS * 20, free).key, 'ask');
  q.drop('ask');
  assert.equal(q.step(10 + FOLD_MS * 20, free).key, 'done');
});

test('a non-sticky moment folds after FOLD_MS; the pointer holds it, leaving gives LEAVE_MS more', () => {
  const q = new MomentQueue();
  q.push(m('a', 'finished'));
  q.step(0, free);
  assert.ok(q.step(FOLD_MS - 1, { blocked: false, hovering: true }));
  assert.ok(q.step(FOLD_MS + 5000, { blocked: false, hovering: true }), 'held while hovered');
  assert.ok(q.step(FOLD_MS + 5001, free), 'just let go');
  assert.ok(q.step(FOLD_MS + 5001 + LEAVE_MS - 1, free));
  assert.equal(q.step(FOLD_MS + 5001 + LEAVE_MS, free), null);
});

test('a higher one arriving puts the current back in the queue, not on the floor', () => {
  const q = new MomentQueue();
  q.push(m('ask', 'question', { sticky: true }));
  assert.equal(q.step(0, free).key, 'ask');
  q.push(m('meet', 'meeting'));
  assert.equal(q.step(1, free).key, 'meet');
  assert.equal(q.step(1 + FOLD_MS, free).key, 'ask');
});

test('blocked: nothing shows, and the one up comes back afterwards with a fresh timer', () => {
  const q = new MomentQueue();
  q.push(m('a', 'finished'));
  q.step(0, free);
  assert.equal(q.step(4000, { blocked: true, hovering: false }), null);
  assert.equal(q.step(9000, free).key, 'a');
  assert.ok(q.step(9000 + FOLD_MS - 1, free));
  assert.equal(q.step(9000 + FOLD_MS, free), null);
});

test('what stops being true goes: until, and stale news', () => {
  const q = new MomentQueue();
  q.push(m('meet', 'meeting', { until: 100 }));
  q.push(m('old', 'finished', { at: 0 }));
  assert.equal(q.step(100, { blocked: true, hovering: false }), null);
  assert.equal(q.size, 1);
  assert.equal(q.step(STALE_MS, free), null, 'old news is dropped, not shown late');
});

test('pushing the same key replaces it in place', () => {
  const q = new MomentQueue();
  q.push(m('a', 'question', { line: 'one', sticky: true }));
  q.step(0, free);
  q.push(m('a', 'question', { line: 'two', sticky: true }));
  assert.equal(q.step(1, free).line, 'two');
  assert.equal(q.size, 1);
});

const s = (id, state, forSecs = 0, extra = {}) => ({ id, project: 'p', state, forSecs, ...extra });

test('agents: the first reading only learns', () => {
  const w = new AgentWatch();
  const news = w.update([s('a', 'idle'), s('b', 'waiting')], 0);
  assert.deepEqual(news, { finished: [], asked: [], settled: [] });
});

test('agents: working → idle after a minute of work is finished; a short turn is not', () => {
  const w = new AgentWatch();
  w.update([s('long', 'working', 90), s('short', 'working', 5)], 100_000);
  const news = w.update([s('long', 'idle'), s('short', 'idle')], 110_000);
  assert.deepEqual(news.finished.map(x => x.id), ['long']);
});

test('agents: the work time is counted from when it STARTED working, across readings', () => {
  const w = new AgentWatch();
  w.update([s('a', 'idle')], 0);
  w.update([s('a', 'working', 0)], 1000);
  w.update([s('a', 'working', 40)], 41_000);
  assert.deepEqual(w.update([s('a', 'idle')], 62_000).finished.map(x => x.id), ['a']);
});

test('agents: → waiting asks; out of waiting (or gone) settles', () => {
  const w = new AgentWatch();
  w.update([s('a', 'working', 10), s('b', 'working', 10)], 0);
  assert.deepEqual(w.update([s('a', 'waiting'), s('b', 'waiting')], 1000).asked.map(x => x.id), ['a', 'b']);
  const news = w.update([s('a', 'working')], 2000);
  assert.deepEqual(news.settled.sort(), ['a', 'b']);
  assert.deepEqual(news.finished, []);
});

test('usage: the five-hour and weekly windows at 90% or more, keyed by their reset', () => {
  const now = Date.parse('2026-10-30T10:00:00Z');
  const resets = '2026-10-30T12:00:00Z';
  const readings = [
    { id: 'claude', displayName: 'Claude', windows: [
      { id: 'session', label: 'Current session', used_fraction: 0.92, resets_at: resets },
      { id: 'weekly_all', label: 'All models', used_fraction: 0.5, resets_at: resets },
      { id: 'weekly_opus', label: 'Opus', used_fraction: 0.99, resets_at: resets },
    ] },
    { id: 'codex', displayName: 'Codex', stale: true, windows: [{ id: 'primary', label: '5h', used_fraction: 0.99, resets_at: resets }] },
  ];
  const low = lowWindows(readings, now);
  assert.deepEqual(low.map(l => l.key), [`usage:claude:session:${resets}`]);
  assert.equal(low[0].week, false);
  assert.deepEqual(lowWindows(readings, Date.parse(resets)), [], 'a window that has reset says nothing');
});

test('resetsIn and inMinutes', () => {
  const now = 0;
  assert.equal(resetsIn(new Date(40 * 60_000).toISOString(), now), 'in 40 min');
  assert.equal(resetsIn(new Date(80 * 60_000).toISOString(), now), 'in 1 h 20 min');
  assert.equal(resetsIn(new Date(120 * 60_000).toISOString(), now), 'in 2 h');
  assert.equal(inMinutes(110_000, 0), 'Za 2 min');
  assert.equal(inMinutes(0, 0), 'Teraz');
});

test('plannedStart reads Helm\'s "09:30" as today, local', () => {
  const now = new Date(2026, 9, 30, 9, 0).getTime();
  assert.equal(plannedStart('09:30', now), new Date(2026, 9, 30, 9, 30).getTime());
  assert.equal(plannedStart(null, now), null);
  assert.equal(plannedStart('2026-10-30T09:45:00Z', now), Date.parse('2026-10-30T09:45:00Z'));
});

const done = (id, project, at = 0) => finishedMoment([{ id, project, line: `${project} line`, agent: 'claude' }], `done:${id}:${at}`, at, 'claude');

test('an agent done is sticky: it never folds by itself', () => {
  const q = new MomentQueue();
  q.push(done('a', 'akcesfonia'));
  assert.equal(q.step(0, free).key, 'done:a:0');
  assert.equal(q.step(FOLD_MS * 100, free).key, 'done:a:0', 'still there when he comes back');
  assert.equal(q.step(STALE_MS * 3, free).key, 'done:a:0', 'not stale either');
  q.drop('done:a:0');
  assert.equal(q.step(STALE_MS * 3, free), null);
});

test('several agents done fold into ONE moment, Open on the first', () => {
  const q = new MomentQueue();
  q.push(done('a', 'akcesfonia', 1));
  assert.equal(q.step(1, free).title, 'akcesfonia');
  q.push(done('b', 'codenotch', 2));
  assert.equal(q.size, 1, 'joined, not queued behind it');
  const up = q.step(2, free);
  assert.equal(up.key, 'done:a:1');
  assert.equal(up.kicker, '2 done');
  assert.equal(up.title, 'akcesfonia, codenotch');
  assert.equal(up.buttons[0].label, 'Open akcesfonia');
  // The same agent again replaces its own entry.
  q.push(done('a', 'akcesfonia', 3));
  assert.deepEqual(q.step(3, free).done.map(d => d.id), ['b', 'a']);
  // Open takes the first; the rest stays up as a moment of its own size.
  const rest = restAfterOpen(q.current);
  assert.equal(rest.kicker, 'Done');
  assert.equal(rest.title, 'akcesfonia');
  assert.equal(restAfterOpen(rest), null);
});

test('one waiting behind a question is joined there too', () => {
  const q = new MomentQueue();
  q.push(m('ask', 'question', { sticky: true }));
  q.step(0, free);
  q.push(done('a', 'helm'));
  q.push(done('b', 'kit'));
  assert.equal(q.size, 2);
  q.drop('ask');
  assert.equal(q.step(1, free).kicker, '2 done');
});
