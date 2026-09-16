import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callControls, pillControls } from '../src/call-format.ts';

/** What Zoom answers to, and what Meet does — the two shapes that matter. */
const ZOOM = ['mute', 'video', 'share', 'hand', 'leave', 'open'];
const MEET = ['mute', 'video', 'hand', 'open'];
const WHATSAPP = ['mute', 'open'];

test('the row is drawn in one order, whatever order the app was described in', () => {
  // ⚠️ Shuffled on the way in. `can` arrives in the Rust table's order, and an
  // app that gains a shortcut later must not shift everything else along the
  // row — a control that moves is a control you have to look for.
  const shuffled = ['open', 'leave', 'hand', 'mute', 'share', 'video'];
  assert.deepEqual(
    callControls(shuffled, false).map(one => one.action),
    ['mute', 'video', 'share', 'hand', 'open', 'leave'],
  );
  assert.deepEqual(
    callControls(ZOOM, false).map(one => one.action),
    callControls(shuffled, false).map(one => one.action),
  );
});

test('nothing an app cannot do is drawn at all', () => {
  const meet = callControls(MEET, false).map(one => one.action);
  // Google Meet has no keyboard way to hang up or to share. Not greyed out:
  // absent, because a button that does nothing is worse than no button.
  assert.deepEqual(meet, ['mute', 'video', 'hand', 'open']);
  assert.ok(!meet.includes('leave'));
  assert.deepEqual(callControls(WHATSAPP, false).map(one => one.action), ['mute', 'open']);
  // And an app with nothing at all still gets the microphone, which is ours.
  assert.deepEqual(callControls(['mute'], false).map(one => one.action), ['mute']);
});

test('leave is last and is the only one marked dangerous', () => {
  const zoom = callControls(ZOOM, false);
  assert.equal(zoom[zoom.length - 1].action, 'leave');
  assert.deepEqual(zoom.filter(one => one.tone).map(one => one.action), ['leave']);
});

test('the mute says what pressing it will do, and shows what is true now', () => {
  const [off] = callControls(ZOOM, false);
  assert.deepEqual([off.action, off.label, off.icon, !!off.on], ['mute', 'Mute', 'mic', false]);
  const [on] = callControls(ZOOM, true);
  // ⚠️ The label is the verb — what the press does — and the icon is the
  // state. A struck-through microphone beside the word "Unmute" is the pairing
  // that reads correctly: you see what you are and press for what you want.
  assert.deepEqual([on.action, on.label, on.icon, on.on], ['unmute', 'Unmute', 'micOff', true]);
});

test('the strip carries the mute and the way out, and never three things', () => {
  assert.deepEqual(pillControls(ZOOM, false).map(one => one.action), ['mute', 'leave']);
  // Meet cannot be hung up from the keyboard, so the second control is the
  // nearest honest thing: bring the call forward.
  assert.deepEqual(pillControls(MEET, false).map(one => one.action), ['mute', 'open']);
  // Muted, the first control is the one that undoes it.
  assert.deepEqual(pillControls(WHATSAPP, true).map(one => one.action), ['unmute', 'open']);
  // An app offering neither gets one button rather than a dead second one.
  assert.deepEqual(pillControls(['mute'], false).map(one => one.action), ['mute']);
  for (const can of [ZOOM, MEET, WHATSAPP, ['mute']]) {
    assert.ok(pillControls(can, false).length <= 2, can.join());
  }
});

test('the strip and the panel agree about the mute', () => {
  // ⚠️ Two surfaces, one rule. They are built by different functions, and a
  // pill saying "Mute" beside a panel saying "Unmute" is the kind of thing
  // nobody notices until the meeting.
  for (const muted of [false, true]) {
    const strip = pillControls(ZOOM, muted)[0];
    const panel = callControls(ZOOM, muted)[0];
    assert.deepEqual(
      [strip.action, strip.icon, !!strip.on],
      [panel.action, panel.icon, !!panel.on],
    );
  }
});
