import { test } from 'node:test';
import assert from 'node:assert/strict';
/* ⚠️ The ARITHMETIC, not the gesture. Pointer capture and a real drag need a
 * browser; where a drag LANDS is in `calendar-axis` and tested there. What is
 * left here is turning an hour into a date, which is the part that has
 * actually been wrong in calendars before. */
import { atHour, columnAt, edgeStep, gestureSpan, hourAtPoint, hoursWithin, layoutLanes } from '../src/calendar-edit.ts';
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

const origin = { column: 1, start: 9, end: 10.5 };

test('a move keeps the length and follows the pointer across days', () => {
  const span = gestureSpan('move', origin, 0.5, { column: 4, hour: 14 });
  assert.deepEqual(span, { column: 4, start: 13.5, end: 15 });
});

test('a move stops at either end of the day with its length intact', () => {
  assert.deepEqual(gestureSpan('move', origin, 0, { column: 1, hour: 23.5 }), { column: 1, start: 22.5, end: 24 });
  assert.deepEqual(gestureSpan('move', origin, 0.5, { column: 1, hour: 0 }), { column: 1, start: 0, end: 1.5 });
});

test('a move lands on quarters, even from an event that does not start on one', () => {
  const span = gestureSpan('move', { column: 0, start: 9.1, end: 10.1 }, 0.1, { column: 0, hour: 12 });
  assert.equal(span.start % 0.25, 0);
});

test('each edge moves only its own end, and they cannot cross', () => {
  assert.deepEqual(gestureSpan('resize-start', origin, 0, { column: 5, hour: 8 }), { column: 1, start: 8, end: 10.5 });
  assert.deepEqual(gestureSpan('resize-end', origin, 0, { column: 5, hour: 12 }), { column: 1, start: 9, end: 12 });
  assert.deepEqual(gestureSpan('resize-start', origin, 0, { column: 1, hour: 11 }), { column: 1, start: 10.25, end: 10.5 });
  assert.deepEqual(gestureSpan('resize-end', origin, 0, { column: 1, hour: 7 }), { column: 1, start: 9, end: 9.25 });
});

test('drawing works up and down, in its own column', () => {
  const pressed = { column: 2, start: 10, end: 10.5 };
  assert.deepEqual(gestureSpan('create', pressed, 10, { column: 6, hour: 12 }), { column: 2, start: 10, end: 12 });
  assert.deepEqual(gestureSpan('create', pressed, 10, { column: 2, hour: 8 }), { column: 2, start: 8, end: 10.25 });
  assert.deepEqual(gestureSpan('create', pressed, 10, { column: 2, hour: 10 }), { column: 2, start: 10, end: 10.25 });
});

test('a meeting ending at midnight lasts until 24, not 15 minutes', () => {
  const day = (d, h, m = 0) => new Date(2026, 10, d, h, m);
  assert.deepEqual(hoursWithin(day(4, 23), day(5, 0)), { start: 23, end: 24, crosses: false });
  assert.deepEqual(hoursWithin(day(4, 22), day(5, 1)), { start: 22, end: 24, crosses: true });
  assert.deepEqual(hoursWithin(day(4, 9), day(4, 10, 30)), { start: 9, end: 10.5, crosses: false });
  // A task that is a moment still gets something to hold.
  assert.equal(hoursWithin(day(4, 9), day(4, 9)).end, 9.25);
});

test('the column under a point, and the nearest off the side or in a gap', () => {
  const boxes = [{ left: 0, right: 100 }, { left: 103, right: 200 }];
  assert.equal(columnAt(boxes, 50), 0);
  assert.equal(columnAt(boxes, 150), 1);
  assert.equal(columnAt(boxes, 102), 1);
  assert.equal(columnAt(boxes, -40), 0);
  assert.equal(columnAt(boxes, 900), 1);
});

test('the grid scrolls near its edges, faster the closer', () => {
  assert.equal(edgeStep(300, 100, 500), 0);
  assert.ok(edgeStep(110, 100, 500) < 0);
  assert.ok(edgeStep(490, 100, 500) > 0);
  assert.ok(edgeStep(499, 100, 500) > edgeStep(470, 100, 500));
  // Past the edge is the fastest, not faster still.
  assert.equal(edgeStep(9000, 100, 500), edgeStep(500, 100, 500));
});

test('overlaps get lanes, and a clear gap starts again', () => {
  const lanes = layoutLanes([
    { top: 0, bottom: 40 },
    { top: 0, bottom: 40 },
    { top: 100, bottom: 140 },
  ]);
  assert.deepEqual(lanes, [{ lane: 0, lanes: 2 }, { lane: 1, lanes: 2 }, { lane: 0, lanes: 1 }]);
});

test('a chain shares one width, and a free lane is reused', () => {
  const lanes = layoutLanes([
    { top: 0, bottom: 40 },
    { top: 20, bottom: 60 },
    { top: 45, bottom: 80 },
  ]);
  assert.equal(lanes[0].lanes, 2);
  assert.equal(lanes[1].lanes, 2);
  assert.equal(lanes[2].lanes, 2);
  assert.equal(lanes[2].lane, 0);
});

test('touching is not overlapping', () => {
  assert.deepEqual(layoutLanes([{ top: 0, bottom: 40 }, { top: 40, bottom: 80 }]),
    [{ lane: 0, lanes: 1 }, { lane: 0, lanes: 1 }]);
});

test('a block stops growing at its longest, from either edge', () => {
  const block = { column: 0, start: 9, end: 10 };
  assert.equal(gestureSpan('resize-end', block, 0, { column: 0, hour: 20 }, 3).end, 12);
  assert.equal(gestureSpan('resize-start', block, 0, { column: 0, hour: 1 }, 3).start, 7);
  // A meeting has no such limit.
  assert.equal(gestureSpan('resize-end', block, 0, { column: 0, hour: 20 }).end, 20);
});
