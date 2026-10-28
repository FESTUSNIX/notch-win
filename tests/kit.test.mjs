import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fold, trigger, matchProjects, matchCommands, leadingCommand, liveMentions, runs, outgoing,
  plural, clockOf, marks, dayName, isDay,
} from '../src/kit/words.ts';
import { pickMime, voiceProblem } from '../src/kit/voice.ts';

const projects = [
  { id: 3, name: 'Esono Rozwój', client: 'Esono', live: true },
  { id: 4, name: 'Esono Repricer', client: 'Esono', live: false },
  { id: 8, name: 'Akcesfonia', client: 'Akcesfonia', live: true },
  { id: 9, name: 'Online store', client: 'Ubrania', live: false },
  { id: 30, name: 'Codenotch', client: null, live: true },
];

test('an @ is a mention only at the start of a word, and only for a short while', () => {
  assert.deepEqual(trigger('Zrób to dla @eso', 16), { kind: '@', start: 12, query: 'eso' });
  assert.deepEqual(trigger('@', 1), { kind: '@', start: 0, query: '' });
  // Project names hold spaces.
  assert.deepEqual(trigger('dla @Esono Roz', 14), { kind: '@', start: 4, query: 'Esono Roz' });
  // An e-mail address is not a mention.
  assert.equal(trigger('napisz do jan@esono.pl', 22), null);
  // A sentence that happened to start with an @ stops being a query.
  assert.equal(trigger('@to jest już całe zdanie', 25), null);
  assert.equal(trigger('@a\nb', 4), null);
  // The caret decides: an @ after it is not being typed.
  assert.equal(trigger('dla @eso', 3), null);
});

test('a / is a command only at the start of the line', () => {
  assert.deepEqual(trigger('/', 1), { kind: '/', start: 0, query: '' });
  assert.deepEqual(trigger('/req', 4), { kind: '/', start: 0, query: 'req' });
  assert.deepEqual(trigger('  /no', 5), { kind: '/', start: 2, query: 'no' });
  assert.equal(trigger('a/b', 3), null, 'a slash inside a sentence is a slash');
  assert.equal(trigger('/request now', 12), null, 'once a word is finished, the menu is done');
});

test('projects match by words before letters, accents folded both ways', () => {
  const names = q => matchProjects(projects, q).map(hit => hit.project.name);
  // "eso" is in two names; Akcesfonia only has the letters scattered through it.
  assert.deepEqual(names('eso'), ['Esono Rozwój', 'Esono Repricer']);
  assert.equal(names('rozwoj')[0], 'Esono Rozwój', 'no accent typed, the accented name found');
  assert.equal(names('ROZWÓJ')[0], 'Esono Rozwój');
  assert.equal(names('ubrania')[0], 'Online store', 'the client finds its project');
  // Initials count as words: "er" is Esono Rozwój's, and inside "Repricer".
  assert.deepEqual(names('er').slice(0, 2).sort(), ['Esono Repricer', 'Esono Rozwój']);
  // With nothing typed the live ones lead, then the rest by name.
  assert.deepEqual(names('').slice(0, 3), ['Akcesfonia', 'Codenotch', 'Esono Rozwój']);
  // The loose match is the fallback, so a typo still finds something.
  assert.equal(names('akcfn')[0], 'Akcesfonia');
  assert.deepEqual(names('zzzz'), []);
});

test('the four commands, found by their word or their Polish name', () => {
  assert.equal(matchCommands('').length, 4);
  assert.deepEqual(matchCommands('re').map(c => c.command), ['request']);
  assert.deepEqual(matchCommands('not').map(c => c.command), ['note']);
  assert.deepEqual(matchCommands('zal').map(c => c.command), ['log'], 'Zaloguj czas');
  assert.deepEqual(matchCommands('do').map(c => c.command), ['todo'], 'Do zrobienia');
});

test('a command at the start is taken off the words and sent on its own', () => {
  assert.deepEqual(leadingCommand('/request Nowy koszyk'), { command: 'request', end: 8 });
  assert.equal(leadingCommand('/requests'), null, 'a word that merely starts like one is not one');
  assert.equal(leadingCommand('/delete x'), null, 'only the four Helm knows');
  const out = outgoing('/note  Klient woli wtorki @Esono Rozwój ', [{ projectId: 3, name: 'Esono Rozwój' }]);
  assert.deepEqual(out, { text: 'Klient woli wtorki @Esono Rozwój', command: 'note', mentions: [{ projectId: 3 }] });
  assert.deepEqual(outgoing('zwykła linijka', []), { text: 'zwykła linijka', command: null, mentions: [] });
});

test('a mention is its words: delete them and it is gone, and it is never sent twice', () => {
  const m = [{ projectId: 3, name: 'Esono Rozwój' }, { projectId: 8, name: 'Akcesfonia' }, { projectId: 3, name: 'Esono Rozwój' }];
  assert.deepEqual(liveMentions('dla @Esono Rozwój i @Akcesfonia', m).map(x => x.projectId), [3, 8]);
  assert.deepEqual(liveMentions('dla @Esono Roz', m), [], 'half a name is not a mention');
});

test('the mirror paints the command and the mentions as their own runs', () => {
  const parts = runs('/request Napraw @Esono Rozwój dziś', [{ projectId: 3, name: 'Esono Rozwój' }]);
  assert.deepEqual(parts.map(p => [p.kind, p.text]), [
    ['command', '/request'], ['plain', ' Napraw '], ['mention', '@Esono Rozwój'], ['plain', ' dziś'],
  ]);
  // The runs put back together are the text, character for character — or the pills drift.
  const text = '  /log 2 h dla @Akcesfonia, @Akcesfonia';
  assert.equal(runs(text, [{ projectId: 8, name: 'Akcesfonia' }]).map(p => p.text).join(''), text);
  // The longer of two names wins where both start at the same place.
  const both = runs('@Esono Repricer', [{ projectId: 99, name: 'Esono' }, { projectId: 4, name: 'Esono Repricer' }]);
  assert.deepEqual(both.map(p => p.kind === 'mention' ? p.projectId : p.text), [4]);
});

test('Polish plurals, a recording clock, and where a search hit is', () => {
  assert.deepEqual([1, 2, 4, 5, 12, 22, 25].map(n => plural(n, 'zmiana', 'zmiany', 'zmian')),
    ['zmiana', 'zmiany', 'zmiany', 'zmian', 'zmian', 'zmiany', 'zmian']);
  assert.equal(clockOf(7.9), '0:07');
  assert.equal(clockOf(102), '1:42');
  assert.equal(clockOf(-3), '0:00');
  assert.deepEqual(marks('Faktura dla Ubrania, fakturą', 'faktur'), [[0, 6], [21, 27]]);
  assert.deepEqual(marks('Kraków', 'krakow'), [[0, 6]], 'folded both ways');
  assert.deepEqual(marks('abc', ''), []);
  assert.equal(fold('Łódź'), 'lodz');
});

test('a day is named the way the thread names it', () => {
  assert.equal(dayName('2026-10-28', '2026-10-28'), 'Dziś');
  assert.equal(dayName('2026-10-27', '2026-10-28'), 'Wczoraj');
  assert.equal(dayName('2026-11-01', '2026-11-02'), 'Wczoraj', 'across a month');
  assert.match(dayName('2026-10-25', '2026-10-28'), /^\D+ 25 \D+$/);
  assert.ok(isDay('2026-10-27'));
  assert.ok(!isDay('2026-10-27T00'));
  assert.ok(!isDay('yesterday'));
});

test('the recording type is opus where the webview has it, and a refusal says why', () => {
  assert.equal(pickMime(m => m.startsWith('audio/webm')), 'audio/webm;codecs=opus');
  assert.equal(pickMime(m => m === 'audio/ogg;codecs=opus'), 'audio/ogg;codecs=opus');
  assert.equal(pickMime(() => false), '');
  assert.match(voiceProblem({ name: 'NotAllowedError' }), /Windows Settings/);
  assert.equal(voiceProblem({ name: 'NotFoundError' }), 'No microphone found');
  assert.equal(voiceProblem(new Error('x')), "The microphone didn't start");
});
