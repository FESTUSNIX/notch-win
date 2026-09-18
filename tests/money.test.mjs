import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, parseMoney, sayAmount, sayDay, sayMoney, sayRate } from '../src/money.ts';

/** The real table, trimmed: what `money.rs` handed back on 17 Sep 2026. */
const TABLE = {
  date: '2026-09-17',
  base: 'EUR',
  rates: { PLN: 4.358, USD: 1.1481, GBP: 0.8583, JPY: 178.75, CZK: 24.308 },
};

test('a conversion is an amount and two currencies, however they are typed', () => {
  assert.deepEqual(parseMoney('100 usd to pln'), { amount: 100, from: 'USD', to: 'PLN' });
  assert.deepEqual(parseMoney('100USD PLN'), { amount: 100, from: 'USD', to: 'PLN' });
  assert.deepEqual(parseMoney('$100 in zł'), { amount: 100, from: 'USD', to: 'PLN' });
  assert.deepEqual(parseMoney('100zł to eur'), { amount: 100, from: 'PLN', to: 'EUR' });
  assert.deepEqual(parseMoney('20 euros as pounds'), { amount: 20, from: 'EUR', to: 'GBP' });
  assert.deepEqual(parseMoney('£12.50 > usd'), { amount: 12.5, from: 'GBP', to: 'USD' });
  // No amount is one of them, which is the rate itself.
  assert.deepEqual(parseMoney('usd to pln'), { amount: 1, from: 'USD', to: 'PLN' });
});

test('a decimal comma is a decimal point, and a thousands comma is not', () => {
  /* ⚠️ On a Polish keyboard the comma IS the decimal point, and guessing the
   * other way turns 1,5 into fifteen — the bug that made the calculator refuse
   * commas outright. A comma only groups when three digits follow it. */
  assert.equal(parseMoney('1,5 eur to pln').amount, 1.5);
  assert.equal(parseMoney('1,500 eur to pln').amount, 1500);
  assert.equal(parseMoney('1,234.56 usd to eur').amount, 1234.56);
  assert.equal(parseMoney('1.234,56 usd to eur').amount, 1234.56);
  assert.equal(parseMoney('1 500 usd to eur').amount, 1500);
});

test('everything else typed into a palette is left alone', () => {
  /* ⚠️ Anything that parses puts a row at the TOP of the results, so the
   * grammar has to say no to almost everything — this is the half of the
   * feature that decides whether the palette stays usable. */
  for (const said of [
    'today', 'notes', 'open settings', '100', 'usd', '12 * 3', 'in', 'to',
    'usd to usd', 'meeting in 20 minutes', 'pln', '', '   ',
    'go to london', 'a note about the euro',
  ]) {
    assert.equal(parseMoney(said), null, `should not convert: ${said}`);
  }
});

test('the crossing goes through the table own base', () => {
  // 100 USD -> EUR -> PLN: 100 / 1.1481 * 4.358
  const money = parseMoney('100 usd to pln');
  assert.equal(Math.round(convert(money, TABLE) * 100) / 100, 379.58);
  // And the base itself needs no rate of its own.
  assert.equal(Math.round(convert(parseMoney('10 eur to pln'), TABLE)), 44);
  assert.equal(Math.round(convert(parseMoney('4358 pln to eur'), TABLE)), 1000);
});

test('a currency the table does not carry is no answer, never a NaN', () => {
  /* ⚠️ `undefined * 4` is `NaN`, and `NaN` renders perfectly happily — a row
   * reading "= NaN PLN" is worse than no row, because it looks like the app
   * broke rather than like the source does not publish that currency. */
  assert.equal(convert({ amount: 1, from: 'XYZ', to: 'PLN' }, TABLE), null);
  assert.equal(convert({ amount: 1, from: 'PLN', to: 'XYZ' }, TABLE), null);
});

test('the answer is written the way money is written', () => {
  assert.equal(sayMoney(379.5837, 'PLN'), '379.58');
  assert.equal(sayMoney(12345.6, 'PLN'), '12,345.60');
  // ⚠️ Nobody writes decimals on yen.
  assert.equal(sayMoney(17875, 'JPY'), '17,875');
  /* ⚠️ And a small answer keeps its figures: two decimals on this is "0.00",
   * which is the converter saying the answer is nothing. */
  assert.equal(sayMoney(0.000812, 'BTC'), '0.000812');
  assert.equal(sayRate(parseMoney('usd to pln'), TABLE), '3.796');
});

test('the question is echoed as it was typed, and the day is said', () => {
  /* ⚠️ The ANSWER is money and wants its two decimals; the question is a
   * number somebody typed, and "120.00" is the row correcting them about
   * something they got right. */
  assert.equal(sayAmount(120), '120');
  assert.equal(sayAmount(12.5), '12.5');
  assert.equal(sayAmount(1500), '1,500');
  /* ⚠️ The date is on the row because these are DAILY rates — an answer on a
   * Sunday is Friday's number — which is a fact somebody reads, and nobody
   * reads a hyphenated ISO date. */
  assert.equal(sayDay('2026-09-17'), '17 Sep');
  assert.equal(sayDay(''), '');
});
