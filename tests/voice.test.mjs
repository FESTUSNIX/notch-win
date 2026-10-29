import { test } from 'node:test';
import assert from 'node:assert/strict';
import { step, idle, takeSentences, speakable, HOLD_MS } from '../src/voice-turn.ts';

/** Run events through the machine; the last state and every effect, in order. */
function run(events, state = idle()) {
  const effects = [];
  for (const event of events) {
    const [next, did] = step(state, event);
    state = next;
    effects.push(...did);
  }
  return { state, effects, did: effects.map(e => e.do) };
}
const says = effects => effects.filter(e => e.do === 'say');

test('a sentence ends at its mark and a space, never at a mark with nothing after it yet', () => {
  assert.deepEqual(takeSentences('Dobrze. Przesunąłem', false), { ready: ['Dobrze.'], rest: ' Przesunąłem' });
  // "14." may be the start of "14.30": wait for what comes next.
  assert.deepEqual(takeSentences('Masz call o 14.', false), { ready: [], rest: 'Masz call o 14.' });
  assert.deepEqual(takeSentences('Masz call o 14.30 z Piotrem. Potem', false).ready, ['Masz call o 14.30 z Piotrem.']);
  assert.deepEqual(takeSentences('Serio?! Tak… zrób to. ', false).ready, ['Serio?!', 'Tak…', 'zrób to.']);
  // Closing quotes and brackets go with their sentence.
  assert.deepEqual(takeSentences('Napisał „jutro.” Odpisz mu (krótko!) dziś.', true).ready, ['Napisał „jutro.”', 'Odpisz mu (krótko!) dziś.']);
  // Abbreviations do not end one.
  assert.deepEqual(takeSentences('Zrób np. Repricer, ok. godzinę. Potem przerwa.', true).ready, ['Zrób np. Repricer, ok. godzinę.', 'Potem przerwa.']);
  // A line break does; the final flush takes the rest.
  assert.deepEqual(takeSentences('Raz\ndwa', false), { ready: ['Raz'], rest: 'dwa' });
  assert.deepEqual(takeSentences('Raz\ndwa', true), { ready: ['Raz', 'dwa'], rest: '' });
  assert.deepEqual(takeSentences('   ', true), { ready: [], rest: '' });
});

test('what a voice reads leaves out markdown, links, list marks and emoji', () => {
  assert.equal(speakable('**Dobrze.** Przesunąłem `Repricer` 👍'), 'Dobrze. Przesunąłem Repricer');
  assert.equal(speakable('- Esono → jutro'), 'Esono, jutro');
  assert.equal(speakable('Zobacz [fakturę](https://helm/x) albo https://x.y/z'), 'Zobacz fakturę albo');
  assert.equal(speakable('1. Najpierw koszyk'), 'Najpierw koszyk');
  assert.equal(speakable('✅'), '');
});

test('hold, speak, let go: listening, the words, thinking, each sentence said as it comes, then idle', () => {
  let { state, did } = run([{ t: 'down' }]);
  assert.equal(state.phase, 'pressed');
  assert.deepEqual(did, ['record'], 'the microphone opens on the press, so the first word is not cut');
  ({ state, did } = run([{ t: 'held' }], state));
  assert.equal(state.phase, 'listening');
  assert.deepEqual(did, ['open', 'escape']);
  ({ state, did } = run([{ t: 'up', ms: 2400 }], state));
  assert.equal(state.phase, 'transcribing');
  assert.deepEqual(did, ['finish']);
  let effects;
  ({ state, effects } = run([{ t: 'heard', text: ' Co mam dziś? ' }], state));
  assert.equal(state.phase, 'thinking');
  assert.deepEqual(effects.at(-1), { do: 'send', text: 'Co mam dziś?' });
  const turn = state.turn;
  // The first sentence is said while the rest is still being written.
  ({ state, effects } = run([{ t: 'text', d: 'Masz dwie rzeczy. Najpierw' }], state));
  assert.equal(state.phase, 'speaking');
  assert.deepEqual(says(effects), [{ do: 'say', text: 'Masz dwie rzeczy.', turn, seq: 0 }]);
  ({ state, effects } = run([{ t: 'text', d: ' koszyk Esono, potem faktura.' }, { t: 'done' }], state));
  assert.deepEqual(says(effects), [{ do: 'say', text: 'Najpierw koszyk Esono, potem faktura.', turn, seq: 1 }]);
  assert.equal(state.phase, 'speaking', 'still saying the last one');
  ({ state, did } = run([{ t: 'said', turn }], state));
  assert.equal(state.phase, 'speaking');
  ({ state, did } = run([{ t: 'said', turn }], state));
  assert.equal(state.phase, 'idle');
  assert.deepEqual(did, ['escape', 'end'], 'Escape is given back');
});

test('a press under half a second does nothing; held past it while the timer lost the race, it still counts', () => {
  const tap = run([{ t: 'down' }, { t: 'up', ms: HOLD_MS - 80 }]);
  assert.equal(tap.state.phase, 'idle');
  assert.deepEqual(tap.did, ['record', 'cancel', 'escape', 'end']);
  assert.equal(tap.effects.some(e => e.do === 'open' || e.do === 'finish'), false, 'never opened, never sent');
  const late = run([{ t: 'down' }, { t: 'up', ms: HOLD_MS + 20 }]);
  assert.equal(late.state.phase, 'transcribing');
  assert.deepEqual(late.did, ['record', 'open', 'escape', 'finish']);
  // The key repeating while held changes nothing.
  const repeat = run([{ t: 'down' }, { t: 'held' }, { t: 'down' }, { t: 'down' }]);
  assert.deepEqual(repeat.did, ['record', 'open', 'escape']);
});

test('nothing heard ends the turn without sending', () => {
  const { state, did } = run([{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 900 }, { t: 'heard', text: '  ' }]);
  assert.equal(state.phase, 'idle');
  assert.equal(did.includes('send'), false);
});

test('barge-in: holding the key while it speaks stops the voice at once and listens', () => {
  let { state } = run([{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 1500 }, { t: 'heard', text: 'Co teraz?' }, { t: 'text', d: 'Zrób koszyk. Potem ' }]);
  const first = state.turn;
  assert.equal(state.phase, 'speaking');
  let did;
  ({ state, did } = run([{ t: 'down' }], state));
  assert.equal(state.phase, 'pressed');
  assert.deepEqual(did, ['hush', 'record']);
  // What is left of the old reply, and its hushed sentences, change nothing now.
  ({ state, did } = run([{ t: 'text', d: 'faktura. ' }, { t: 'said', turn: first }, { t: 'done' }], state));
  assert.deepEqual(did, []);
  assert.equal(state.phase, 'pressed');
  // The new turn runs as any other, numbered on.
  let effects;
  ({ state, effects } = run([{ t: 'held' }, { t: 'up', ms: 1200 }, { t: 'heard', text: 'Nie, najpierw faktura.' }, { t: 'text', d: 'Jasne. ' }], state));
  assert.equal(state.turn, first + 1);
  assert.deepEqual(says(effects), [{ do: 'say', text: 'Jasne.', turn: first + 1, seq: 0 }]);
  // A tap during the reply stops the voice and nothing else: the reply goes on as text.
  ({ state, did } = run([{ t: 'down' }, { t: 'up', ms: 120 }], state));
  assert.deepEqual(did, ['hush', 'record', 'cancel', 'escape', 'end']);
  assert.equal(state.phase, 'idle');
});

test('Escape stops everything, in any phase', () => {
  for (const events of [
    [{ t: 'down' }, { t: 'held' }],
    [{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 900 }],
    [{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 900 }, { t: 'heard', text: 'Hej' }],
    [{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 900 }, { t: 'heard', text: 'Hej' }, { t: 'text', d: 'Hej. ' }],
  ]) {
    const { state, did } = run([...events, { t: 'escape' }]);
    assert.equal(state.phase, 'idle');
    assert.deepEqual(did.slice(-4), ['cancel', 'hush', 'escape', 'end']);
  }
  // And a reply still streaming after it is not spoken.
  const after = run([{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 900 }, { t: 'heard', text: 'Hej' }, { t: 'escape' }, { t: 'text', d: 'Cześć. Co tam? ' }, { t: 'done' }]);
  assert.equal(says(after.effects).length, 0);
  assert.deepEqual(run([{ t: 'escape' }]).did, [], 'idle stays idle');
});

test('a muted turn (a call, a meeting, presenting, switched off) streams as text and says nothing', () => {
  let { state } = run([{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 900 }, { t: 'heard', text: 'Co teraz?' }, { t: 'muted', why: 'call' }]);
  assert.equal(state.muted, 'call');
  let effects;
  ({ state, effects } = run([{ t: 'text', d: 'Zrób koszyk. ' }, { t: 'done' }], state));
  assert.equal(says(effects).length, 0);
  assert.equal(state.phase, 'idle', 'nothing to wait for');
  // Muted mid-sentence: the sentences out are hushed, each one still comes back as said.
  ({ state } = run([{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 900 }, { t: 'heard', text: 'A teraz?' }, { t: 'text', d: 'Raz. Dwa. ' }], state));
  assert.equal(state.out, 2);
  ({ state, effects } = run([{ t: 'muted', why: 'meeting' }, { t: 'text', d: 'Trzy. ' }, { t: 'done' }], state));
  assert.equal(says(effects).length, 0, 'nothing more is said');
  ({ state } = run([{ t: 'said', turn: state.turn }, { t: 'said', turn: state.turn }], state));
  assert.equal(state.phase, 'idle');
});

test('a failure ends the turn, and the reply failing ends it with what came', () => {
  assert.equal(run([{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 900 }, { t: 'failed' }]).state.phase, 'idle');
  const cut = run([{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 900 }, { t: 'heard', text: 'Hej' }, { t: 'text', d: 'Zaczynam' }, { t: 'done' }]);
  assert.deepEqual(says(cut.effects).map(s => s.text), ['Zaczynam'], 'the unfinished sentence is said at the end');
});
