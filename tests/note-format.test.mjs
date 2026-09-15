import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spans, blocks, plain, toggleMark, toggleList } from '../src/note-format.ts';

const marks = (line) => spans(line).map(s => {
  const kind = ['bold', 'italic', 'code', 'strike'].find(k => s[k]) ?? '';
  return kind ? `${kind}:${s.text}` : s.text;
});

test('bold wins over italic, because ** is two of *', () => {
  /* ⚠️ `**` has to be tried before `*` or `**bold**` matches as two empty
     italic runs. Order in an alternation is order of preference, which is the
     whole reason this is one regex and not four passes. */
  assert.deepEqual(marks('a **b** c'), ['a ', 'bold:b', ' c']);
  assert.deepEqual(marks('*just italic*'), ['italic:just italic']);
  assert.deepEqual(marks('`code` and ~~gone~~'), ['code:code', ' and ', 'strike:gone']);
});

test('arithmetic is not italics', () => {
  /* ⚠️ The content may not begin or end with a space, or `5 * 3 * 2` is an
     italic run — and a sum turning into a sentence in italics is exactly the
     sort of note this is for. */
  assert.deepEqual(marks('5 * 3 * 2 = 30'), ['5 * 3 * 2 = 30']);
  assert.deepEqual(marks('2*3*4'), ['2', 'italic:3', '4']);
  // An unclosed marker is the characters it is, not a run to the end.
  assert.deepEqual(marks('**not closed'), ['**not closed']);
  assert.deepEqual(marks('a ** b'), ['a ** b']);
});

test('a code run is literal all the way down', () => {
  /* ⚠️ Somebody writing `` `**not bold**` `` is showing you the characters.
     Formatting inside there is the one failure that makes the feature useless
     for what it is most used for. */
  assert.deepEqual(marks('`**not bold**`'), ['code:**not bold**']);
});

test('blocks: lists, numbers, quotes, headings — and blank lines are not blocks', () => {
  const out = blocks('# Title\n\n- one\n- two\n\n1. first\n3. third\n\n> quoted\n\nplain');
  assert.deepEqual(out.map(b => b.kind),
    ['head', 'bullet', 'bullet', 'number', 'number', 'quote', 'para']);
  /* ⚠️ A blank line separates blocks and is not one. A paragraph drawn for
     each gap is how a five-line note becomes a screen tall. */
  assert.equal(out.filter(b => b.spans.every(s => !s.text.trim())).length, 0);
  // A list starting at 3 starts at 3.
  assert.deepEqual(out.filter(b => b.kind === 'number').map(b => b.index), [1, 3]);
  // `*` opens a bullet at the start of a line and italicises inside one.
  assert.equal(blocks('* a bullet')[0].kind, 'bullet');
  assert.equal(blocks('- with *stress*')[0].spans[1].italic, true);
});

test('a fence is literal, markers and all', () => {
  const out = blocks('before\n```\nrm -rf *\n**still literal**\n```\nafter');
  assert.deepEqual(out.map(b => b.kind), ['para', 'code', 'code', 'para']);
  assert.equal(out[1].spans[0].text, 'rm -rf *');
  assert.equal(out[2].spans[0].text, '**still literal**');
  assert.equal(out[2].spans[0].bold, undefined);
});

test('plain() is what search runs on', () => {
  /* ⚠️ Otherwise `**every**` is found by typing `**every**` and not by typing
     `every`, which is the one query anybody would use. */
  assert.equal(plain('- buy **milk**'), 'buy milk');
  assert.equal(plain('# Head\n\n> a `quote`'), 'Head\na quote');
});

test('toggleMark puts the caret between the markers, not after them', () => {
  /* ⚠️ Pressing bold and then typing is what everybody does; markers with the
     caret behind them produce `**` followed by unbolded words. */
  const empty = toggleMark('ab', 1, 1, '**');
  assert.equal(empty.body, 'a****b');
  assert.equal(empty.from, 3);
  assert.equal(empty.to, 3);

  const wrapped = toggleMark('a word b', 2, 6, '**');
  assert.equal(wrapped.body, 'a **word** b');
  assert.equal(wrapped.body.slice(wrapped.from, wrapped.to), 'word');

  // Pressing it again takes it off, whether the markers are inside the
  // selection or just outside it.
  // `a **word** b` — `word` is 4..8, the markers either side of it.
  const off = toggleMark('a **word** b', 4, 8, '**');
  assert.equal(off.body, 'a word b');
  assert.equal(off.body.slice(off.from, off.to), 'word');
  const offOutside = toggleMark('a **word** b', 2, 10, '**');
  assert.equal(offOutside.body, 'a word b');
});

test('toggleList works on whole lines and comes back off', () => {
  const on = toggleList('one\ntwo', 0, 7);
  assert.equal(on.body, '- one\n- two');
  const off = toggleList(on.body, 0, on.body.length);
  assert.equal(off.body, 'one\ntwo');
  // A caret with no selection still marks the line it is on.
  assert.equal(toggleList('one\ntwo', 5, 5).body, 'one\n- two');
  // ⚠️ A blank line in the middle is left alone rather than given a bullet.
  assert.equal(toggleList('one\n\ntwo', 0, 8).body, '- one\n\n- two');
});
