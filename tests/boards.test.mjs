import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BOARDS, boardOf, freshId, normalise, screenOf,
} from '../src/boards.ts';
import {
  BOARD_COLUMNS, boardWidthCss, cellsAcross, defaultSize, nearestSize, sizeOf,
  widgetDef, widgetsOf,
} from '../src/widgets.ts';

/** A board whose widgets are given as bare names, sizes filled in. */
const board = (id, widgets = []) => ({
  id, name: id, icon: 'home',
  widgets: widgets.map(one => (typeof one === 'string' ? { kind: one, w: 0, h: 0 } : one)),
});

/* ── The one exception ─────────────────────────────────────────────────── */

test('home is a board, and keeps the screen name it has always had', () => {
  // ⚠️ The whole reason `screenOf` exists. Every preferences file already
  // written calls it `home` in railOrder, railHidden and railColours.
  assert.equal(screenOf(board('home')), 'home');
  assert.equal(screenOf(board('b2')), 'board:b2');
});

test('a screen name resolves back to its board, and nothing else does', () => {
  const boards = [board('home'), board('b2')];
  assert.equal(boardOf(boards, 'home')?.id, 'home');
  assert.equal(boardOf(boards, 'board:b2')?.id, 'b2');
  assert.equal(boardOf(boards, 'board:gone'), undefined);
  // A built-in screen is not a board, and must not be mistaken for one.
  assert.equal(boardOf(boards, 'today'), undefined);
  assert.equal(boardOf(boards, 'calendar'), undefined);
});

/* ── What comes off disk ───────────────────────────────────────────────── */

test('an empty list means the built-in board, not no boards', () => {
  // ⚠️ This is what `prefs.rs` stores by default, so it is the normal case
  // rather than a corrupt one: a fresh install must open onto Home.
  for (const nothing of [[], null, undefined, 'nonsense', 42]) {
    const out = normalise(nothing);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'home');
    assert.deepEqual(out[0].widgets, DEFAULT_BOARDS[0].widgets);
  }
});

test('the default board is copied, never handed out', () => {
  const first = normalise([]);
  first[0].widgets.push({ kind: 'clock', w: 1, h: 1 });
  // ⚠️ And DEEP: the entries carry a size, so a shallow copy would hand out
  // the very objects a resize writes through.
  first[0].widgets[0].w = 99;
  const again = normalise([]);
  assert.deepEqual(again[0].widgets.map(one => one.kind), ['media', 'calendar', 'today']);
  assert.equal(again[0].widgets[0].w, 2);
});

test('home is put back when a file does not have it', () => {
  const out = normalise([board('b2', ['clock'])]);
  assert.equal(out[0].id, 'home');
  assert.equal(out.length, 2);
});

test('a bad entry is dropped, and the rest survive', () => {
  const out = normalise([
    board('home'),
    null,
    'not a board',
    { id: '   ' },            // no id at all
    board('home', ['clock']), // a duplicate id
    board('b2', ['clock']),
  ]);
  assert.deepEqual(out.map(one => one.id), ['home', 'b2']);
  // ⚠️ The FIRST of two duplicate ids wins, so a file cannot silently
  // replace Home with something later in the list.
  assert.deepEqual(out[0].widgets, []);
});

test('a nameless board gets a name rather than a blank rail stop', () => {
  assert.equal(normalise([{ id: 'b2', name: '  ' }])[1].name, 'Board');
  assert.equal(normalise([{ id: 'b2' }])[1].name, 'Board');
});

test('a list of bare NAMES is read, which is what older files hold', () => {
  // ⚠️ Boards were a list of strings before widgets could be resized. A
  // name means "this widget at whatever size it asks for", which is a zero
  // here and filled in by `sizeOf` where the sizes are known.
  const out = normalise([{ id: 'home', widgets: ['media', 'clock'] }]);
  assert.deepEqual(out[0].widgets, [
    { kind: 'media', w: 0, h: 0 }, { kind: 'clock', w: 0, h: 0 },
  ]);
});

test('a sized entry is kept, and a nonsense one is dropped or clamped', () => {
  const out = normalise([{
    id: 'home',
    widgets: [
      { kind: 'media', w: 3, h: 1 },
      { kind: 'clock', w: 400, h: -2 },   // hand-edited nonsense
      { nope: 1 }, 7, null, 'today',
    ],
  }]);
  assert.deepEqual(out[0].widgets, [
    { kind: 'media', w: 3, h: 1 },
    // ⚠️ CLAMPED, not rejected: a `w` of 400 should be a wide widget, not a
    // board that fails to draw.
    { kind: 'clock', w: 6, h: 0 },
    { kind: 'today', w: 0, h: 0 },
  ]);
});

test('a fresh id avoids every one in use, including gaps', () => {
  assert.equal(freshId([board('home')]), 'b2');
  assert.equal(freshId([board('home'), board('b2')]), 'b3');
  // ⚠️ A gap is not filled — an id is never reused, so a board deleted and
  // another made cannot inherit the first one's rail colour or order.
  assert.equal(freshId([board('home'), board('b3')]), 'b2');
});

/* ── What a board is made of ───────────────────────────────────────────── */

const listed = (kinds) => widgetsOf(kinds.map(k => ({ kind: k, w: 0, h: 0 })));

test('a widget nothing knows about is dropped, not drawn as a hole', () => {
  assert.deepEqual(
    listed(['media', 'from-the-future', 'clock']).map(one => one.def.kind),
    ['media', 'clock'],
  );
});

test('a widget can only be on a board once', () => {
  assert.deepEqual(listed(['clock', 'clock', 'media']).map(one => one.def.kind),
    ['clock', 'media']);
});

test('a widget is drawn at a size it is allowed to be', () => {
  const media = widgetDef('media');
  // The first size listed is the default, and a zero means "ask the widget".
  assert.deepEqual(defaultSize(media), [2, 1]);
  assert.deepEqual(sizeOf(media, 0, 0), [2, 1]);
  // ⚠️ Anything stored is SNAPPED to a size the widget allows, so a
  // hand-edited file cannot produce a block the grid has no room for.
  assert.deepEqual(sizeOf(media, 3, 1), [3, 1]);
  assert.deepEqual(sizeOf(media, 2, 2), [2, 2]);
  assert.ok(media.sizes.some(([w, h]) => {
    const [gw, gh] = sizeOf(media, 9, 9);
    return w === gw && h === gh;
  }), 'nonsense still lands on a size the widget offers');
});

test('the nearest size jumps at the halfway point, and ties go smaller', () => {
  const clock = widgetDef('clock');   // 1x1, 2x1 — the simplest ladder there is
  assert.deepEqual(nearestSize(clock, 1, 1), [1, 1]);
  assert.deepEqual(nearestSize(clock, 2, 1), [2, 1]);
  // Anything past the end lands on the end.
  assert.deepEqual(nearestSize(clock, 9, 9), [2, 1]);
  assert.deepEqual(nearestSize(clock, 0, 0), [1, 1]);

  const weather = widgetDef('weather');
  assert.deepEqual(nearestSize(weather, 1, 1), [1, 1]);
  assert.deepEqual(nearestSize(weather, 2, 2), [2, 2]);
  /* ⚠️ A tie takes the SMALLER, so a drag that has not committed yet does
   * not grow the board under the pointer. */
  const tie = nearestSize(weather, 2, 1);
  assert.deepEqual(tie, [2, 1]);
});

test('a widget offers no size the grid cannot hold', () => {
  for (const def of [widgetDef('media'), widgetDef('calendar'), widgetDef('today')]) {
    for (const [w, h] of def.sizes) {
      assert.ok(w >= 1 && w <= BOARD_COLUMNS, `${def.kind} ${w}x${h} is too wide`);
      assert.ok(h >= 1 && h <= 3, `${def.kind} ${w}x${h} is too tall`);
    }
  }
});

test('how many cells across a board comes to, wrapping included', () => {
  const placed = (kinds) => widgetsOf(kinds.map(k => ({ kind: k, w: 0, h: 0 })));
  // Two two-wide blocks fit the four columns exactly.
  assert.equal(cellsAcross(placed(['media', 'calendar'])), 4);
  // One on its own is as wide as it is.
  assert.equal(cellsAcross(placed(['clock'])), 1);
  // ⚠️ Not the SUM: the grid wraps, so five blocks are still four across.
  assert.equal(
    cellsAcross(placed(['media', 'calendar', 'today', 'clock', 'weather'])),
    BOARD_COLUMNS);
});

test('a board is as wide as the cells it uses', () => {
  assert.ok(boardWidthCss(4) > boardWidthCss(2));
  assert.ok(boardWidthCss(2) > boardWidthCss(1));
  // ⚠️ Never wider than the grid: past four cells it wraps instead.
  assert.equal(boardWidthCss(9), boardWidthCss(BOARD_COLUMNS));
  // An empty board still asks for a panel worth looking at.
  assert.ok(boardWidthCss(0) > 0);
});
