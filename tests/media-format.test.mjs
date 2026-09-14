import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, deviceName, sourceName, spoken, waveform } from '../src/media-format.ts';

test('an endpoint name keeps whichever half is not generic', () => {
  // Bluetooth: the form factor is generic, the device is in the brackets.
  assert.equal(deviceName("Headphones (6- Mateusz's Buds3 Pro)"), "Mateusz's Buds3 Pro");
  assert.equal(deviceName('Speakers (6- Logi Z207)'), 'Logi Z207');
  // ⚠️ The other way round, and the reason this is not a one-line strip:
  // taking the brackets here renames the monitor to its graphics card.
  assert.equal(deviceName('DELL U2724D (NVIDIA High Definition Audio)'), 'DELL U2724D');
  assert.equal(deviceName('Realtek Digital Output (Realtek(R) Audio)'), 'Realtek Digital Output');
  // Nested brackets must not fall through to the raw string.
  assert.equal(deviceName('Speakers (Realtek(R) Audio)'), 'Realtek(R) Audio');
  // Nothing to work with: hand it back rather than inventing.
  assert.equal(deviceName('Some Device'), 'Some Device');
  assert.equal(deviceName(''), '');
});

test('a source id becomes an app anyone recognises', () => {
  assert.equal(sourceName('Spotify.exe'), 'Spotify');
  assert.equal(sourceName('308046B0AF4A39CB'), 'Firefox');
  assert.equal(sourceName('Brave'), 'Brave');
  // Unknown ids keep their own name rather than a guess.
  assert.equal(sourceName('Foobar2000.exe'), 'Foobar2000');
  assert.equal(sourceName(''), '');
});

test('the clock only grows an hours field when there is one', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(65), '1:05');
  assert.equal(clock(3661), '1:01:01');
  // Nonsense in, something printable out — this drives a label, not a decision.
  assert.equal(clock(-5), '0:00');
  assert.equal(clock(NaN), '0:00');
});

test('the waveform is stable per track and different between tracks', () => {
  const a = waveform('One|Artist', 72);
  const b = waveform('One|Artist', 72);
  const c = waveform('Two|Artist', 72);
  assert.equal(a.length, 72);
  assert.deepEqual(a, b, 'the same track must always draw the same shape');
  assert.notDeepEqual(a, c, 'a different track must look different');
  assert.ok(a.every(v => v >= 0.14 && v <= 1), 'every bar stays inside the box');
  // The envelope: the middle is louder than the very edges.
  const edge = (a[0] + a[71]) / 2;
  const middle = a.slice(30, 42).reduce((n, v) => n + v, 0) / 12;
  assert.ok(middle > edge, 'it should read as audio, not as noise');
});

test('a run duration is spelled the same as the Rust side spells it', () => {
  // The same four rows as sessions::tests::says_durations_the_way_a_person_would.
  assert.equal(spoken(8), '8s');
  assert.equal(spoken(59), '59s');
  assert.equal(spoken(60), '1m 00s');
  assert.equal(spoken(252), '4m 12s');
  // Padding is what stops "1m 5s" reading as five minutes at a glance.
  assert.equal(spoken(65), '1m 05s');
});
