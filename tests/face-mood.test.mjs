import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moodOf, voiceMood, isNight, withFlash, nextHabit, FLASH_MS, MOODS } from '../src/face-mood.ts';

const base = { voice: null, flashes: [], worried: false, focused: false, night: false, now: 1000 };

test('a voice turn: listening while he speaks, thinking while it is written and answered, talking while it is said', () => {
  assert.equal(voiceMood(null), null);
  assert.equal(voiceMood('idle'), null);
  assert.equal(voiceMood('pressed'), 'listen');
  assert.equal(voiceMood('listening'), 'listen');
  assert.equal(voiceMood('transcribing'), 'think');
  assert.equal(voiceMood('thinking'), 'think');
  assert.equal(voiceMood('speaking'), 'speak');
});

test('the highest wins: voice, then a failure, good news, a worry, a session, the night, idle', () => {
  assert.equal(moodOf(base), 'idle');
  assert.equal(moodOf({ ...base, night: true }), 'sleep');
  assert.equal(moodOf({ ...base, night: true, focused: true }), 'focus', 'a session at night is still a session');
  assert.equal(moodOf({ ...base, focused: true, worried: true }), 'alert');
  const paid = withFlash([], 'love', base.now);
  assert.equal(moodOf({ ...base, worried: true, flashes: paid }), 'love');
  const both = withFlash(paid, 'oops', base.now);
  assert.equal(moodOf({ ...base, flashes: both }), 'oops');
  assert.equal(moodOf({ ...base, flashes: both, voice: 'speaking' }), 'speak', 'talking to him beats everything');
});

test('a flash plays for its time and hands back to what is underneath', () => {
  const done = withFlash([], 'happy', 1000);
  assert.equal(moodOf({ ...base, flashes: done, focused: true, now: 1000 + FLASH_MS - 1 }), 'happy');
  assert.equal(moodOf({ ...base, flashes: done, focused: true, now: 1000 + FLASH_MS }), 'focus');
  // The same news again lasts longer, not twice.
  const again = withFlash(done, 'happy', 3000);
  assert.equal(again.length, 1);
  assert.equal(again[0].until, 3000 + FLASH_MS);
  // Old flashes are dropped as new ones come.
  assert.deepEqual(withFlash(done, 'love', 99_999).map(f => f.mood), ['love']);
});

test('night: from his close time when it is evening, else 23:00, until six', () => {
  assert.equal(isNight(22 * 60 + 59, null), false);
  assert.equal(isNight(23 * 60, null), true);
  assert.equal(isNight(3 * 60, null), true);
  assert.equal(isNight(6 * 60, null), false);
  assert.equal(isNight(20 * 60 + 30, 20 * 60), true, 'past his close');
  assert.equal(isNight(13 * 60, 12 * 60), false, 'a close at noon is not a night');
});

test('habits are rare: a wink or a tilt every 8 to 22 minutes', () => {
  assert.deepEqual(nextHabit(0), { kind: 'wink', inMs: 8 * 60_000 });
  assert.equal(nextHabit(0.99).kind, 'tilt');
  assert.ok(nextHabit(0.99).inMs < 22 * 60_000 + 1);
  assert.equal(MOODS.length, 10);
});

test('pokes: a start, then a giggle, then grumpy', async () => {
  const { pokeReaction } = await import('../src/face-mood.ts');
  assert.equal(pokeReaction(1), 'startle');
  assert.equal(pokeReaction(2), 'startle');
  assert.equal(pokeReaction(3), 'giggle');
  assert.equal(pokeReaction(5), 'grumpy');
  assert.equal(pokeReaction(9), 'grumpy');
});

test('peeks: his own news gets his face and a mood, the PC gets a reaction, the rest keep their glyph', async () => {
  const { peekFace } = await import('../src/face-mood.ts');
  assert.deepEqual(peekFace({ kind: 'paid', id: 'paid:1' }), { flash: 'love' });
  assert.deepEqual(peekFace({ kind: 'logged', id: 'logged:1' }), { flash: 'happy' });
  assert.deepEqual(peekFace({ kind: 'pc', id: 'pc:1' }), { flash: 'oops' });
  assert.deepEqual(peekFace({ kind: 'mail', id: 'mail:1' }), { glance: true });
  assert.deepEqual(peekFace({ kind: 'buds', id: 'buds:x', tone: 'good' }), { react: 'phones' });
  assert.equal(peekFace({ kind: 'buds', id: 'buds:x', tone: 'neutral' }), null, 'taken off: nothing to react to');
  assert.equal(peekFace({ kind: 'volume', id: 'volume', level: 0.8 }), null);
  assert.deepEqual(peekFace({ kind: 'volume', id: 'volume', level: 1 }), { react: 'wide' });
  assert.deepEqual(peekFace({ kind: 'power', id: 'power:low', level: 0.1 }), { react: 'tired' });
  assert.equal(peekFace({ kind: 'power', id: 'power:charger' }), null);
  assert.equal(peekFace({ kind: 'music', id: 'music:1' }), null);
  assert.equal(peekFace({ kind: 'screenshot', id: 'shot:1' }), null);
});

test('Hoot and Sir draw every mood and reaction without throwing, and say when they move', async () => {
  const { Sprite } = await import('../src/face-friends.ts');
  const calls = [];
  const ctx = { clearRect() {}, fillRect(x, y, w, h) { calls.push([x, y, w, h]); }, set fillStyle(_) {} };
  const life = { glance: 0, wink: 0, tilt: 0, level: null, look: null, react: null };
  for (const who of ['hoot', 'sir']) {
    const s = new Sprite(who);
    for (const m of ['idle', 'listen', 'think', 'speak', 'happy', 'love', 'focus', 'alert', 'oops', 'sleep', 'vibe']) {
      calls.length = 0;
      s.draw(ctx, 32, 10, m, 0.016, life, false);
      assert.ok(calls.length > 40, `${who} ${m} paints`);
      // Whole pixels: every edge lands on a device pixel.
      assert.ok(calls.every(([x, y, w, h]) => Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(w) && Number.isInteger(h)));
    }
    for (const kind of ['startle', 'giggle', 'grumpy', 'flash', 'nod', 'wide', 'phones', 'tired']) {
      assert.equal(s.draw(ctx, 32, 20, 'idle', 0.016, { ...life, react: { kind, at: 19.9 } }, false), true, `${who} ${kind} moves`);
    }
    // Still and idle, long after turning: nothing moves (reduced motion never moves).
    s.draw(ctx, 32, 30, 'idle', 0.016, life, false);
    assert.equal(s.draw(ctx, 32, 31, 'idle', 0.016, life, false), false);
    assert.equal(s.draw(ctx, 32, 32, 'happy', 0.016, life, true), false);
  }
});
