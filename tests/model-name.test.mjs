import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelName } from '../src/model-name.ts';

test('a Claude id becomes what people call it', () => {
  assert.equal(modelName('claude-opus-5'), 'Opus 5');
  // ⚠️ The build date is not part of the name. Left in, every Claude row on
  // the screen ends in eight digits nobody reads.
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  // ⚠️ And the version sits on the OTHER side in the older ids, which is why
  // the digits are collected wherever they fall rather than sliced off an end.
  assert.equal(modelName('claude-3-5-haiku-20241022'), 'Haiku 3.5');
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
});

test('an OpenAI id keeps the number attached to the name', () => {
  // "GPT 6 Astra" reads as three things; the hyphen is part of the product.
  assert.equal(modelName('gpt-6-astra'), 'GPT-6 Astra');
  assert.equal(modelName('gpt-5.1-codex-max'), 'GPT-5.1 Codex Max');
});

test('an id nothing knows about is tidied, never blanked', () => {
  /* ⚠️ A lookup table would return nothing here, and nothing is what a card
   * shows the week a model ships — the one week somebody actually wants to
   * know which one is answering. */
  assert.equal(modelName('llama-4-scout'), 'Llama 4 Scout');
  assert.equal(modelName('some_new_thing'), 'Some New Thing');
});

test('no model is an empty string, not the word undefined', () => {
  assert.equal(modelName(undefined), '');
  assert.equal(modelName(null), '');
  assert.equal(modelName(''), '');
});
