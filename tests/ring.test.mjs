import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REACH, INNER, MIDDLE, MOST, OUTER, aiming, at, ringStops, sector, spanOf,
} from '../src/ring-geometry.ts';
import { SCREENS } from '../src/screens.ts';

const nowhere = { railOrder: [], railHidden: [] };

test('the first segment is centred at the top, not started there', () => {
  /* ⚠️ Straight up is the one direction a hand finds without looking, so the
   * first screen has to straddle it rather than begin at it. */
  const first = spanOf(0, 8);
  assert.equal(first.from, -1 / 16);
  assert.equal(first.to, 1 / 16);
  // And the segments tile the ring exactly, with no gap and no overlap.
  for (let count = 1; count <= MOST; count++) {
    let edge = spanOf(0, count).from;
    for (let index = 0; index < count; index++) {
      const span = spanOf(index, count);
      // A tolerance, not equality: thirds do not survive binary floating point,
      // and a segment edge that is out by 1e-16 is out by nothing.
      assert.ok(Math.abs(span.from - edge) < 1e-9, `${count} segments, ${index}`);
      edge = span.to;
    }
    assert.ok(Math.abs(edge - (spanOf(0, count).from + 1)) < 1e-9, `${count} does not close`);
  }
});

test('a segment past half the ring sets the large-arc flag', () => {
  /* ⚠️ Without it the arc draws the SHORT way round — a shape that is still
   * clickable and completely wrong, which is the worst kind. A ring of one is
   * what gets you there: one screen showing means one 360° segment. */
  assert.match(sector(0, 0.75), /A132 132 0 1 1/);
  assert.match(sector(0, 0.125), /A132 132 0 0 1/);
  // Exactly half is not past half.
  assert.match(sector(0, 0.5), /A132 132 0 0 1/);
});

test('straight up is the top of the screen, and the turn goes clockwise', () => {
  const top = at(0, OUTER);
  assert.ok(Math.abs(top.x - MIDDLE) < 1e-9);
  assert.equal(top.y, MIDDLE - OUTER);
  const right = at(0.25, OUTER);
  assert.equal(Math.round(right.x), MIDDLE + OUTER);
  assert.ok(Math.abs(right.y - MIDDLE) < 1e-9);
});

test('aiming reads the angle, so the labels are not dead ground', () => {
  const count = 8;
  // Straight up, out where the LABEL is drawn — still segment 0.
  assert.equal(aiming(MIDDLE, MIDDLE - REACH, count), 0);
  // Over the glyph of segment 0.
  assert.equal(aiming(MIDDLE, MIDDLE - (INNER + OUTER) / 2, count), 0);
  // Clockwise one segment.
  const per = 1 / count;
  const next = at(per, (INNER + OUTER) / 2);
  assert.equal(aiming(next.x, next.y, count), 1);
  // And the last one, just anticlockwise of the top.
  const last = at(-per, (INNER + OUTER) / 2);
  assert.equal(aiming(last.x, last.y, count), count - 1);
});

test('the middle is the search, and beyond the labels is nothing', () => {
  assert.equal(aiming(MIDDLE, MIDDLE, 8), 'search');
  assert.equal(aiming(MIDDLE, MIDDLE - (INNER - 12), 8), 'search');
  /* ⚠️ Null rather than a nearest guess. The window is a square holding a
   * circle, so its corners are part of it — and a click there means "put this
   * away", not "I meant the screen closest to my mistake". */
  assert.equal(aiming(0, 0, 8), null);
  assert.equal(aiming(MIDDLE, MIDDLE - (REACH + 40), 8), null);
  assert.equal(aiming(MIDDLE, MIDDLE - OUTER, 0), null, 'no segments, nothing to aim at');
});

test('what you aim at is the wedge you are pointing at', () => {
  /* ⚠️ The aim has to agree with the DRAWING, and this is the test that says
   * so — by sampling just inside each wedge's own two edges rather than at its
   * middle.
   *
   * The first version of this file sampled centres only, and a centre maps to
   * the same index whether or not the half-segment offset is there: the bug it
   * was written to catch (aim regions rotated half a segment off the wedges,
   * so the right-hand half of every wedge selects its neighbour) passed every
   * assertion in this file. Sampling the edges is what catches it, because an
   * edge is exactly where the two conventions disagree. */
  for (const count of [1, 3, 5, 8]) {
    for (let index = 0; index < count; index++) {
      const span = spanOf(index, count);
      const inset = (span.to - span.from) * 0.02;
      for (const turn of [span.from + inset, (span.from + span.to) / 2, span.to - inset]) {
        const point = at(turn, (INNER + OUTER) / 2);
        assert.equal(
          aiming(point.x, point.y, count), index,
          `${count} segments: turn ${turn.toFixed(4)} is not segment ${index}`,
        );
      }
    }
  }
});

test('every segment of a full ring is reachable, and owns its own share', () => {
  for (const count of [3, 5, 8]) {
    const seen = new Map();
    for (let degree = 0; degree < 360; degree++) {
      const point = at(degree / 360, (INNER + OUTER) / 2);
      const found = aiming(point.x, point.y, count);
      seen.set(found, (seen.get(found) ?? 0) + 1);
    }
    assert.equal(seen.size, count, `${count} segments, ${seen.size} reachable`);
    for (const [index, degrees] of seen) {
      assert.ok(typeof index === 'number', `${index} is not a segment`);
      assert.ok(Math.abs(degrees - 360 / count) <= 1, `segment ${index} owns ${degrees}°`);
    }
  }
});

test('the ring holds eight at most, in the rail order, and always Home', () => {
  const all = ringStops(nowhere, SCREENS);
  assert.equal(all.length, MOST);
  assert.equal(all[0].id, 'home');

  // The saved order leads, and what it has not heard of keeps its own place.
  const mine = ringStops({ railOrder: ['notes', 'today'], railHidden: [] }, SCREENS);
  assert.deepEqual(mine.slice(0, 2).map(s => s.id), ['notes', 'today']);

  // Hidden screens are not offered...
  const fewer = ringStops({ railOrder: [], railHidden: ['today', 'media', 'agents'] }, SCREENS);
  assert.ok(!fewer.some(s => s.id === 'today'));
  // ...except Home, which cannot be hidden anywhere else either.
  const stubborn = ringStops({ railOrder: [], railHidden: ['home'] }, SCREENS);
  assert.ok(stubborn.some(s => s.id === 'home'));
});

test('a chosen ring wins outright, and is not filtered by the rail', () => {
  /* ⚠️ Not filtered by `railHidden`: putting something on the ring IS the
   * decision, and a screen taken OFF the rail is exactly the kind of thing
   * somebody would then want here. */
  const mine = ringStops(
    { railOrder: [], railHidden: ['notes', 'system'], ringStops: ['notes', 'act:note', 'system'] },
    SCREENS);
  assert.deepEqual(mine.map(s => s.id), ['notes', 'act:note', 'system']);
  // A verb carries its own label and glyph, like a screen does.
  assert.equal(mine[1].label, 'Write a note');
  assert.ok(mine[1].icon);
});

test('a chosen ring is still capped, and ignores what it does not know', () => {
  const many = ringStops({ railOrder: [], railHidden: [], ringStops:
    ['home', 'today', 'notes', 'shelf', 'agents', 'calendar', 'review', 'system', 'media'] },
    SCREENS);
  assert.equal(many.length, MOST, 'past eight a wedge is thinner than a hand is accurate');

  /* ⚠️ A name from a version that had a screen this one does not is
   * DROPPED, not drawn as an empty wedge — and it must not shift everything
   * after it round the ring either, which is what aiming depends on. */
  const stale = ringStops({ railOrder: [], railHidden: [], ringStops:
    ['home', 'sideboard', 'act:task'] }, SCREENS);
  assert.deepEqual(stale.map(s => s.id), ['home', 'act:task']);
});

test('an empty choice means the rail, not an empty ring', () => {
  /* ⚠️ "Unset" and "deliberately empty" have to be different answers, and
   * the second one is not offered: a preference nobody has touched must not
   * leave the key opening a ring with nothing in it. */
  assert.equal(ringStops({ railOrder: [], railHidden: [], ringStops: [] }, SCREENS).length, MOST);
  assert.equal(ringStops({ railOrder: [], railHidden: [] }, SCREENS).length, MOST);
});
