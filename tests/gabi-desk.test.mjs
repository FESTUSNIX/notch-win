import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayTitle, lockUntil, photoLeft, readDesk, threadRows, unseenIds, waitingOn } from '../src/gabi-desk.ts';

const now = new Date(2026, 10, 4, 20, 0);
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const note = (id, direction, when, extra = {}) =>
  ({ id, direction, text: 'x', fun: null, replyTo: null, photoId: null, at: when, seen: true, read: null, ...extra });

test('no reading, or no companion yet, is no desk', () => {
  assert.equal(readDesk(null), null);
  assert.equal(readDesk({ companion: null }), null);
  assert.equal(readDesk({ name: 'Gabi', notes: [] }).fund, 0);
});

test('days read in Polish', () => {
  assert.equal(dayTitle(at(4, 9), now), 'Dziś');
  assert.equal(dayTitle(at(3, 9), now), 'Wczoraj');
  assert.match(dayTitle(at(1, 9), now), /listopada/);
});

test('a day gets one heading, and a run of notes shows who only once', () => {
  const rows = threadRows([
    note(1, 'to_him', at(3, 10)),
    note(2, 'to_him', at(4, 10)),
    note(3, 'to_him', at(4, 10, 2)),
    note(4, 'to_her', at(4, 10, 3)),
    note(5, 'to_her', at(4, 10, 40)),
  ], now);
  assert.deepEqual(rows.filter(r => r.kind === 'day').map(r => r.title), ['Wczoraj', 'Dziś']);
  const notes = rows.filter(r => r.kind === 'note');
  assert.deepEqual(notes.map(r => r.firstOfRun), [true, true, false, true, true]);
  assert.deepEqual(notes.map(r => r.mine), [false, false, false, true, true]);
});

test('what Helm says is an event draws as one, and breaks the run', () => {
  const read = { style: 'event', title: '−50 zł · Gabi', line: 'YouTube', icon: 'money', tone: 'hot' };
  const rows = threadRows([note(1, 'to_him', at(4, 10)), note(2, 'to_him', at(4, 10, 1), { read }), note(3, 'to_him', at(4, 10, 2))], now);
  assert.equal(rows[2].kind, 'event');
  assert.equal(rows[2].tone, 'hot');
  assert.equal(rows[3].firstOfRun, true);
});

test('a surprise with no words is its emoji', () => {
  const [, row] = threadRows([note(1, 'to_her', at(4, 10), { text: null, fun: 'hug' })], now);
  assert.equal(row.style, 'reaction');
  assert.equal(row.text, '🤗');
});

test('a photo is a photo, and its caption is what Helm read', () => {
  const read = { style: 'photo', title: 'Gabi', line: 'Obiad', icon: 'heart', tone: 'gabi' };
  const [, row] = threadRows([note(1, 'to_him', at(4, 10), { photoId: 9, text: '📷 Obiad', read })], now);
  assert.equal(row.style, 'photo');
  assert.equal(row.text, 'Obiad');
});

test('a quick answer waits only on her last word', () => {
  assert.equal(waitingOn([note(1, 'to_him', at(4, 10))]).id, 1);
  assert.equal(waitingOn([note(1, 'to_him', at(4, 10)), note(2, 'to_her', at(4, 11))]), null);
  assert.equal(waitingOn([note(1, 'to_him', at(4, 10), { read: { style: 'event' } })]), null);
  assert.equal(waitingOn([]), null);
});

test('only what she sent and he has not seen is reported seen', () => {
  assert.deepEqual(unseenIds([
    note(1, 'to_him', at(4, 10), { seen: false }),
    note(2, 'to_him', at(4, 10)),
    note(3, 'to_her', at(4, 10), { seen: false }),
  ]), [1]);
});

test('time left on a photo, and on a lock', () => {
  const t = now.getTime();
  assert.equal(photoLeft(new Date(t + 5 * 3600_000).toISOString(), t), '5 h');
  assert.equal(photoLeft(new Date(t + 40 * 60_000).toISOString(), t), '40 min');
  assert.equal(photoLeft(new Date(t - 60_000).toISOString(), t), '0 min');
  assert.equal(lockUntil(new Date(2026, 10, 4, 21, 30).toISOString(), now), '21:30');
  assert.match(lockUntil(new Date(2026, 10, 5, 9, 0).toISOString(), now), /09:00$/);
});
