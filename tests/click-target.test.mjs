import { test } from 'node:test';
import assert from 'node:assert/strict';
import { momentOpens, momentTarget, peekTarget } from '../src/click-target.ts';

const peek = (kind, id = `${kind}:x`) => peekTarget({ kind, id });
const helm = (kind, id) => ({ kind: 'helm', key: `helm:${id}`, helm: { kind, id } });

test('a peek opens the screen it is about', () => {
  assert.deepEqual(peek('music'), { screen: 'media' });
  for (const kind of ['volume', 'buds', 'mic', 'power']) assert.deepEqual(peek(kind), { screen: 'system' });
  for (const kind of ['block', 'focus', 'paid', 'logged']) assert.deepEqual(peek(kind), { screen: 'helm' });
  assert.deepEqual(peek('timer'), { screen: 'timer' });
  assert.deepEqual(peek('pc'), { screen: 'guardian' });
});

test('a meeting or a leave-now peek opens that event', () => {
  assert.deepEqual(peek('meeting', 'meeting:abc123'), { screen: 'calendar', event: 'abc123' });
  assert.deepEqual(peek('leave', 'leave:abc123'), { screen: 'calendar', event: 'abc123' });
});

test('what has no screen here goes nowhere, rather than to the last screen', () => {
  for (const kind of ['gabi', 'mail', 'download', 'screenshot']) assert.equal(peek(kind), null);
});

test("Helm's prep and wrap open that event, with the calendar's name still on the id", () => {
  assert.deepEqual(momentTarget(helm('prep', 'prep:work:ev1')), { screen: 'calendar', event: 'work:ev1' });
  assert.deepEqual(momentTarget(helm('wrap', 'wrap:work:ev1')), { screen: 'calendar', event: 'work:ev1' });
  assert.deepEqual(momentTarget(helm('drift', 'drift:2:over')), { screen: 'helm' });
});

test('a payment, a request, mail and a reminder stay up with their buttons', () => {
  for (const [kind, id] of [['remind', 'remind:7'], ['request', 'request:9'], ['request', 'mail:4'], ['remind', 'rem:1@2'], ['remind', 'car:1@2026-11-04']]) {
    const m = helm(kind, id);
    assert.equal(momentTarget(m), null, id);
    assert.equal(momentOpens(m), false, id);
  }
});

test("this side's moments", () => {
  assert.deepEqual(momentTarget({ kind: 'meeting', key: 'meeting:ev1:2026-11-04T10:00:00Z' }), { screen: 'calendar', event: 'ev1' });
  assert.deepEqual(momentTarget({ kind: 'usage', key: 'usage:1' }), { screen: 'agents' });
  assert.deepEqual(momentTarget({ kind: 'nudge', key: 'nudge:1' }), { screen: 'guardian' });
  assert.deepEqual(momentTarget({ kind: 'block', key: 'block:1' }), { screen: 'helm' });
});

test('hers stay; an agent and closing the day open without a screen', () => {
  assert.equal(momentOpens({ kind: 'gabi', key: 'gabi:1' }), false);
  assert.equal(momentOpens({ kind: 'finished', key: 'finished:s' }), true);
  assert.equal(momentOpens({ kind: 'question', key: 'question:s' }), true);
  assert.equal(momentOpens(helm('close', 'close:2026-11-04')), true);
});
