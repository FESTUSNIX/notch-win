import { test } from 'node:test';
import assert from 'node:assert/strict';
/* ⚠️ The ARITHMETIC, not the gesture. Pointer capture and a real drag need a
 * browser; where a drag LANDS is in `calendar-axis` and tested there. What is
 * left here is turning an hour into a date, which is the part that has
 * actually been wrong in calendars before. */
import { atHour, hourAtPoint } from '../src/calendar-edit.ts';
import { buildAxis, quietHours } from '../src/calendar-axis.ts';

test('an hour with a fraction becomes a local time, not a UTC one', () => {
  /* ⚠️ The bug this guards: `new Date("2026-09-22T09:30")` is local in modern
   * engines and UTC in older ones, so a meeting drawn at half nine could be
   * stored an hour out. Built field by field, it is local by construction. */
  const when = atHour('2026-09-22', 9.5);
  assert.equal(when.getFullYear(), 2026);
  assert.equal(when.getMonth(), 8, 'September is month 8');
  assert.equal(when.getDate(), 22);
  assert.equal(when.getHours(), 9);
  assert.equal(when.getMinutes(), 30);
  assert.equal(when.getSeconds(), 0);
  assert.equal(when.getMilliseconds(), 0);
});

test('a quarter past is 15 minutes, not 14 or 16', () => {
  // 0.25 * 60 is exact, but 0.75 and 0.05 are not — hence the rounding.
  assert.equal(atHour('2026-09-22', 13.25).getMinutes(), 15);
  assert.equal(atHour('2026-09-22', 13.75).getMinutes(), 45);
});

test('midnight and the end of the day are both representable', () => {
  const start = atHour('2026-09-22', 0);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getDate(), 22);
  /* 24 rolls into the next day, which is what an event ending at midnight
   * means — and is why the caller clamps to it rather than past it. */
  const end = atHour('2026-09-22', 24);
  assert.equal(end.getDate(), 23);
  assert.equal(end.getHours(), 0);
});

test('a point in a column reads through the axis, collapsed bands and all', () => {
  const axis = buildAxis(quietHours(new Set(), new Set()), 40, 13);
  const box = { top: 100 };
  // The top of the column is midnight, folded into the early band.
  assert.equal(hourAtPoint(100, box, axis), 0);
  // 07:00 is directly after seven collapsed hours.
  assert.equal(hourAtPoint(100 + 7 * 13, box, axis), 7);
  // And half an open hour in is half past.
  assert.equal(hourAtPoint(100 + 7 * 13 + 20, box, axis), 7.5);
});
