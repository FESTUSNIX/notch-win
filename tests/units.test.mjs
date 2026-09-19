import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertUnits, parseUnits, sayMeasure, sayUnit } from '../src/units.ts';

const value = (said) => {
  const measure = parseUnits(said);
  assert.ok(measure, `should parse: ${said}`);
  const out = convertUnits(measure);
  assert.ok(out !== null, `should convert: ${said}`);
  return out;
};

test('a measurement is an amount and two units, however they are typed', () => {
  assert.deepEqual(parseUnits('70 kg to lb'), { amount: 70, from: 'kg', to: 'lb' });
  assert.deepEqual(parseUnits('70kg lb'), { amount: 70, from: 'kg', to: 'lb' });
  assert.deepEqual(parseUnits('12ft in m'), { amount: 12, from: 'ft', to: 'm' });
  assert.deepEqual(parseUnits('220°F to C'), { amount: 220, from: 'f', to: 'c' });
  assert.deepEqual(parseUnits('1.5 GB in MiB'), { amount: 1.5, from: 'gb', to: 'mib' });
  // A comma is a decimal point on this keyboard, as it is for money.
  assert.equal(parseUnits('1,5 kg to g').amount, 1.5);
});

test('the answers are the real numbers', () => {
  assert.equal(Math.round(value('70 kg to lb') * 100) / 100, 154.32);
  assert.equal(Math.round(value('1 mi to km') * 1000) / 1000, 1.609);
  assert.equal(Math.round(value('12 ft to m') * 1000) / 1000, 3.658);
  assert.equal(Math.round(value('1.5 gb to mib')), 1431);
  assert.equal(Math.round(value('2 cups to ml')), 473);
  assert.equal(Math.round(value('100 kmh to mph')), 62);
});

test('temperature is not a ratio', () => {
  /* ⚠️ The whole reason units carry an offset. Scaled as if it were a ratio,
   * 20°C comes out as 36°F — a number that looks like a temperature and is
   * not one, which is the worst kind of wrong answer. */
  assert.equal(Math.round(value('20 c to f')), 68);
  assert.equal(Math.round(value('220 f to c')), 104);
  assert.equal(Math.round(value('0 c to k') * 100) / 100, 273.15);
  assert.equal(Math.round(value('-40 c to f')), -40);
});

test('two units that do not measure the same thing have no answer', () => {
  /* ⚠️ Null, not a number. "5 kg to miles" cannot be answered, and a row that
   * appeared for it would be a row that appears for almost anything — which is
   * the whole risk of putting an answer at the top of a search. */
  assert.equal(parseUnits('5 kg to miles'), null);
  assert.equal(parseUnits('20 c to gb'), null);
  assert.equal(parseUnits('5 kg to kg'), null, 'the same unit twice is not a question');
});

test('everything else typed into a palette is left alone', () => {
  for (const said of [
    'notes', 'today', 'open settings', '70', 'kg', '12 * 3', 'in', 'to',
    'meeting in 20 minutes', '', '   ', 'a note about the metre',
    '100 usd to pln',
  ]) {
    assert.equal(parseUnits(said), null, `should not convert: ${said}`);
  }
});

test('the answer is as precise as the question was, and no more', () => {
  /* ⚠️ Significant figures, not fixed decimals: two would print a small answer
   * as "0.08", which is a converter saying "about nothing", and six would give
   * a large one four digits of noise the input never had. */
  assert.equal(sayMeasure(154.3235835), '154.32');
  assert.equal(sayMeasure(0.0787401), '0.0787');
  // Grouped, like every other number in this app.
  assert.equal(sayMeasure(1430.51), '1,430.5');
  assert.equal(sayMeasure(12345.6), '12,346');
  assert.equal(sayMeasure(68), '68');
  assert.equal(sayMeasure(1.5), '1.5');
  // The unit is said the way it is written, not the way it was typed.
  assert.equal(sayUnit('lbs'), 'lb');
  assert.equal(sayUnit('f'), '°F');
  assert.equal(sayUnit('mib'), 'MiB');
});
