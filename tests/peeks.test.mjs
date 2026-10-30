import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PeekQueue, PillCycle, PEEK_TTL, STALE_MS, REPLAY, IDLE_MS, inQuiet, peek, peekOn, peeks, setPeekPrefs,
} from '../src/peeks.ts';
import { BlockPeeks, CalendarPeeks, MusicPeeks } from '../src/peek-feed.ts';

const p = (id, kind = 'music', extra = {}) => ({ id, kind, icon: 'media', title: id, ...extra });

test('one at a time, for its ttl, then the next', () => {
  const q = new PeekQueue();
  q.push(p('song', 'music'), 0);
  q.push(p('5min', 'block'), 0);
  assert.equal(q.step(0, false).id, 'song');
  assert.equal(q.step(PEEK_TTL - 1, false).id, 'song');
  assert.equal(q.step(PEEK_TTL, false).id, '5min');
  assert.equal(q.step(PEEK_TTL * 2, false), null);
});

test('the newest of a kind replaces the older, waiting or up', () => {
  const q = new PeekQueue();
  q.push(p('a'), 0); q.push(p('b'), 1); q.push(p('c'), 2);
  assert.equal(q.size, 1);
  assert.equal(q.step(3, false).id, 'c');
  // Up already: swapped in place, and its time starts again.
  q.push(p('d'), 3000);
  assert.equal(q.step(3000 + PEEK_TTL - 1, false).id, 'd');
  assert.equal(q.size, 1);
});

test('held back: waits while held, a hold ends one that is up, stale ones drop', () => {
  const q = new PeekQueue();
  q.push(p('song'), 0);
  assert.equal(q.step(10, true), null);
  assert.equal(q.step(20, false).id, 'song');
  // The panel opens mid-peek: it ends (it is in the replay), it does not resume.
  assert.equal(q.step(30, true), null);
  assert.equal(q.step(40, false), null);
  assert.equal(q.recent[0].id, 'song');
  q.push(p('late', 'block'), 100);
  assert.equal(q.step(100 + STALE_MS, false), null);
});

test('the replay keeps the last few shown, newest first, one per kind', () => {
  const q = new PeekQueue();
  let t = 0;
  for (const [id, kind] of [['s1', 'music'], ['b', 'block'], ['s2', 'music'], ['m', 'meeting'], ['l', 'leave']]) {
    q.push(p(id, kind), t); q.step(t, false); t += PEEK_TTL;
  }
  assert.deepEqual(q.recent.map(one => one.id), ['l', 'm', 's2']);
  assert.equal(q.recent.length, REPLAY);
});

test('the wheel: owner → second → replay → back, and idle returns to the owner', () => {
  const c = new PillCycle();
  assert.equal(c.wheel(1, 4, 0), 1);
  assert.equal(c.wheel(1, 4, 100), 2);
  assert.equal(c.wheel(1, 4, 200), 3);
  assert.equal(c.wheel(1, 4, 300), 0);
  assert.equal(c.wheel(-1, 4, 400), 3);
  assert.equal(c.index(4, 400 + IDLE_MS - 1), 3);
  assert.equal(c.index(4, 400 + IDLE_MS + 1), 0);
  // A stop that vanished (second place went) falls back rather than drawing blank.
  c.wheel(1, 4, 0); c.wheel(1, 4, 0); c.wheel(1, 4, 0);
  assert.equal(c.index(2, 10), 0);
  assert.equal(c.wheel(1, 1, 10), 0);
});

test('quiet hours, including across midnight', () => {
  const at = (h, m) => { const d = new Date(2026, 9, 30, h, m); return d; };
  assert.equal(inQuiet({ from: '22:00', to: '07:00' }, at(23, 30)), true);
  assert.equal(inQuiet({ from: '22:00', to: '07:00' }, at(6, 59)), true);
  assert.equal(inQuiet({ from: '22:00', to: '07:00' }, at(7, 0)), false);
  assert.equal(inQuiet({ from: '13:00', to: '14:00' }, at(13, 30)), true);
  assert.equal(inQuiet(null, at(13, 30)), false);
});

test('peek() honours the switches and quiet hours, urgent goes through', () => {
  setPeekPrefs({ peeks: { music: false } });
  assert.equal(peekOn('music'), false);
  assert.equal(peekOn('block'), true);
  assert.equal(peek(p('x', 'music')), false);
  assert.equal(peek(p('y', 'block')), true);
  setPeekPrefs({ peekQuiet: { from: '00:00', to: '23:59' } });
  const quiet = inQuiet({ from: '00:00', to: '23:59' }, new Date());
  assert.equal(peek(p('z', 'meeting')), !quiet);
  assert.equal(peek(p('u', 'power', { urgent: true })), true);
  setPeekPrefs(null);
  peeks.drop('block'); peeks.drop('meeting'); peeks.drop('power');
});

test('music: a track change peeks, a pause peeks, launch and the owner do not', () => {
  const m = new MusicPeeks();
  const media = (title, playing = true) => ({ active: true, playing, title, artist: 'M83', artwork: '' });
  assert.equal(m.read({ active: false, playing: false, title: '', artist: '', artwork: '' }, false), null);
  assert.equal(m.read(media('One'), false), null, 'the first real reading after an empty one');
  assert.equal(m.read(media('Two'), false).title, 'Two');
  assert.equal(m.read(media('Two', false), false).icon, 'pause');
  assert.equal(m.read(media('Three'), true), null, 'music owns the pill: it says it itself');
});

test('block: 5 min left, ran over (once, pulsing), done with its time', () => {
  const b = new BlockPeeks();
  let ran = 0;
  const block = (status = 'running') => [{ id: 7, title: 'Rynek Czeski', status, minutes: 30, project: null }];
  assert.deepEqual(b.read([], () => 0), []);
  ran = 1499; assert.deepEqual(b.read(block(), () => ran), []);
  ran = 1501; const five = b.read(block(), () => ran);
  assert.equal(five.length, 1); assert.equal(five[0].title, 'Zostało 5 min');
  ran = 1600; assert.deepEqual(b.read(block(), () => ran), []);
  ran = 1800; const over = b.read(block(), () => ran);
  assert.equal(over[0].title, 'Czas minął'); assert.equal(over[0].pulse, true); assert.equal(over[0].tone, 'warn');
  ran = 1900; assert.deepEqual(b.read(block(), () => ran), []);
  const done = b.read(block('done'), () => 1920);
  assert.equal(done[0].title, 'Zrobione · 32 min'); assert.equal(done[0].tone, 'good');
});

test('calendar: 10 min before with Join, Czas wyjść 20 min before a place, umbrella when wet', () => {
  const c = new CalendarPeeks();
  const now = Date.parse('2026-10-30T10:00:00Z');
  const at = min => new Date(now + min * 60_000).toISOString();
  let joined = '';
  const events = [
    { id: 'm', title: 'Standup', start: at(10.1), allDay: false, location: '', meetingUrl: 'https://meet.google.com/x' },
    { id: 'd', title: 'Dentysta', start: at(20.1), allDay: false, location: 'ul. Długa 12', meetingUrl: '' },
    { id: 'z', title: 'Zoom room', start: at(19), allDay: false, location: 'https://zoom.us/j/1', meetingUrl: '' },
  ];
  assert.deepEqual(c.read([], now, null, () => {}), []);
  const first = c.read(events, now, [{ icon: 'wxClear' }], url => { joined = url; });
  assert.deepEqual(first.map(one => one.kind), [], 'Zoom in the location is a call, not a place; the others are not due');
  const later = c.read(events, now + 0.2 * 60_000, [{ icon: 'wxPartly' }, { icon: 'wxRain' }], url => { joined = url; });
  const meeting = later.find(one => one.kind === 'meeting');
  const leave = later.find(one => one.kind === 'leave');
  assert.ok(meeting.action); meeting.action.run(); assert.equal(joined, 'https://meet.google.com/x');
  assert.equal(leave.title, 'Czas wyjść · weź parasol');
  assert.deepEqual(c.read(events, now + 0.3 * 60_000, null, () => {}), [], 'each says it once');
});
