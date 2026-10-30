import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wakeRefused, wakeTip } from '../src/wake-rules.ts';
import { pickMic } from '../src/kit/voice.ts';

const ready = { enabled: true, signedIn: true, live: false, call: false, speaking: false, snoozedUntil: 0, now: 1_000 };

test('a heard word starts a turn only when nothing is in the way', () => {
  assert.equal(wakeRefused(ready), null);
  assert.equal(wakeRefused({ ...ready, enabled: false }), 'off');
  assert.equal(wakeRefused({ ...ready, snoozedUntil: 5_000 }), 'snoozed');
  assert.equal(wakeRefused({ ...ready, snoozedUntil: 500 }), null, 'an hour that is over is over');
  assert.equal(wakeRefused({ ...ready, call: true }), 'call');
  assert.equal(wakeRefused({ ...ready, live: true }), 'turn', 'one turn at a time: a word inside a turn is just a word');
  assert.equal(wakeRefused({ ...ready, speaking: true }), 'speaking', 'it never wakes itself');
  assert.equal(wakeRefused({ ...ready, signedIn: false }), 'signed-out');
  // Off wins over everything; a call over a live turn.
  assert.equal(wakeRefused({ ...ready, enabled: false, call: true, live: true }), 'off');
  assert.equal(wakeRefused({ ...ready, call: true, live: true, speaking: true }), 'call');
});

test('the settings mark says why in a tooltip', () => {
  assert.equal(wakeTip({ listening: true, reason: null }), 'Listening for “Jarvis”');
  assert.equal(wakeTip({ listening: false, reason: 'call' }), 'Paused during a call');
  assert.equal(wakeTip({ listening: false, reason: 'engine', problem: 'Picovoice refused the AccessKey' }), "The engine didn't start: Picovoice refused the AccessKey");
  assert.equal(wakeTip({ listening: false, reason: null }), 'Off');
});

const BUDS = "Headset (Mateusz's Buds3 Pro Hands-Free)";
const devices = [
  { kind: 'audioinput', deviceId: 'default', label: 'Default - Microphone (USB Audio Device) (0c76:161f)' },
  { kind: 'audioinput', deviceId: 'communications', label: `Communications - ${BUDS}` },
  { kind: 'audioinput', deviceId: 'buds', label: BUDS },
  { kind: 'audioinput', deviceId: 'usb', label: 'Microphone (USB Audio Device) (0c76:161f)' },
  { kind: 'audioinput', deviceId: 'droid', label: 'Microphone (DroidCam Audio)' },
  { kind: 'audiooutput', deviceId: 'out', label: 'Microphone (DroidCam Audio)' },
];

test('the turn records from the microphone picked in Settings, by its Windows name', () => {
  assert.equal(pickMic(devices, 'Microphone (USB Audio Device)'), 'usb', 'a USB label carries (vid:pid) after the name');
  assert.equal(pickMic(devices, 'Microphone (DroidCam Audio)'), 'droid', 'exact, and never an output of the same name');
  assert.equal(pickMic(devices, 'microphone (droidcam audio) '), 'droid', 'case and spaces do not matter');
  assert.equal(pickMic(devices, BUDS), 'buds');
  assert.equal(pickMic(devices, 'Microphone (Blue Yeti)'), null, 'not plugged in');
  assert.equal(pickMic(devices, ''), undefined, 'nothing chosen: the default, as before');
  // No permission yet: every label is empty and nothing can be told apart.
  assert.equal(pickMic([{ kind: 'audioinput', deviceId: '', label: '' }], 'Microphone (USB Audio Device)'), undefined);
  // "Default - …" is never taken for the device itself.
  assert.equal(pickMic(devices.filter(d => d.deviceId !== 'usb'), 'Microphone (USB Audio Device)'), null);
});
