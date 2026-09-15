import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteTitle, notePreview, fold, searchNotes, highlight, noteWhen } from '../src/notes.ts';

const note = (body, written = 0) => ({ id: body, body, written, edited: written });

test('the title is the first line that has anything on it', () => {
  assert.equal(noteTitle('ssh key for the pi\nroot@10.0.0.4'), 'ssh key for the pi');
  // ⚠️ Leading blank lines are what a paste looks like, not an empty note.
  assert.equal(noteTitle('\n\n  the actual line  \nmore'), 'the actual line');
  assert.equal(noteTitle(''), '');
  // Capped: a note opening with a pasted URL would push the date off the row
  // and take the rest of the list's alignment with it.
  const long = 'x'.repeat(200);
  assert.equal(noteTitle(long, 20).length, 20);
  assert.ok(noteTitle(long, 20).endsWith('…'));
});

test('the preview is everything after the title, on one line', () => {
  // ⚠️ Newlines collapsed. The row is one line tall, so a preview containing
  // `\n` renders as the first word and a lot of nothing.
  assert.equal(notePreview('title\nsecond\nthird'), 'second third');
  assert.equal(notePreview('only a title'), '');
  assert.equal(notePreview(''), '');
});

test('search folds the accents off, so Krakow finds Krakow', () => {
  /* ⚠️ The whole reason this is not `body.includes(query)`. Half of what gets
     written down on this machine is Polish, and a search that only matches if
     you reproduce the diacritics is one you have to know the answer to use. */
  const notes = [note('spotkanie w Krakowie'), note('lunch in Gdańsk')];
  assert.equal(searchNotes(notes, 'krakowie').length, 1);
  assert.equal(searchNotes(notes, 'Kraków'.slice(0, 4)).length, 1);
  assert.equal(searchNotes(notes, 'gdansk').length, 1);
  assert.equal(searchNotes(notes, 'Gdańsk').length, 1);
  assert.equal(fold('Kraków'), 'krakow');
});

test('every word, anywhere, in any order', () => {
  /* You remember a note as "that ssh thing for the pi", and requiring those
     characters in that order finds nothing. */
  const notes = [note('ssh key for the raspberry pi'), note('pi day pastry recipe')];
  assert.equal(searchNotes(notes, 'pi ssh')[0].body, 'ssh key for the raspberry pi');
  assert.equal(searchNotes(notes, 'pi').length, 2);
  // A word that is nowhere drops the note, even if the others match.
  assert.equal(searchNotes(notes, 'pi mars').length, 0);
  // An empty query is not a filter.
  assert.equal(searchNotes(notes, '   ').length, 2);
});

test('the highlight returns the original text, split, and never loses a character', () => {
  const parts = highlight('ssh key for the pi', 'key pi');
  // Alternating plain/matched starting plain, so the caller needs no second pass.
  assert.equal(parts.join(''), 'ssh key for the pi');
  assert.deepEqual(parts, ['ssh ', 'key', ' for the ', 'pi', '']);

  /* ⚠️ Overlapping hits are merged. Two words sharing letters produce runs that
     slice each other in half, and the output then stops being the input. */
  const overlap = highlight('abcdef', 'abcd cdef');
  assert.equal(overlap.join(''), 'abcdef');
  assert.deepEqual(overlap, ['', 'abcdef', '']);

  // Repeated words are matched every time they appear.
  assert.equal(highlight('pi and pi', 'pi').filter((_, i) => i % 2).join('|'), 'pi|pi');

  /* Accented text highlights correctly, and this is the case worth pinning:
     `ó` composed is ONE code point, and folding it leaves one (`o`) — so the
     offsets still line up and `krakow` lights up `Kraków`. */
  assert.deepEqual(highlight('Kraków', 'krakow'), ['', 'Kraków', '']);

  /* ⚠️ But text that arrives already DECOMPOSED folds shorter than it is —
     `o` + a combining acute is two code points and becomes one — so the offsets
     no longer line up and the body is handed back whole. The highlight is a
     nicety; showing the wrong characters is not. */
  const decomposed = 'Kraków';
  assert.notEqual(decomposed.length, fold(decomposed).length);
  assert.deepEqual(highlight(decomposed, 'krakow'), [decomposed]);
  assert.deepEqual(highlight('nothing here', 'zzz'), ['nothing here']);
  assert.deepEqual(highlight('anything', '  '), ['anything']);
});

test('how long ago, not at what time', () => {
  const now = Date.parse('2026-09-15T16:00:00');
  assert.equal(noteWhen(now - 20_000, now), 'just now');
  assert.equal(noteWhen(now - 14 * 60_000, now), '14 min');
  assert.equal(noteWhen(now - 3 * 3_600_000, now), '3 h');
  /* Past a day it is a weekday, and past a week a date. ⚠️ Asserted as "has
     no digits" rather than as a length: this machine's locale is Polish and
     `weekday: "short"` there is `niedz.` — six characters with a full stop. A
     test that assumed two to four passed in English and nowhere else. */
  assert.doesNotMatch(noteWhen(now - 2 * 86_400_000, now), /\d/);
  assert.match(noteWhen(now - 30 * 86_400_000, now), /\d/);
  // ⚠️ A clock skew must not print "-3 min".
  assert.equal(noteWhen(now + 60_000, now), 'just now');
});
