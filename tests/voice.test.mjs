import { test } from 'node:test';
import assert from 'node:assert/strict';
import { step, idle, takeSentences, speakable, wordsOf, revealMs, HOLD_MS } from '../src/voice-turn.ts';

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
/** The keys asked for, in order, as `e` (Escape), `ee` (Escape and Enter) or `-` (none). */
const keyTrail = effects => effects.filter(e => e.do === 'keys').map(e => e.enter ? 'ee' : e.escape ? 'e' : '-').join(' ');

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
  assert.deepEqual(did, ['open', 'keys']);
  assert.equal(state.free, false, 'held, not hands-free');
  ({ state, did } = run([{ t: 'up', ms: 2400 }], state));
  assert.equal(state.phase, 'transcribing');
  assert.deepEqual(did, ['keys', 'finish']);
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
  assert.deepEqual(did, ['keys', 'end'], 'the keys are given back');
});

test('a press under half a second starts hands-free; held past it while the timer lost the race, it still counts', () => {
  const tap = run([{ t: 'down' }, { t: 'up', ms: HOLD_MS - 80 }]);
  assert.equal(tap.state.phase, 'listening');
  assert.equal(tap.state.free, true);
  assert.deepEqual(tap.did, ['record', 'open', 'keys'], 'the microphone from the press is kept: nothing is cancelled');
  assert.equal(keyTrail(tap.effects), 'ee', 'Enter and Escape are taken for it');
  const late = run([{ t: 'down' }, { t: 'up', ms: HOLD_MS + 20 }]);
  assert.equal(late.state.phase, 'transcribing');
  assert.deepEqual(late.did, ['record', 'open', 'keys', 'finish']);
  // The key repeating while held changes nothing.
  const repeat = run([{ t: 'down' }, { t: 'held' }, { t: 'down' }, { t: 'down' }]);
  assert.deepEqual(repeat.did, ['record', 'open', 'keys']);
});

test('hands-free: Enter or another tap sends, Escape drops it, and it never stops by itself before five minutes', () => {
  const free = run([{ t: 'down' }, { t: 'up', ms: 150 }]).state;
  // Enter sends: Enter goes back at once, Escape stays for the reply.
  let { state, effects, did } = run([{ t: 'enter' }], free);
  assert.equal(state.phase, 'transcribing');
  assert.deepEqual(did, ['keys', 'finish']);
  assert.equal(keyTrail(effects), 'e');
  // Another tap sends on its PRESS; its release changes nothing.
  ({ state, did } = run([{ t: 'down' }, { t: 'up', ms: 90 }], free));
  assert.equal(state.phase, 'transcribing');
  assert.deepEqual(did, ['keys', 'finish']);
  // Escape drops it: nothing is sent.
  ({ state, did } = run([{ t: 'escape' }], free));
  assert.equal(state.phase, 'idle');
  assert.deepEqual(did, ['cancel', 'hush', 'keys', 'end']);
  // The recording's own end (five minutes, a microphone gone) sends what came.
  ({ state, did } = run([{ t: 'stop' }], free));
  assert.equal(state.phase, 'transcribing');
  // Enter means nothing outside hands-free.
  assert.deepEqual(run([{ t: 'down' }, { t: 'held' }, { t: 'enter' }]).state.phase, 'listening');
  assert.deepEqual(run([{ t: 'enter' }]).did, []);
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
  // A tap during the reply stops the voice and nothing else: the reply goes on as text, never hands-free.
  ({ state, did } = run([{ t: 'down' }, { t: 'up', ms: 120 }], state));
  assert.deepEqual(did, ['hush', 'record', 'cancel', 'keys', 'end']);
  assert.equal(state.phase, 'idle');
  assert.equal(state.free, false);
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
    assert.deepEqual(did.slice(-4), ['cancel', 'hush', 'keys', 'end']);
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

/* ── Turn after turn (29 Oct, round 2) ─────────────────────────────────────
 * ⚠️ The regression for "it recorded the first time, now it doesn't": every
 * press after the first must open the microphone again and every turn must
 * end idle with the keys given back — hold, the reply, hold again, a barge-in,
 * Escape, hands-free, and a hold once more. */

test('turn after turn: every press records again, every turn ends idle and gives the keys back', () => {
  let state = idle();
  const all = [];
  const go = events => { const r = run(events, state); state = r.state; all.push(...r.effects); return r; };
  const reply = sentences => {
    const turn = state.turn;
    go(sentences.map(d => ({ t: 'text', d })));
    go([{ t: 'done' }]);
    while (state.phase === 'speaking') go([{ t: 'said', turn }]);
  };
  // 1. Hold, speak, let go; the reply is said.
  go([{ t: 'down' }, { t: 'held' }, { t: 'up', ms: 2100 }, { t: 'heard', text: 'Co mam dziś?' }]);
  reply(['Masz dwie rzeczy. ', 'Najpierw koszyk.']);
  assert.equal(state.phase, 'idle');
  // 2. Hold again after the reply.
  let r = go([{ t: 'down' }]);
  assert.deepEqual(r.did, ['record'], 'the second press opens the microphone again');
  go([{ t: 'held' }, { t: 'up', ms: 1800 }, { t: 'heard', text: 'A potem?' }, { t: 'text', d: 'Potem faktura. Później ' }]);
  assert.equal(state.phase, 'speaking');
  // 3. Barge-in: held while it speaks.
  r = go([{ t: 'down' }]);
  assert.deepEqual(r.did, ['hush', 'record']);
  go([{ t: 'held' }, { t: 'up', ms: 1500 }, { t: 'heard', text: 'Stop, zmiana planu.' }]);
  reply(['Jasne.']);
  assert.equal(state.phase, 'idle');
  // 4. A hold Escape ends.
  r = go([{ t: 'down' }, { t: 'held' }, { t: 'escape' }, { t: 'up', ms: 1200 }]);
  assert.deepEqual(r.did, ['record', 'open', 'keys', 'cancel', 'hush', 'keys', 'end'], 'the release after Escape changes nothing');
  assert.equal(state.phase, 'idle');
  // 5. Hands-free: a tap, then Enter.
  go([{ t: 'down' }, { t: 'up', ms: 140 }]);
  assert.equal(state.free, true);
  go([{ t: 'enter' }, { t: 'heard', text: 'Długa wiadomość.' }]);
  reply(['Zapisane.']);
  // 6. And a hold once more.
  r = go([{ t: 'down' }]);
  assert.deepEqual(r.did, ['record'], 'still records on the sixth press');
  go([{ t: 'held' }, { t: 'up', ms: 900 }, { t: 'heard', text: 'Dzięki.' }]);
  reply(['Proszę.']);
  assert.equal(state.phase, 'idle');
  assert.equal(all.filter(e => e.do === 'record').length, 6, 'six presses, six recordings');
  assert.equal(all.filter(e => e.do === 'send').length, 5, 'five sent; the Escaped one was not');
  assert.equal(all.filter(e => e.do === 'end').length, 5, 'every turn ended (the barged one ran straight into the next)');
  assert.deepEqual(all.filter(e => e.do === 'keys').at(-1), { do: 'keys', escape: false, enter: false }, 'nothing is held at the end');
  assert.equal(all.filter(e => e.do === 'keys' && e.enter).length, 1, 'Enter only for the hands-free turn');
});

test('the reply on the glance: plain words, the last one held back until it is whole', () => {
  assert.deepEqual(wordsOf('Dobrze, przesun', false), { words: ['Dobrze, ', 'przesun'], whole: 1 });
  assert.equal(wordsOf('Dobrze, przesunąłem ', false).whole, 2);
  assert.equal(wordsOf('Dobrze, przesun', true).whole, 2, 'the reply is done: the last word is whole');
  // Markers go one by one, so a word on screen keeps its shape when the closing ** arrives.
  assert.deepEqual(wordsOf('**Repricer', false).words, ['Repricer']);
  assert.deepEqual(wordsOf('**Repricer** jutro', true).words, ['Repricer ', 'jutro']);
  assert.deepEqual(wordsOf('Zobacz [fakturę](https://helm/x) teraz', true).words, ['Zobacz ', 'fakturę ', 'teraz']);
  assert.deepEqual(wordsOf('- Raz\n- dwa', true).words, ['Raz ', 'dwa']);
  assert.deepEqual(wordsOf('', true), { words: [], whole: 0 });
});

test('the words keep roughly in step with the voice, and never fall a sentence behind', () => {
  const said = revealMs('przesunąłem ', true, 0);
  assert.ok(said > 500 && said < 900, `a long word read out loud takes most of a second (${said})`);
  assert.ok(revealMs('a ', true, 0) >= 110, 'a short one still has a beat');
  assert.ok(revealMs('przesunąłem ', true, 30) < said / 2, 'a backlog drains faster');
  assert.ok(revealMs('przesunąłem ', false, 0) < 60, 'text only flows in quickly');
});

/* ── The recorder (kit/voice.ts), with a fake microphone ───────────────────
 * ⚠️ The two ways the first build wedged, reproduced: a press while the last
 * start is still opening, and a microphone that stops by itself. */

function fakeMicrophone() {
  const timers = [];
  const pending = [];
  const recorders = [];
  globalThis.window = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].live = false; },
  };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  class FakeTrack {
    onended = null;
    stopped = false;
    stop() { this.stopped = true; }
  }
  class FakeStream {
    tracks = [new FakeTrack()];
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks; }
  }
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    ondataavailable = null;
    onstop = null;
    constructor(stream) { this.stream = stream; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      // As the spec has it: on an inactive recorder nothing fires at all.
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['opus-bytes']) });
      queueMicrotask(() => this.onstop?.());
    }
    /** The device went away: the recorder stops by itself and says so once. */
    lose() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['some']) });
      this.onstop?.();
      this.stream.tracks[0].onended?.();
    }
  }
  globalThis.MediaRecorder = FakeRecorder;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: () => new Promise(resolve => pending.push(() => resolve(new FakeStream()))) } },
  });
  const flush = () => new Promise(done => setImmediate(done));
  const fire = ms => { for (const t of timers) if (t.live && t.ms === ms) { t.live = false; t.fn(); } };
  return { pending, recorders, flush, fire };
}

test('a press while the microphone is still opening after a tap adopts it, and records', async () => {
  const mic = fakeMicrophone();
  const { Recorder } = await import('../src/kit/voice.ts');
  const rec = new Recorder();
  // A tap (stopping the voice): asked for, then cancelled before the device answered.
  const first = rec.start();
  rec.cancel();
  // He answers straight away: the second press must not be thrown away.
  const second = rec.start();
  mic.pending.shift()();
  await first;
  await second;
  await mic.flush();
  assert.equal(rec.state, 'recording', 'the open in flight was adopted by the second press');
  assert.equal(mic.pending.length, 0, 'one open, not two');
  rec.startedAt -= 2000;
  const recording = await rec.finish();
  assert.ok(recording && recording.blob.size > 0, 'and what he said is there');
  assert.equal(rec.state, 'idle');
});

test('a microphone that stops by itself ends the recording instead of wedging it', async () => {
  const mic = fakeMicrophone();
  const { Recorder } = await import('../src/kit/voice.ts');
  const rec = new Recorder();
  let lost = 0;
  rec.onLost = () => lost++;
  const started = rec.start();
  mic.pending.shift()();
  await started;
  rec.startedAt -= 3000;
  mic.recorders.at(-1).lose();
  assert.equal(lost, 1, 'said once');
  // ⚠️ The first build waited here for ever: stop() on an inactive recorder fires nothing.
  const recording = await rec.finish();
  assert.ok(recording && recording.blob.size > 0, 'what came before it stopped is kept');
  assert.equal(rec.state, 'idle');
  // And the next press records again.
  const again = rec.start();
  mic.pending.shift()();
  await again;
  assert.equal(rec.state, 'recording');
  rec.cancel();
});

test('a microphone that never opens is given up on, and the next press can try again', async () => {
  const mic = fakeMicrophone();
  const { Recorder, OPEN_SECONDS, voiceProblem } = await import('../src/kit/voice.ts');
  const rec = new Recorder();
  const started = rec.start();
  mic.fire(OPEN_SECONDS * 1000);
  await assert.rejects(started, error => error.name === 'TimeoutError');
  assert.equal(voiceProblem({ name: 'TimeoutError' }), 'The microphone didn’t start in time'.replace('’', "'"));
  assert.equal(rec.state, 'idle', 'not stuck "starting"');
  // The late answer is let go, not left recording.
  const late = mic.pending.shift();
  late();
  await mic.flush();
  assert.equal(rec.state, 'idle');
  const again = rec.start();
  mic.pending.shift()();
  await again;
  assert.equal(rec.state, 'recording');
  rec.cancel();
});
