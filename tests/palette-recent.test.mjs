import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recent } from '../src/palette-recent.ts';

const DAY = 24 * 60 * 60 * 1000;

function fake() {
  const held = new Map();
  return {
    getItem: k => held.get(k) ?? null,
    setItem: (k, v) => held.set(k, v),
    held,
  };
}

test('what was just run outranks what was run last week', () => {
  let now = 1_000_000_000_000;
  const recent = new Recent(fake(), () => now);
  recent.record('go:agents');
  now += 9 * DAY;
  recent.record('go:today');
  assert.ok(recent.boost('go:today') > recent.boost('go:agents'));
  // ⚠️ Recency, not frequency: a count never forgets, so twenty runs last month
  // would outrank what you have been doing all morning, for ever.
  assert.ok(recent.boost('go:agents') < 5);
});

test('something never run is not penalised, it just scores nothing', () => {
  const recent = new Recent(fake(), () => 1e12);
  assert.equal(recent.boost('go:shelf'), 0);
});

test('it survives a restart, and an unreadable store is simply an empty one', () => {
  const store = fake();
  const now = () => 1e12;
  new Recent(store, now).record('go:media');
  assert.ok(new Recent(store, now).boost('go:media') > 30);

  const broken = {getItem: () => { throw new Error('site data blocked'); },
                  setItem: () => { throw new Error('site data blocked'); }};
  // ⚠️ localStorage does not merely come back empty in a private window — the
  // accessor throws, and an exception here would take the palette down.
  const safe = new Recent(broken, now);
  safe.record('go:home');
  assert.equal(safe.boost('go:home'), 34);
});

test('it keeps a bounded list and drops the oldest, so dead ids do not pile up', () => {
  let now = 1e12;
  const store = fake();
  const recent = new Recent(store, () => now);
  for (let i = 0; i < 200; i++) { recent.record(`task:${i}`); now += 1000; }
  // ⚠️ 120, raised from 40 once file hits started being learned from: a path is
  // a stable id, and forty entries is an afternoon of them — the screens and
  // commands were being evicted by the files.
  assert.equal(Object.keys(JSON.parse(store.held.get('codenotch.palette.recent'))).length, 120);
  // The ids a finished task or a dead session left behind are the ones to lose.
  assert.equal(recent.boost('task:0'), 0);
  assert.ok(recent.boost('task:199') > 30);
});
