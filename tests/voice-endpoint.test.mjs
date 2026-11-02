import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EndOfSpeech, SILENCE_MS, NOTHING_MS, FOLLOW_MS } from '../src/voice-endpoint.ts';

/** Levels every 50 ms from `from`; returns the first result and when. */
function feed(e, levels, from = 0) {
  let t = from;
  for (const level of levels) {
    const r = e.push(level, t);
    if (r) return { r, t };
    t += 50;
  }
  return { r: null, t };
}
const of = (level, ms) => Array.from({ length: Math.round(ms / 50) }, () => level);

test('he speaks and goes quiet: silence, about SILENCE_MS after the last loud moment', () => {
  const e = new EndOfSpeech();
  const { r, t } = feed(e, [...of(0.02, 500), ...of(0.5, 1500), ...of(0.02, 3000)]);
  assert.equal(r, 'silence');
  assert.ok(t >= 2000 + SILENCE_MS - 50 && t <= 2000 + SILENCE_MS + 100, `at ${t}`);
});

test('pauses between words do not end it; a cough is not a sentence', () => {
  const e = new EndOfSpeech();
  // Speech with 600 ms pauses, then the end.
  let res = feed(e, [...of(0.5, 800), ...of(0.03, 600), ...of(0.5, 800), ...of(0.03, 600), ...of(0.5, 500)]);
  assert.equal(res.r, null, 'short pauses keep listening');
  const cough = new EndOfSpeech();
  res = feed(cough, [...of(0.03, 300), ...of(0.6, 150), ...of(0.03, 3000)]);
  assert.equal(res.r, null, 'a 150 ms burst does not count as having spoken');
});

test('a noisy room: the floor rises with it, the hum never counts as speech', () => {
  const e = new EndOfSpeech();
  // Hum at 0.1 (above the absolute minimum's half), speech at 0.6.
  const { r } = feed(e, [...of(0.1, 1000), ...of(0.6, 1200), ...of(0.1, 2500)]);
  assert.equal(r, 'silence', 'quiet relative to the hum ends it');
  const hum = new EndOfSpeech();
  assert.equal(feed(hum, of(0.1, 5000)).r, null, 'a steady hum alone is not speech');
});

test('nothing said: ended after NOTHING_MS, sooner in a follow-up', () => {
  const e = new EndOfSpeech();
  const { r, t } = feed(e, of(0.02, NOTHING_MS + 500));
  assert.equal(r, 'nothing');
  assert.ok(t >= NOTHING_MS - 50, `at ${t}`);
  const f = new EndOfSpeech(true);
  const res = feed(f, of(0.02, FOLLOW_MS + 500));
  assert.equal(res.r, 'nothing');
  assert.ok(res.t < NOTHING_MS);
  f.reset(false);
  assert.equal(feed(f, of(0.02, FOLLOW_MS + 500)).r, null, 'reset to a fresh turn waits the longer time');
});

test('a steady loud tone (a fan, a test oscillator) is never speech: nothing, never sent', () => {
  const e = new EndOfSpeech();
  // The level climbs from zero as the microphone opens, then stays.
  const ramp = [0, 0.3, 0.6, 0.8, 0.9];
  const { r, t } = feed(e, [...ramp, ...of(0.9, NOTHING_MS + 500)]);
  assert.equal(r, 'nothing');
  assert.ok(t >= NOTHING_MS - 50);
});

test('he starts speaking the instant it opens: the dips between words still let it hear the end', () => {
  const e = new EndOfSpeech();
  const words = [];
  for (let i = 0; i < 8; i++) words.push(...of(0.6, 350), ...of(0.04, 150));
  const { r } = feed(e, [...words, ...of(0.04, 3000)]);
  assert.equal(r, 'silence');
});

test('a sound that switches on and stays (late audio, music, a fan) is not words: nothing, never sent', () => {
  const e = new EndOfSpeech(true);
  const { r, t } = feed(e, [...of(0, 1000), ...of(0.9, 9000)]);
  assert.equal(r, 'nothing');
  assert.ok(t < 1000 + 6000, `ended at ${t}, not left listening`);
});

test('a short answer ("Tak", 400 ms) in a follow-up is sent', () => {
  const e = new EndOfSpeech(true);
  const { r } = feed(e, [...of(0.02, 800), ...of(0.5, 400), ...of(0.02, 2500)]);
  assert.equal(r, 'silence');
});
