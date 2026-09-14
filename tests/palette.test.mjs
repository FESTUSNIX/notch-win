import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, rank, search } from '../src/palette-match.ts';

const best = (items, q) => search(items.map(title => ({title})), q).map(h => h.item.title);

test('a subsequence matches, because three letters have to get you there', () => {
  // Substring matching would make the palette a filter rather than a launcher.
  assert.ok(score('Create task', 'ctk'));
  assert.ok(score('Show in folder', 'sif'));
  assert.equal(score('Create task', 'xyz'), null);
  // Order matters: the characters have to appear in the order typed.
  assert.equal(score('Create task', 'ktc'), null);
});

test('an empty query matches everything, in the order it was given', () => {
  assert.deepEqual(best(['Home', 'Today', 'Agents'], ''), ['Home', 'Today', 'Agents']);
  assert.deepEqual(best(['Home', 'Today'], '   '), ['Home', 'Today']);
});

test('a match at the start beats one in the middle', () => {
  assert.deepEqual(best(['Open log', 'Reopen'], 'open')[0], 'Open log');
});

test('a word boundary beats the middle of a word', () => {
  // "sb" should find "Show Bluetooth", not "Absorb".
  assert.deepEqual(best(['Absorb', 'Show Bluetooth'], 'sb')[0], 'Show Bluetooth');
});

test('a consecutive run beats scattered letters', () => {
  assert.deepEqual(best(['Media', 'Move every display available'], 'med')[0], 'Media');
});

test('shorter wins a tie, so the specific thing is not buried', () => {
  assert.deepEqual(best(['Media', 'Media player volume settings'], 'media')[0], 'Media');
});

test('keywords match too, but count for less than the title', () => {
  const items = [
    {title: 'Review', keywords: 'day report'},
    {title: 'Day card', keywords: ''},
  ];
  // The title match wins outright.
  assert.equal(search(items, 'day')[0].item.title, 'Day card');
  // …but the keyword still gets Review into the list.
  assert.equal(search(items, 'day').length, 2);
  // ⚠️ Hits from a keyword are dropped: they index the keywords, not the
  // title, so highlighting with them lights up the wrong letters.
  assert.deepEqual(search(items, 'report')[0].match.hits, []);
});

test('hits point at the characters that matched, for highlighting', () => {
  const m = score('Open log', 'olg');
  assert.deepEqual(m.hits, [0, 5, 7]);
  assert.deepEqual([...'Open log'].filter((_, i) => m.hits.includes(i)).join(''), 'Olg');
});

test('the list is capped and stable', () => {
  const many = Array.from({length: 40}, (_, i) => ({title: `Task ${i}`}));
  assert.equal(search(many, 'task').length, 12);
  assert.equal(search(many, 'task', 3).length, 3);
  // Same query twice gives the same order — a list that reshuffles under the
  // cursor is worse than one that is merely imperfect.
  assert.deepEqual(search(many, 'ta').map(h => h.item.title), search(many, 'ta').map(h => h.item.title));
});
