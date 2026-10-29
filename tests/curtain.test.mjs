import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReading, minutes, zl, freeFrom, countdown, barOf, offerOf } from '../src/curtain-view.ts';

/* The curtain's words and offers (curtain-view.ts), from a reading shaped like
 * Helm's GET /api/desktop/blocker. Wednesday 28 Oct 2026, 14:10 in Warsaw. */
const now = new Date('2026-10-28T13:10:00Z');
const site = (earn = true) => ({ domain: 'youtube.com', name: 'YouTube', tokens: ['YouTube'], earn });
const body = (over = {}) => ({
  now: now.toISOString(), why: 'earn', sites: [site()],
  title: 'Zarobiony czas na dziś się skończył', body: 'Na teraz: Koszyk w Esono.',
  earn: { perHour: 15, worked: 160, hours: 2, earned: 30, spent: 30, left: 0, nextIn: 20 },
  spend: null, buy: { minutes: 5, price: 10 }, opens: '2026-10-28T17:00:00Z', until: null, ...over,
});
const showing = (over = {}, earn = true) => ({ serial: 1, reading: readReading(body(over)), site: site(earn), browser: 'Brave' });

test('a reading without its line is no reading, never a blank curtain', () => {
  assert.equal(readReading(null), null);
  assert.equal(readReading('<html>'), null);
  assert.equal(readReading(body({ title: '' })), null);
  const r = readReading({ title: 'Coś', earn: {} });
  assert.equal(r.earn.perHour, 15, 'a missing number takes its default');
  assert.equal(r.earn.nextIn, 60);
  assert.equal(r.buy, null);
  assert.equal(readReading(body({ opens: 'soon' })).opens, null, 'a time that is not a time is dropped');
});

test('durations, money and times read in Polish', () => {
  assert.equal(minutes(20), '20 min');
  assert.equal(minutes(80), '1 h 20 min');
  assert.equal(minutes(120), '2 h');
  assert.equal(zl(10), '10 zł');
  assert.equal(zl(12.5), '12,5 zł');
  assert.equal(freeFrom('2026-10-28T17:00:00Z', now), 'Wolne od 18:00');
  assert.equal(freeFrom('2026-10-28T23:00:00Z', now), 'Wolne od północy');
  assert.equal(freeFrom('2026-10-29T08:00:00Z', now), 'Wolne jutro');
  assert.equal(freeFrom(null, now), null);
  assert.equal(countdown('2026-10-28T17:00:00Z', now), 'za 3 h 50 min');
  assert.equal(countdown('2026-10-28T13:00:00Z', now), null, 'past');
});

test('the bar: spent, left, and the next hour filling', () => {
  const bar = barOf({ perHour: 15, worked: 160, hours: 2, earned: 30, spent: 10, left: 20, nextIn: 20 });
  assert.equal(bar.spent, 10 / 45);
  assert.equal(bar.left, 20 / 45);
  assert.equal(bar.next, 15 / 45);
  assert.equal(bar.into, 40 / 60);
  // Minutes spent before the hours earned them (the day blocks stopped earning) never overflow.
  assert.equal(barOf({ perHour: 15, worked: 70, hours: 1, earned: 15, spent: 40, left: 0, nextIn: 50 }).spent, 15 / 30);
});

test('earned time spent: back to work, five minutes for a price, when it is free', () => {
  const offer = offerOf(showing(), now);
  assert.deepEqual(offer.buy, { label: '5 minut za 10 zł', price: 10 });
  assert.equal(offer.spend, null);
  assert.equal(offer.earning, true);
  assert.equal(offer.next, 'Kolejne 15 min za 20 min pracy');
  assert.equal(offer.worked, 'Przepracowane 2 h 40 min');
  assert.equal(offer.free, 'Wolne od 18:00');
  assert.equal(offer.where, 'YouTube w Brave');
});

test('never money for a site earned time would not open', () => {
  const offer = offerOf(showing({}, true), now);
  assert.ok(offer.buy);
  const held = offerOf(showing({}, false), now);
  assert.equal(held.buy, null, 'a locked rule holds it too');
  assert.equal(offerOf(showing({ why: 'spend', spend: 30, buy: null }, false), now).spend, null);
});

test('earned minutes to spend open fifteen at a time; the first hour says so', () => {
  const spend = offerOf(showing({ why: 'spend', spend: 30, buy: null, earn: { perHour: 15, worked: 130, hours: 2, earned: 30, spent: 0, left: 30, nextIn: 50 } }), now);
  assert.deepEqual(spend.spend, { minutes: 15, label: 'Otwórz na 15 min' });
  assert.equal(offerOf(showing({ why: 'spend', spend: 5, buy: null }), now).spend.minutes, 5);
  const first = offerOf(showing({ why: 'first-block', buy: null, earn: { perHour: 15, worked: 35, hours: 0, earned: 0, spent: 0, left: 0, nextIn: 25 } }), now);
  assert.equal(first.next, 'Pierwsze 15 min za 25 min pracy');
  assert.equal(first.buy, null);
});

test('a block, a hold or a locked rule: no bar, just the wait', () => {
  const focus = offerOf(showing({ why: 'focus', buy: null, opens: null }, false), now);
  assert.equal(focus.earning, false);
  assert.equal(focus.next, null);
  assert.equal(focus.wait, null);
  const held = offerOf(showing({ why: 'held', buy: null, opens: '2026-10-28T15:30:00Z' }, false), now);
  assert.equal(held.earning, false);
  assert.equal(held.wait, 'za 2 h 20 min');
});
