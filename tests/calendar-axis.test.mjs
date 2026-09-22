import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAxis, busyHours, quietHours, QUIET_BEFORE, QUIET_FROM } from '../src/calendar-axis.ts';

/** The default shape: 7..19 open at 34px, the rest collapsed at 14. */
const usual = () => buildAxis(quietHours(new Set(), new Set()), 34, 14);

test('the axis is as tall as its hours add up to', () => {
  const axis = usual();
  const open = 24 - QUIET_BEFORE - (24 - QUIET_FROM);
  assert.equal(open, 13, 'seven to eight is thirteen hours');
  assert.equal(axis.height, 13 * 34 + 11 * 14);
});

test('an open hour maps to a position inside itself', () => {
  const axis = usual();
  // 07:00 sits directly after seven collapsed hours.
  assert.equal(axis.yOf(7), 7 * 14);
  assert.equal(axis.yOf(8), 7 * 14 + 34);
  assert.equal(axis.yOf(7.5), 7 * 14 + 17);
});

test('round trip: a position resolves to the hour it was made from', () => {
  const axis = usual();
  for (const hour of [7, 7.25, 9.5, 12, 15.75, 19.5]) {
    assert.equal(axis.hourAt(axis.yOf(hour)), hour, String(hour));
  }
});

test('a fraction inside a collapsed hour is the hour itself', () => {
  /* ⚠️ 14px cannot hold four quarters anybody can aim at, and pretending it
   * can puts two different times on the same pixel. */
  const axis = usual();
  assert.equal(axis.yOf(3.5), axis.yOf(3));
  assert.equal(axis.hourAt(axis.yOf(3) + 6), 3);
});

test('the ends are clamped rather than running off', () => {
  const axis = usual();
  assert.equal(axis.yOf(-4), 0);
  assert.equal(axis.yOf(99), axis.height);
  assert.equal(axis.hourAt(-10), 0);
  assert.equal(axis.hourAt(axis.height + 10), 24);
});

test('collapsed hours come back as two bands, not eleven', () => {
  const axis = usual();
  const bands = axis.bands();
  assert.equal(bands.length, 2);
  assert.deepEqual([bands[0].from, bands[0].to], [0, 7]);
  assert.deepEqual([bands[1].from, bands[1].to], [20, 24]);
  assert.equal(bands[0].px, 7 * 14);
  assert.equal(bands[1].px, 4 * 14);
});

test('an hour with something in it is never collapsed', () => {
  /* ⚠️ The rule that stops collapsing from hiding a meeting. A 06:30 run and
   * a 21:00 dinner hold their own hours open and the band closes around. */
  const busy = busyHours([{ start: 6.5, end: 7.5 }, { start: 21, end: 22 }]);
  const axis = buildAxis(quietHours(busy, new Set()), 34, 14);
  assert.ok(axis.rows[6].open, '06:00 holds the run');
  assert.ok(!axis.rows[5].open, '05:00 is still quiet');
  assert.ok(axis.rows[21].open, '21:00 holds the dinner');
  assert.ok(!axis.rows[22].open, '22:00 is still quiet');
});

test('a meeting ending on the hour does not hold the next one open', () => {
  // 09:00–10:00 occupies 9 and not 10.
  const busy = busyHours([{ start: 9, end: 10 }]);
  assert.deepEqual([...busy], [9]);
  // And a 19:00 call must not open the whole evening.
  assert.deepEqual([...busyHours([{ start: 19, end: 20 }])], [19]);
});

test('opening a run by hand opens all of it', () => {
  const axis = buildAxis(quietHours(new Set(), new Set(['early'])), 34, 14);
  for (let hour = 0; hour < QUIET_BEFORE; hour++) assert.ok(axis.rows[hour].open, String(hour));
  assert.ok(!axis.rows[QUIET_FROM].open, 'the late band is untouched');
  assert.equal(axis.bands().length, 1);
});

test('everything open is a plain linear axis again', () => {
  const axis = buildAxis(() => true, 34, 14);
  assert.equal(axis.height, 24 * 34);
  assert.equal(axis.yOf(12), 12 * 34);
  assert.equal(axis.bands().length, 0);
});

test('an empty span list collapses nothing extra', () => {
  assert.equal(busyHours([]).size, 0);
});

test('a short run of collapsed hours is grown to stay clickable', () => {
  /* ⚠️ The floor is on the RUN, not the hour. A lone collapsed hour at 6px is
   * a line nobody can hit; the seven-hour night beside it must stay a strip. */
  const busy = new Set([21]);               // splits the late band into 20 and 22–23
  const axis = buildAxis(quietHours(busy, new Set()), 40, 6);
  const [night, before, after] = axis.bands();
  assert.deepEqual([night.from, night.to], [0, 7]);
  assert.equal(night.px, 7 * 6, 'seven hours already clear the floor');
  assert.deepEqual([before.from, before.to], [20, 21]);
  assert.ok(before.px >= 24, `a lone hour is grown: ${before.px}`);
  assert.deepEqual([after.from, after.to], [22, 24]);
  assert.ok(after.px >= 24, `a two-hour run is grown: ${after.px}`);
});

test('growing a band moves everything after it, and the axis still round-trips', () => {
  /* ⚠️ The bug this guards: heights and positions assigned in one pass put the
   * bands in the right place and every hour after them wrong. */
  const axis = buildAxis(quietHours(new Set([21]), new Set()), 40, 6);
  for (const hour of [7, 9.5, 12, 19.75, 21, 21.5]) {
    assert.equal(axis.hourAt(axis.yOf(hour)), hour, String(hour));
  }
  assert.equal(axis.height, axis.rows.reduce((n, r) => n + r.px, 0));
});
