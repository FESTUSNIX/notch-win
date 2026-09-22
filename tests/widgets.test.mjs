import { test } from 'node:test';
import assert from 'node:assert/strict';
/* ⚠️ Everything from `widgets.ts`, which has no runtime imports — node
 * strips types and then resolves what is left, and `widget-bodies.ts` reaches
 * for `./dom`, which its resolver cannot find. That split is why the decisions
 * live here and the drawing lives there. */
import {
  WIDGETS, defaultVariant, mediaLayout, variantOf, variantsOf, weatherParts,
  widgetDef,
} from '../src/widgets.ts';

/* ── Variants ──────────────────────────────────────────────────────────── */

test('a widget with one shape offers no variants at all', () => {
  // ⚠️ The control only appears past two, so a widget with none must report
  // none rather than a list of one — a picker with a single option is a label.
  for (const kind of ['clock', 'shelf', 'system', 'agents', 'notes', 'today']) {
    assert.deepEqual(variantsOf(widgetDef(kind)), [], kind);
    assert.equal(defaultVariant(widgetDef(kind)), '', kind);
  }
});

test('the first variant listed is the default', () => {
  assert.equal(defaultVariant(widgetDef('calendar')), 'week');
  assert.equal(defaultVariant(widgetDef('weather')), 'now');
  assert.equal(defaultVariant(widgetDef('timer')), 'ring');
  assert.equal(defaultVariant(widgetDef('media')), 'bar');
});

test('an unknown variant falls back rather than drawing nothing', () => {
  const cal = widgetDef('calendar');
  assert.equal(variantOf(cal, 'month'), 'month');
  /* ⚠️ A variant that has been renamed or withdrawn is exactly the kind of
   * thing a preferences file outlives, and a block that rendered empty because
   * of it would be a bug with no visible cause. */
  assert.equal(variantOf(cal, 'fortnight'), 'week');
  assert.equal(variantOf(cal, ''), 'week');
  assert.equal(variantOf(cal, undefined), 'week');
});

test('every variant has an id and a label, and no widget repeats one', () => {
  for (const def of WIDGETS) {
    const seen = new Set();
    for (const one of variantsOf(def)) {
      assert.ok(one.id, `${def.kind} has a variant with no id`);
      assert.ok(one.label, `${def.kind}:${one.id} has no label`);
      assert.ok(!seen.has(one.id), `${def.kind} lists ${one.id} twice`);
      seen.add(one.id);
    }
  }
});

/* ── What fits in the weather block ────────────────────────────────────── */

const both = { hours: true, days: true };

test('"now" is the head and nothing else, at any size', () => {
  for (const [w, h] of [[1, 1], [2, 1], [3, 2], [6, 2]]) {
    assert.deepEqual(weatherParts('now', w, h, both),
      { head: true, hours: false, days: false }, `${w}x${h}`);
  }
});

test('the hours and the days are different answers, not more of each other', () => {
  /* ⚠️ "Forecast" used to mean whichever of the two happened to fit, which
   * is the thing a variant exists to stop: the next few hours is what to
   * expect this afternoon and the next few days is what to expect this week. */
  assert.deepEqual(weatherParts('hours', 2, 1, both),
    { head: false, hours: true, days: false });
  assert.deepEqual(weatherParts('days', 2, 1, both),
    { head: false, hours: false, days: true });
  // And the days do NOT need a second row when they are the whole block.
  assert.deepEqual(weatherParts('days', 3, 1, both),
    { head: false, hours: false, days: true });
});

test('the size wins where it disagrees with the variant', () => {
  // ⚠️ One cell has no room for a strip of hours, whatever was asked for.
  assert.deepEqual(weatherParts('hours', 1, 1, both),
    { head: true, hours: false, days: false });
  assert.deepEqual(weatherParts('days', 1, 2, both),
    { head: true, hours: false, days: false });
});

test('"everything" keeps the head and adds what is left of the room', () => {
  assert.deepEqual(weatherParts('full', 1, 1, both),
    { head: true, hours: false, days: false });
  // Short: the hours, because the days are what height is for.
  assert.deepEqual(weatherParts('full', 2, 1, both),
    { head: true, hours: true, days: false });
  assert.deepEqual(weatherParts('full', 3, 2, both),
    { head: true, hours: true, days: true });
});

test('a forecast that has not arrived shows the head, not an empty block', () => {
  /* ⚠️ A cold start has a temperature and no forecast for the first poll or
   * two. A block asked for one has to fall back to the reading it does have —
   * an empty card reads as a failure, and this is a state every install passes
   * through. */
  const none = { hours: false, days: false };
  assert.deepEqual(weatherParts('hours', 3, 2, none),
    { head: true, hours: false, days: false });
  assert.deepEqual(weatherParts('days', 3, 2, none),
    { head: true, hours: false, days: false });
  assert.deepEqual(weatherParts('full', 3, 2, none),
    { head: true, hours: false, days: false });
  // Hours but no days yet: the hours show and the head gets out of the way.
  assert.deepEqual(weatherParts('hours', 3, 2, { hours: true, days: false }),
    { head: false, hours: true, days: false });
});

test('the block is never empty, whatever it is asked for', () => {
  for (const variant of ['now', 'hours', 'days', 'full', 'nonsense']) {
    for (const [w, h] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 2], [6, 1]]) {
      for (const has of [both, { hours: false, days: false }, { hours: true, days: false }]) {
        const parts = weatherParts(variant, w, h, has);
        assert.ok(parts.head || parts.hours || parts.days,
          `${variant} ${w}x${h} ${JSON.stringify(has)} drew nothing`);
      }
    }
  }
});

/* ── How a track is laid out ──────────────────────────────────── */

test('one cell is the cover, whatever was asked for', () => {
  /* ⚠️ A row needs somewhere to put the words beside the cover and a column
   * needs somewhere to put them under it. One cell has neither — and the cover
   * is a good answer at every size, which is why it is what the fallback falls
   * back TO. */
  for (const variant of ['bar', 'stack', 'cover']) {
    assert.equal(mediaLayout(variant, 1, 1), 'cover', variant);
    assert.equal(mediaLayout(variant, 1, 2), 'cover', variant);
  }
});

test('a column needs a second row to be one', () => {
  // Asked for a column in a block one row tall, it is a row.
  assert.equal(mediaLayout('stack', 2, 1), 'bar');
  assert.equal(mediaLayout('stack', 2, 2), 'stack');
  assert.equal(mediaLayout('stack', 3, 2), 'stack');
});

test('the cover is offered at every size, and the row is the default', () => {
  assert.equal(mediaLayout('cover', 4, 1), 'cover');
  assert.equal(mediaLayout('cover', 2, 2), 'cover');
  assert.equal(mediaLayout('bar', 4, 1), 'bar');
  assert.equal(mediaLayout('bar', 2, 2), 'bar');
  // Anything a preferences file names that no longer exists reads as the row.
  assert.equal(mediaLayout('nonsense', 3, 1), 'bar');
});
