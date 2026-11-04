import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polishLetter } from '../src/polish-keys.ts';

test('all nine letters, in both cases', () => {
  const keys = { KeyA: 'ą', KeyC: 'ć', KeyE: 'ę', KeyL: 'ł', KeyN: 'ń', KeyO: 'ó', KeyS: 'ś', KeyX: 'ź', KeyZ: 'ż' };
  for (const [code, letter] of Object.entries(keys)) {
    assert.equal(polishLetter(code, false), letter);
    assert.equal(polishLetter(code, true), letter.toUpperCase());
  }
});

test('other keys are left alone', () => {
  assert.equal(polishLetter('KeyQ', false), null);
  assert.equal(polishLetter('Digit1', false), null);
});
