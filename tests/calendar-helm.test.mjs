import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atMinutes, blockStart, calEventFrom, dayAfter, freeOn, helmNeedsGoogle, linesThatFit, markerLabel, monthCells, monthLines, newEventCalendar, parseClock, railItems, shortLength } from '../src/calendar-helm.ts';

const reading = {
  status: 'ok', canWrite: true,
  calendars: [
    { id: 'sub', name: 'Holidays', hue: 'green', primary: false, writable: false },
    { id: 'me', name: 'Mateusz', hue: 'blue', primary: true, writable: true },
  ],
};

test('a timed event keeps its local time and carries Helm\'s ids', () => {
  const e = calEventFrom({ id: 'me:g1', googleId: 'g1', calendarId: 'me', title: 'Call', day: '2026-11-04', endDay: '2026-11-04', start: 570, end: 615, editable: true }, reading);
  assert.equal(new Date(e.start).getHours(), 9);
  assert.equal(new Date(e.start).getMinutes(), 30);
  assert.equal(new Date(e.end).getHours(), 10);
  assert.equal(e.id, 'me:g1');
  assert.equal(e.googleId, 'g1');
  assert.equal(e.allDay, false);
  assert.equal(e.writable, true);
  assert.equal(e.calendar, 'Mateusz');
});

test('an all-day event ends the day after its last, as Google writes it', () => {
  const e = calEventFrom({ id: 'me:g2', googleId: 'g2', calendarId: 'me', title: 'Trip', day: '2026-11-04', endDay: '2026-11-30', editable: true }, reading);
  assert.equal(e.allDay, true);
  assert.equal(e.start, '2026-11-04');
  assert.equal(e.end, '2026-12-01');
});

test('Helm saying it can\'t be changed, or a read-only grant, locks an event', () => {
  const base = { id: 'me:g', googleId: 'g', calendarId: 'me', title: 'x', day: '2026-11-04', endDay: '2026-11-04', start: 60, end: 120 };
  assert.equal(calEventFrom({ ...base, editable: false }, reading).writable, false);
  assert.equal(calEventFrom({ ...base, editable: true }, { ...reading, canWrite: false }).writable, false);
});

test('a meeting ending at midnight ends on the next day', () => {
  const end = atMinutes('2026-11-04', 1440);
  assert.equal(end.getDate(), 5);
  assert.equal(end.getHours(), 0);
});

test('the next day crosses months', () => {
  assert.equal(dayAfter('2026-11-30'), '2026-12-01');
  assert.equal(dayAfter('2026-12-31'), '2027-01-01');
});

test('free time counts the working day, overlaps once', () => {
  // Thursday: 9–17 with 10–11 and 10:30–12 busy leaves 8h minus 2h.
  assert.equal(freeOn([{ start: 600, end: 660 }, { start: 630, end: 720 }], '2026-11-05', '2026-11-04', 480), 6 * 60);
  // Busy time outside working hours doesn't count.
  assert.equal(freeOn([{ start: 18 * 60, end: 19 * 60 }], '2026-11-05', '2026-11-04', 480), 8 * 60);
});

test('today counts from now, and past days and weekends say nothing', () => {
  assert.equal(freeOn([], '2026-11-04', '2026-11-04', 15 * 60), 2 * 60);
  assert.equal(freeOn([], '2026-11-04', '2026-11-04', 18 * 60), 0);
  assert.equal(freeOn([], '2026-11-03', '2026-11-04', 480), null);
  assert.equal(freeOn([], '2026-11-07', '2026-11-04', 480), null);
});

test('a block\'s time, or none', () => {
  assert.equal(blockStart({ plannedAt: '09:30' }), 570);
  assert.equal(blockStart({ plannedAt: '09:30:00' }), 570);
  assert.equal(blockStart({ plannedAt: null }), null);
});

test('lengths read short', () => {
  assert.equal(shortLength(45), '45m');
  assert.equal(shortLength(120), '2h');
  assert.equal(shortLength(210), '3h 30');
});

test('the rail leaves out what is planned in full', () => {
  assert.deepEqual(railItems([{ key: 'a', covered: false }, { key: 'b', covered: true }]).map(one => one.key), ['a']);
});

test('a new event goes on the primary calendar, never one he can\'t write to', () => {
  assert.equal(newEventCalendar(reading), 'me');
  assert.equal(newEventCalendar({ calendars: [{ id: 'sub', primary: true, writable: false }] }), null);
});

test('only Helm having lost Google asks for a sign-in', () => {
  assert.equal(helmNeedsGoogle({ status: 'expired' }), true);
  assert.equal(helmNeedsGoogle({ status: 'disconnected' }), true);
  assert.equal(helmNeedsGoogle({ status: 'ok' }), false);
  assert.equal(helmNeedsGoogle({ status: 'unconfigured' }), false);
  assert.equal(helmNeedsGoogle(null), false);
});

test('a payment says how much, and for whom', () => {
  const money = n => `${n} zł`;
  assert.equal(markerLabel({ kind: 'payment', title: 'Rata', context: 'Esono', amount: 1200 }, money), '1200 zł Esono');
  assert.equal(markerLabel({ kind: 'delivery', title: 'Repricer', context: 'Esono', amount: null }, money), 'Repricer');
});

test('a time as he types it', () => {
  assert.equal(parseClock('15:30'), 15.5);
  assert.equal(parseClock('15.30'), 15.5);
  assert.equal(parseClock('1530'), 15.5);
  assert.equal(parseClock('9'), 9);
  assert.equal(parseClock('24:00'), 24);
  assert.equal(parseClock('24:30'), null);
  assert.equal(parseClock('25'), null);
  assert.equal(parseClock('3pm'), null);
  assert.equal(parseClock(''), null);
});

test('a month draws as many weeks as it needs', () => {
  // November 2026 starts on a Sunday: six rows from Monday 26 Oct.
  const nov = monthCells(2026, 10, true);
  assert.equal(nov.length, 42);
  assert.equal(nov[0].getDate(), 26);
  assert.equal(nov[0].getDay(), 1);
  // February 2027 starts on a Monday and has exactly four weeks.
  const feb = monthCells(2027, 1, true);
  assert.equal(feb.length, 28);
  assert.equal(feb[0].getDate(), 1);
  // And on a Sunday-first calendar it starts on a Sunday.
  assert.equal(monthCells(2026, 10, false)[0].getDay(), 0);
});

test('blocks for one project fold where the first starts, and all-day comes first', () => {
  const line = (id, start, end, project = null, isBlock = false) =>
    ({ id, title: id, start, end, color: '', project, isBlock, done: false });
  const esono = { id: 1, name: 'Esono' };
  const lines = monthLines([
    line('late', 16, 17),
    line('b1', 9, 10.5, esono, true),
    line('allday', null, null),
    line('b2', 13, 14, esono, true),
    line('solo', 11, 12, { id: 2, name: 'Atelier' }, true),
  ]);
  assert.deepEqual(lines.map(one => one.id ?? `fold:${one.project.name}`), ['allday', 'fold:Esono', 'solo', 'late']);
  assert.equal(lines[1].minutes, 150);
  assert.deepEqual(lines[1].ids, ['b1', 'b2']);
});

test('a taller day holds more lines, and at least one', () => {
  assert.equal(linesThatFit(66), 2);
  assert.equal(linesThatFit(79), 2);
  assert.equal(linesThatFit(20), 1);
});
