import { test } from 'node:test';
import assert from 'node:assert/strict';
/* ⚠️ The RESOLVER, not the marks. Which file a coin gets is a set of rules
 * about names — an exchange's ticker against an icon set's — and rules are the
 * part worth pinning down. That there is a file called `BTC.svg` is the
 * generator's job and a directory listing's answer, not a test's. */
import { coinMarkName, coinMarkUrl } from '../src/coin-icon.ts';

test('a symbol the set knows resolves to itself', () => {
  for (const one of ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'USDT']) {
    assert.equal(coinMarkName(one), one);
  }
});

test('case and punctuation are not part of the name', () => {
  // Binance shouts its tickers; nothing else here is guaranteed to.
  assert.equal(coinMarkName('btc'), 'BTC');
  assert.equal(coinMarkName(' Eth '), 'ETH');
});

test('a token with no mark is null rather than a guess', () => {
  // ⚠️ The caller draws a monogram for this. A near-miss would draw the wrong
  // company's logo next to somebody's balance, which is worse than a blank.
  assert.equal(coinMarkName('NOTACOIN'), null);
  assert.equal(coinMarkName(''), null);
  assert.equal(coinMarkName('   '), null);
  assert.equal(coinMarkUrl('NOTACOIN'), null);
});

test('a renamed ticker still finds its mark', () => {
  // Binance renamed RNDR to RENDER in 2024; the set files it under the old one.
  assert.equal(coinMarkName('RENDER'), 'RNDR');
  assert.equal(coinMarkName('MIOTA'), 'IOTA');
});

test('wrapped and staked forms take the underlying mark', () => {
  assert.equal(coinMarkName('BETH'), 'ETH');
  assert.equal(coinMarkName('WETH'), 'ETH');
  assert.equal(coinMarkName('BTCB'), 'BTC');
});

test("Binance's lending prefix is stripped, but only as a last resort", () => {
  // ⚠️ LDO is Lido and not "lending DO". A real ticker has to win.
  assert.equal(coinMarkName('LDBTC'), 'BTC');
  assert.equal(coinMarkName('LDO'), 'LDO');
});

test('a name cannot reach outside the marks folder', () => {
  /* ⚠️ The symbol becomes a path. These are nonsense tickers, and the point is
   * that they come back as nonsense rather than as `coin/../../something`. */
  assert.equal(coinMarkName('../BTC'), 'BTC');
  assert.equal(coinMarkUrl('BTC'), 'coin/BTC.svg');
  for (const bad of ['..', './', '%2e%2e']) {
    const url = coinMarkUrl(bad);
    assert.ok(url === null || /^coin\/[A-Z0-9]+\.svg$/.test(url), bad);
  }
});
