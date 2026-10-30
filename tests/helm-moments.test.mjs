import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMoments, readNotch, prepCovers, momentEvent, readClose, leftActs, logAct } from '../src/helm-link.ts';
import { MomentQueue, helmMoment, remember, actionIcon } from '../src/moments.ts';

/* Batch 12: the Guardian's moments and closing the day (contract-b12). */

const prep = {
  id: 'prep:work:ev1', kind: 'prep', tone: 'guardian', title: 'Za 10 min: Kowalski Studio', body: '10:00–10:30 Kowalski — przegląd',
  detail: [{ label: 'Zapytaj', text: 'o budżet' }, { label: 'Uważaj', text: '' }], sticky: false, priority: 88,
  actions: [{ label: 'Dołącz', do: 'open_url', url: 'https://meet.google.com/x' }, { label: 'Zły', do: 'explode' }, { label: 'Otwórz', do: 'open_url', url: 'javascript:alert(1)' }],
};

test('moments are read checked: unknown kinds and actions drop, empty detail lines go', () => {
  const list = readMoments([prep, { id: 'x', kind: 'weird', title: 't' }, { kind: 'close', title: 'no id' }, null]);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].detail, [{ label: 'Zapytaj', text: 'o budżet' }]);
  assert.deepEqual(list[0].actions.map(a => a.label), ['Dołącz'], 'a non-http url and an unknown do are dropped');
  assert.deepEqual(readMoments(undefined), []);
  assert.equal(readMoments(Array.from({ length: 9 }, (_, i) => ({ ...prep, id: `p${i}` }))).length, 6);
  // A post outside /api/notch/ is not an action.
  assert.deepEqual(readMoments([{ ...prep, actions: [{ label: 'x', do: 'post', path: '/api/queue' }] }])[0].actions, []);
});

test('a Helm without moments reads as none', () => {
  assert.deepEqual(readNotch({ day: 'x', clock: { you: 1, agents: 0 }, folders: [] }).moments, []);
});

test("Helm's prep covers the notch's own meeting moment: by id, else by name", () => {
  const [p] = readMoments([prep]);
  assert.equal(momentEvent(p.id), 'work:ev1');
  assert.equal(prepCovers(p, { id: 'ev1', title: 'Coś innego' }), true, 'the Google id after the calendar');
  assert.equal(prepCovers(p, { id: 'zz', title: 'Kowalski Studio — sprint' }), true, 'the name in the title');
  assert.equal(prepCovers(p, { id: 'zz', title: 'Kowalski — przegląd' }), true, "the event's title in the body");
  assert.equal(prepCovers(p, { id: 'zz', title: 'Dentysta' }), false);
  assert.equal(prepCovers({ ...p, kind: 'wrap' }, { id: 'ev1', title: '' }), false, 'only a prep');
});

test('a Helm moment queues by its own priority, over the kinds around it', () => {
  const q = new MomentQueue();
  const [p] = readMoments([prep]);
  q.push({ key: 'ask:1', kind: 'question', icon: 'agent', title: 'q', line: '', buttons: [], sticky: true, at: 0 });
  q.push(helmMoment(p, 1));
  assert.equal(q.step(2, { blocked: false, hovering: false }).key, 'helm:prep:work:ev1', 'prep 88 over a question 70');
  const m = helmMoment(p, 1);
  assert.equal(m.buttons[0].primary, true);
  assert.equal(m.buttons[0].icon, 'join');
  assert.equal(actionIcon({ label: '+15', do: 'queue', act: { act: 'extend' } }), 'plus');
});

test('ids are remembered once, newest last, capped', () => {
  let seen = [];
  for (let i = 0; i < 70; i++) seen = remember(seen, `m${i}`);
  seen = remember(seen, 'm10');
  assert.equal(seen.length, 60);
  assert.equal(seen.at(-1), 'm10');
  assert.equal(seen.filter(s => s === 'm10').length, 1);
});

test('the close reading is checked, and each row choice is the right queue act', () => {
  const day = readClose({
    day: '2026-10-30', worked: { you: 300, agents: 80 }, done: { count: 4, titles: ['a', 3] },
    logs: [{ key: 'log:3:x', projectId: 3, project: 'Esono', minutes: 94.6 }, { nokey: 1 }],
    left: [{ key: 'small', type: 'small', title: '3', context: null, minutes: 30, itemKeys: ['todo:1', 'todo:2'] }, { key: 'request:1', type: 'item', title: 'x', context: 'E', minutes: 60, itemKeys: [] }],
    firsts: [{ key: 'request:1', title: 'x', context: '' }], summary: '  ', closed: false,
  });
  assert.equal(day.logs.length, 1);
  assert.equal(day.logs[0].minutes, 95);
  assert.deepEqual(day.done.titles, ['a']);
  assert.equal(day.summary, null);
  assert.equal(day.firsts[0].context, null);
  assert.equal(readClose(null), null);
  assert.equal(readClose({ day: 'x' }), null);
  const [small, item] = day.left;
  assert.deepEqual(leftActs(small, 'tomorrow'), [{ act: 'snooze', key: 'small', keys: ['todo:1', 'todo:2'] }]);
  assert.deepEqual(leftActs(small, 'done'), [{ act: 'done', key: 'todo:1' }, { act: 'done', key: 'todo:2' }]);
  assert.deepEqual(leftActs(item, 'tomorrow'), [{ act: 'snooze', key: 'request:1' }]);
  assert.deepEqual(leftActs(item, 'drop'), [{ act: 'today', key: 'request:1', on: false }]);
  assert.deepEqual(leftActs(item, 'done'), [{ act: 'done', key: 'request:1' }]);
  assert.deepEqual(logAct(day.logs[0], 45.2), { act: 'done', key: 'log:3:x', minutes: 45 });
  assert.equal(logAct(day.logs[0], 0).minutes, 1);
});
