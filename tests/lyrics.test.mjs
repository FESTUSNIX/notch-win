import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineAt, parseLrc, worth } from '../src/lyrics.ts';

test('the three stamp shapes all parse', () => {
  const lines = parseLrc([
    '[00:12.34]one',
    '[01:05.678]two',
    '[02:00]three',
    '[100:01.00]long',
  ].join('\n'));
  assert.deepEqual(lines.map(l => l.at), [12.34, 65.678, 120, 6001]);
  assert.deepEqual(lines.map(l => l.text), ['one', 'two', 'three', 'long']);
});

test('metadata headers are not lines', () => {
  /* ⚠️ Told apart from a timestamp by what is LEFT of the colon: `[id:1]` is a
   * header and `[01:23]` is not, and nothing else distinguishes them. */
  const lines = parseLrc([
    '[ar:Someone]', '[ti:A Song]', '[length:03:21]', '[by:nobody]',
    '[00:01.00]words',
  ].join('\n'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'words');
});

test('the offset header shifts the words, not the clock', () => {
  /* ⚠️ A POSITIVE offset means the words come EARLIER. The tag says "shift the
   * lyrics", which is the opposite of what the sign reads like. */
  const early = parseLrc('[offset:+500]\n[00:10.00]now');
  assert.equal(early[0].at, 9.5);
  const late = parseLrc('[offset:-500]\n[00:10.00]now');
  assert.equal(late[0].at, 10.5);
  // And it can never push a line before the start of the track.
  assert.equal(parseLrc('[offset:+20000]\n[00:01.00]now')[0].at, 0);
});

test('a repeated chorus carries several stamps, and they come back in order', () => {
  const lines = parseLrc('[02:00.00][00:30.00][01:15.00]chorus\n[00:10.00]verse');
  assert.deepEqual(lines.map(l => l.at), [10, 30, 75, 120]);
  assert.equal(lines.filter(l => l.text === 'chorus').length, 3);
});

test('a bracket inside the words is not a second stamp', () => {
  /* ⚠️ Only the stamps at the FRONT count. A quoted time in a lyric, or a
   * `[Chorus]` marker, would otherwise print the rest of the song against the
   * wrong minute. */
  const lines = parseLrc('[00:05.00]we said [00:30.00] and left');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].at, 5);
  assert.equal(lines[0].text, 'we said [00:30.00] and left');
});

test('anything unparseable is dropped rather than guessed at', () => {
  assert.deepEqual(parseLrc(''), []);
  assert.deepEqual(parseLrc('just some words\n\n   \n'), []);
  // An explicit empty line at a real time is a gap, and gaps are kept.
  const gap = parseLrc('[00:10.00]\n[00:20.00]words');
  assert.equal(gap.length, 2);
  assert.equal(gap[0].text, '');
});

test('the current line is the one that has STARTED, not the nearest', () => {
  const lines = parseLrc('[02:10.00]a\n[02:16.00]b');
  // 2:13 is closer to 2:16 and the answer is still 2:10.
  assert.equal(lineAt(lines, 133), 0);
  assert.equal(lineAt(lines, 136), 1);
  assert.equal(lineAt(lines, 130), 0, 'exactly on the stamp');
  // ⚠️ Before the first one there is no line, which is not line zero.
  assert.equal(lineAt(lines, 0), -1);
  assert.equal(lineAt([], 99), -1);
});

test('a stub is not a lyric', () => {
  /* LRCLIB answers for instrumentals, and with near-empty files where somebody
   * uploaded a stub: one stamp holding the title is a metadata record. */
  assert.equal(worth(parseLrc('[00:01.00]Some Song')), false);
  assert.equal(worth(parseLrc('[00:01.00]\n[00:30.00]\n[01:00.00]')), false);
  assert.equal(worth(parseLrc('[00:01.00]one\n[00:05.00]two')), true);
});
