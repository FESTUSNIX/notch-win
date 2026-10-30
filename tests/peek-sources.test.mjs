import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budsPeek, micPeek, powerPeek, filePeek, fitName, shortDevice, freshHelmPeeks, helmPeek, remember,
  focusKey, focusPeek, withKind, volumePeek,
} from '../src/peek-logic.ts';

test('earbuds are named short and carry their battery', () => {
  assert.equal(shortDevice("Mateusz's Buds3 Pro"), 'Buds');
  assert.equal(shortDevice('Speakers (6- Logi Z207)'), 'Speakers');
  const on = budsPeek({ name: "Mateusz's Buds3 Pro", connected: true, battery: 80 });
  assert.equal(on.title, 'Buds podłączone · 80%');
  assert.equal(on.level, 0.8);
  assert.equal(on.tone, 'good');
  assert.equal(budsPeek({ name: 'Buds', connected: true, battery: 15 }).tone, 'warn');
  assert.equal(budsPeek({ name: 'Buds', connected: true, battery: null }).title, 'Buds podłączone');
  assert.equal(budsPeek({ name: 'Buds', connected: false, battery: null }).title, 'Buds rozłączone');
  // One id per device: a connect replaces its own disconnect in the queue.
  assert.equal(on.id, budsPeek({ name: "Mateusz's Buds3 Pro", connected: false, battery: null }).id);
});

test('the microphone and the battery', () => {
  assert.equal(micPeek(true).title, 'Mikrofon wyciszony');
  assert.equal(micPeek(true).icon, 'micOff');
  assert.equal(micPeek(false).title, 'Mikrofon włączony');
  const low = powerPeek({ what: 'low', percent: 12, urgent: false });
  assert.equal(low.title, 'Bateria 12%');
  assert.equal(low.urgent, false);
  assert.equal(powerPeek({ what: 'low', percent: 5, urgent: true }).urgent, true);
  assert.equal(powerPeek({ what: 'charger', plugged: true, percent: 40 }).icon, 'charging');
  assert.equal(powerPeek({ what: 'charger', plugged: false, percent: 40 }).title, 'Na baterii · 40%');
});

test('a download keeps its extension when its name is cut', () => {
  assert.equal(filePeek({ token: 't', kind: 'download', name: 'faktura.pdf', thumb: null }).title, 'Pobrano: faktura.pdf');
  const long = fitName('faktura_wrzesien_2026_ubrania_studio_final.pdf');
  assert.ok(long.length <= 28 && long.endsWith('….pdf'), long);
  const shot = filePeek({ token: 's', kind: 'screenshot', name: 'x.png', thumb: 'data:image/png;base64,AA' });
  assert.equal(shot.title, 'Zrzut ekranu');
  assert.equal(shot.art, 'data:image/png;base64,AA');
  assert.equal(shot.id, 'screenshot:s');
});

test("Helm's feed: each id once, oldest first, junk dropped", () => {
  const raw = { peeks: [
    { id: 'paid:2', kind: 'paid', title: '+4 795 zł · NXM', at: '2026-10-30T10:05:00Z' },
    { id: 'logged:1', kind: 'logged', title: '1 h 20 min na Atelier, zalogowane', at: '2026-10-30T10:00:00Z' },
    { id: 'x', kind: 'other', title: 'nope', at: '' },
    { id: 'paid:3', kind: 'paid', title: '  ', at: '' },
  ] };
  assert.deepEqual(freshHelmPeeks(raw, []).map(p => p.id), ['logged:1', 'paid:2']);
  assert.deepEqual(freshHelmPeeks(raw, ['logged:1']).map(p => p.id), ['paid:2']);
  assert.deepEqual(freshHelmPeeks({}, []), []);
  assert.deepEqual(freshHelmPeeks(null, []), []);
  assert.equal(helmPeek({ id: '41', kind: 'paid', title: '+1 zł', at: '' }).id, 'paid:41');
  assert.equal(helmPeek({ id: 'logged:9', kind: 'logged', title: 'x', at: '' }).icon, 'stopwatch');
  let seen = [];
  for (let i = 0; i < 100; i++) seen = remember(seen, `id${i}`);
  assert.equal(seen.length, 80);
  assert.equal(seen.at(-1), 'id99');
});

test('focus: once per site per block, never outside one', () => {
  assert.equal(focusKey(null, 'youtube.com'), null);
  assert.equal(focusKey(7, 'YouTube.com'), '7:youtube.com');
  assert.notEqual(focusKey(7, 'youtube.com'), focusKey(8, 'youtube.com'));
  assert.equal(focusPeek('youtube.com').title, 'Wracamy?');
});

test('settings store only what is switched off', () => {
  assert.deepEqual(withKind({}, 'mic', false), { mic: false });
  assert.deepEqual(withKind({ mic: false, buds: false }, 'mic', true), { buds: false });
  assert.deepEqual(withKind({ mic: true }, 'buds', true), {});
});

test('volume: one id, muted reads as muted', () => {
  assert.equal(volumePeek({ level: 64, muted: false }).title, 'Głośność 64%');
  assert.equal(volumePeek({ level: 64, muted: true }).title, 'Wyciszono');
  assert.equal(volumePeek({ level: 64, muted: false }).id, volumePeek({ level: 10, muted: true }).id);
});
