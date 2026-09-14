import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, held } from '../src/media-format.ts';

test('tokens are read at a glance or not at all', () => {
  assert.equal(tokens(900), '900');
  assert.equal(tokens(48_200), '48k');
  assert.equal(tokens(1_284_000), '1.3M');
  // Past ten million the decimal is noise, not precision.
  assert.equal(tokens(12_400_000), '12M');
});

test('how long a session has been held is said briefly', () => {
  assert.equal(held(40), '40s');
  assert.equal(held(214), '3m');
  assert.equal(held(9_400), '2h');
  // A session left open since yesterday is not "31h".
  assert.equal(held(200_000), '2d');
});
