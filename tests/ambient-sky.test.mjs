import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skyAt, skyColours } from '../src/ambient-sky.ts';

const at = (h, m = 0) => new Date(2026, 8, 23, h, m);
const day = { sunrise: '06:40', sunset: '19:10', icon: 'wxClear' };

test('noon is bright and night is dark', () => {
  assert.ok(skyAt({ now: at(13), ...day }).light > 0.85);
  assert.ok(skyAt({ now: at(1), ...day }).light < 0.05);
});

test('the light moves continuously through sunset', () => {
  /* ⚠️ The property the whole model exists for: a scene left running across
   * dusk must never jump. Minute by minute, nothing moves more than a sliver. */
  let last = skyAt({ now: at(18, 0), ...day });
  for (let m = 1; m <= 150; m++) {
    const next = skyAt({ now: at(18, m), ...day });
    assert.ok(Math.abs(next.light - last.light) < 0.06, `light jumped at 18:00+${m}`);
    assert.ok(Math.abs(next.warmth - last.warmth) < 0.1, `warmth jumped at 18:00+${m}`);
    last = next;
  }
});

test('sunrise and sunset are the warm moments', () => {
  const noon = skyAt({ now: at(13), ...day });
  const sunset = skyAt({ now: at(19, 5), ...day });
  assert.ok(sunset.warmth > 0.8, `sunset warmth ${sunset.warmth}`);
  assert.ok(noon.warmth < 0.05, `noon warmth ${noon.warmth}`);
});

test('the sun crosses its own arc, and the moon its own', () => {
  const morning = skyAt({ now: at(9), ...day });
  const evening = skyAt({ now: at(17), ...day });
  assert.equal(morning.part, 'day');
  assert.ok(morning.share < evening.share);
  const night = skyAt({ now: at(23), ...day });
  assert.equal(night.part, 'night');
  assert.ok(night.share > 0 && night.share < 1);
});

test('cloud takes the glow out of a sunset', () => {
  const clear = skyAt({ now: at(19, 5), ...day });
  const grey = skyAt({ now: at(19, 5), ...day, icon: 'wxCloud' });
  assert.ok(grey.warmth < clear.warmth * 0.7);
  assert.ok(grey.light < clear.light);
});

test('the weather icons map to what they say', () => {
  const rain = skyAt({ now: at(13), ...day, icon: 'wxRain' });
  assert.ok(rain.rain > 0.5 && rain.snow === 0);
  const snow = skyAt({ now: at(13), ...day, icon: 'wxSnow' });
  assert.ok(snow.snow > 0.5 && snow.rain === 0);
  assert.equal(skyAt({ now: at(13), ...day, icon: 'wxStorm' }).storm, 1);
  assert.ok(skyAt({ now: at(13), ...day, icon: 'wxFog' }).fog > 0.5);
});

test('an unknown or missing reading is a mild sky, not an error', () => {
  const none = skyAt({ now: at(13) });
  assert.equal(none.rain, 0);
  assert.ok(none.light > 0.4);
});

test('a picked time and weather override the real ones', () => {
  const picked = skyAt({ now: at(13), ...day, sky: 'night', weather: 'snow' });
  assert.equal(picked.part, 'night');
  assert.ok(picked.snow > 0.5);
  assert.equal(skyAt({ now: at(1), ...day, sky: 'day' }).part, 'day');
  assert.ok(skyAt({ now: at(13), ...day, sky: 'dusk' }).warmth > 0.5);
});

test('overcast colours do not jump as the light crosses a half', () => {
  const base = skyAt({ now: at(13), ...day, icon: 'wxCloud' });
  const a = skyColours({ ...base, light: 0.49 }).mid;
  const b = skyColours({ ...base, light: 0.51 }).mid;
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 6), `${a} vs ${b}`);
});
