import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GabiDesk, GABI_REPLIES, NOTE_FOLD_MS, eventPeek, gabiIdOf, gabiKey, noteMoment, photoPeek, reactionPeek, readGabi, replyOf,
} from '../src/gabi-logic.ts';
import { MomentQueue } from '../src/moments.ts';
import { PeekQueue } from '../src/peeks.ts';
import { peekFace } from '../src/face-mood.ts';

const n = (id, style, extra = {}) => ({ id, style, title: 'Gabi', line: 'x', fun: null, photoId: null, icon: 'heart', tone: 'gabi', at: '', ...extra });
const hearts = (id) => n(id, 'reaction', { fun: 'hearts' });

test('only what is really hers is read; junk drops rather than draws', () => {
  assert.deepEqual(readGabi(null), []);
  assert.deepEqual(readGabi({ notes: 'no' }), []);
  const list = readGabi({ notes: [
    { id: 1, style: 'note', title: 'Gabi', line: 'Hej', fun: 'nope', icon: 'nope', tone: 'nope' },
    { id: 'x', style: 'note', title: 'Gabi' },
    { id: 2, style: 'nope', title: 'Gabi' },
    null,
  ] });
  assert.equal(list.length, 1);
  assert.equal(list[0].fun, null, 'an unknown fun plays nothing');
  assert.equal(list[0].icon, 'heart');
  assert.equal(list[0].tone, 'gabi');
});

test('hearts in a row are one rain; a different fun waits its turn', () => {
  const desk = new GabiDesk();
  desk.read([hearts(1), hearts(2), n(3, 'reaction', { fun: 'confetti' }), hearts(4)]);
  assert.deepEqual(desk.dueReactions().map(x => x.id), [1, 2]);
  desk.markPlayed(1); desk.markPlayed(2);
  assert.deepEqual(desk.dueReactions().map(x => x.id), [3]);
  desk.markPlayed(3);
  assert.deepEqual(desk.dueReactions().map(x => x.id), [4]);
  desk.markPlayed(4);
  assert.deepEqual(desk.dueReactions(), []);
  // The next reading still lists them until seen reaches Helm: they don't play twice.
  desk.read([hearts(1), hearts(2), n(3, 'reaction', { fun: 'confetti' }), hearts(4)]);
  assert.deepEqual(desk.dueReactions(), []);
  assert.equal(desk.hasWork(), false);
});

test('words before a picture, each opened once', () => {
  const desk = new GabiDesk();
  desk.read([n(1, 'photo', { photoId: 9 }), n(2, 'note')]);
  assert.equal(desk.dueNote().id, 2);
  desk.markShown(2);
  assert.equal(desk.dueNote().id, 1);
  desk.markShown(1);
  assert.equal(desk.dueNote(), null);
});

test('the heart counts what folded unanswered, not what is up or still to come', () => {
  const desk = new GabiDesk();
  desk.read([n(1, 'note'), n(2, 'note'), n(3, 'note'), hearts(4)]);
  assert.deepEqual(desk.unanswered(new Set()), [], 'nothing has opened yet');
  desk.markShown(1);
  assert.deepEqual(desk.unanswered(new Set([1])), [], 'open, it is the note');
  assert.deepEqual(desk.unanswered(new Set()).map(x => x.id), [1], 'folded, it is the heart');
  desk.markShown(2);
  assert.deepEqual(desk.unanswered(new Set()).map(x => x.id), [1, 2]);
});

test('an answer is gone at once, and a stale reading cannot bring it back', () => {
  const desk = new GabiDesk();
  const note = n(1, 'note');
  desk.read([note]);
  desk.markShown(1);
  desk.answer(1);
  assert.equal(desk.has(1), false);
  desk.read([note]);
  assert.equal(desk.has(1), false, 'a reading from before the answer');
  assert.equal(desk.dueNote(), null);
  desk.read([]);
  desk.read([note]);
  assert.equal(desk.has(1), true, 'once Helm dropped it the memory goes (the ids never come back in real life)');
});

test('an answer that did not reach Helm is owed again, and goes back to the heart, not the island', () => {
  const desk = new GabiDesk();
  const note = n(1, 'note');
  desk.read([note]);
  desk.markShown(1);
  desk.answer(1);
  desk.restore(note);
  assert.equal(desk.dueNote(), null);
  assert.deepEqual(desk.unanswered(new Set()).map(x => x.id), [1]);
});

test('answered on the phone: gone from the desk with the next reading', () => {
  const desk = new GabiDesk();
  desk.read([n(1, 'note')]);
  desk.markShown(1);
  desk.read([]);
  assert.equal(desk.has(1), false);
  assert.deepEqual(desk.unanswered(new Set()), []);
});

test('a note folds after twelve seconds, is held by the pointer, and outranks everything', () => {
  const q = new MomentQueue();
  const note = noteMoment(n(1, 'note', { line: 'Hej' }), 0);
  assert.equal(note.sticky, false);
  assert.equal(note.foldMs, NOTE_FOLD_MS);
  q.push({ key: 'meeting:1', kind: 'meeting', icon: 'calendar', title: 'Spotkanie', line: '', buttons: [], sticky: false, at: 0 });
  q.push(note);
  assert.equal(q.step(0, { blocked: false, hovering: false }).key, gabiKey(1));
  assert.equal(q.step(NOTE_FOLD_MS - 1, { blocked: false, hovering: true }).key, gabiKey(1));
  assert.equal(q.step(NOTE_FOLD_MS + 1, { blocked: false, hovering: true }).key, gabiKey(1), 'the pointer holds it');
  q.step(NOTE_FOLD_MS + 2, { blocked: false, hovering: false });
  assert.equal(q.step(NOTE_FOLD_MS + 3000, { blocked: false, hovering: false }).key, 'meeting:1', 'folded, the next one comes');
});

test('held for a long call, hers is still there after; anything else that waited is not', () => {
  const q = new MomentQueue();
  const hour = 60 * 60_000;
  q.push(noteMoment(n(1, 'note'), 0));
  q.push({ key: 'usage', kind: 'usage', icon: 'agent', title: 'x', line: '', buttons: [], sticky: false, at: 0 });
  assert.equal(q.step(hour, { blocked: true, hovering: false }), null);
  assert.equal(q.step(hour * 2, { blocked: true, hovering: false }), null);
  assert.equal(q.step(hour * 2 + 1, { blocked: false, hovering: false }).key, gabiKey(1));
  assert.equal(q.queued().length, 0, 'the old news went');
});

test('her buttons: the quick answers as chips, Odpisz apart, and each says what it sends', () => {
  const m = noteMoment(n(1, 'note'), 0);
  assert.deepEqual(m.buttons.filter(b => b.chip).map(b => b.label), GABI_REPLIES);
  assert.deepEqual(m.buttons.filter(b => !b.chip).map(b => b.id), ['gabi:write']);
  assert.equal(replyOf('gabi:reply:0'), '❤️');
  assert.equal(replyOf('gabi:reply:9'), null);
  assert.equal(replyOf('gabi:write'), null);
  assert.equal(gabiIdOf(m.key), 1);
  assert.equal(gabiIdOf('helm:1'), null);
});

test('a photo is not kept for the wheel; the pill never holds a picture past its second and a half', () => {
  const q = new PeekQueue();
  const shot = photoPeek(n(1, 'photo', { photoId: 9, line: '' }), 'data:image/jpeg;base64,x');
  assert.equal(shot.line, 'Nowe zdjęcie');
  q.push(shot, 0);
  assert.equal(q.step(0, false).id, shot.id);
  assert.deepEqual(q.recent, [], 'nothing to replay after it expires');
  const moment = noteMoment(n(1, 'photo', { photoId: 9 }), 0, 'data:image/jpeg;base64,x');
  assert.equal(moment.photo, 'data:image/jpeg;base64,x');
});

test('her fund and her lock: one pulse, no buttons, shown even in quiet hours; his face only for the kind ones', () => {
  const penalty = eventPeek(n(1, 'event', { title: '−50 zł · Gabi', line: 'YouTube', icon: 'money', tone: 'hot' }));
  assert.equal(penalty.pulse, true);
  assert.equal(penalty.urgent, true);
  assert.equal(penalty.action, undefined, 'he cannot undo hers');
  assert.equal(peekFace(penalty), null);
  assert.equal(peekFace(eventPeek(n(2, 'event', { icon: 'lock', tone: 'warn' }))), null);
  assert.deepEqual(peekFace(reactionPeek(hearts(3), 1)), { flash: 'love' });
  assert.deepEqual(peekFace(eventPeek(n(4, 'event', { icon: 'money', tone: 'gabi' }))), { flash: 'love' });
  assert.match(reactionPeek(hearts(5), 3).line, /×3$/);
});
