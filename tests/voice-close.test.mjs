import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closing, wordsOf } from '../src/voice-close.ts';

const fresh = { follow: false, asked: false };
const after = { follow: true, asked: false };
const asked = { follow: true, asked: true };

test('words without punctuation, case or diacritics', () => {
  assert.deepEqual(wordsOf('Dzięki! That’s it.'), ['dzieki', 'thats', 'it']);
  assert.deepEqual(wordsOf('Dobra, załatwione'), ['dobra', 'zalatwione']);
});

test('a sign-off alone closes, in English and Polish, with fillers around it', () => {
  for (const said of ['Thanks.', 'Ok, that\'s it.', 'Okay thanks Jarvis', 'Great, thank you!', 'That will be all.',
    'No thanks', 'Perfect, I\'m good.', 'Bye', 'Dzięki.', 'Dobra, dzięki, to wszystko.', 'Okej, to tyle.',
    'Super, dziękuję bardzo', 'Nie, dzięki', 'Spoko, na razie', 'Jarvis, dzięki']) {
    assert.equal(closing(said, after), 'only', said);
    assert.equal(closing(said, fresh), 'only', `${said} (fresh)`);
  }
});

test('a request that ends in a sign-off is sent, then not followed', () => {
  assert.equal(closing('Add milk to the list, thanks', after), 'last');
  assert.equal(closing('Przesuń fakturę na jutro, dzięki, to wszystko', fresh), 'last');
  assert.equal(closing('Set a timer for ten minutes. That\'s it.', fresh), 'last');
});

test('anything else goes on', () => {
  for (const said of ['Co mam dziś?', 'Thanks for that, now what about Esono?', 'Dzięki, a co z fakturą?',
    'Remind me later', 'Stop the music', 'Okay, and what about tomorrow?', '']) {
    assert.equal(closing(said, after), null, said);
  }
});

test('after a question, a yes is an answer: sent, then closed', () => {
  assert.equal(closing('Ok', asked), 'last');
  assert.equal(closing('Tak, dzięki', asked), 'last');
  assert.equal(closing('Okay, thanks', asked), 'last');
  // "No thanks" to "Shall I…?" is a no: nothing to send.
  assert.equal(closing('No thanks', asked), 'only');
  // After a statement, "ok" is the end of it.
  assert.equal(closing('Ok', after), 'only');
  assert.equal(closing('Dobra', fresh), 'only');
});

test('stop and never mind end a follow-up, but said fresh they go to the Guardian', () => {
  assert.equal(closing('Never mind', after), 'only');
  assert.equal(closing('Stop', after), 'only');
  assert.equal(closing('Nieważne, zostaw', after), 'only');
  assert.equal(closing('Stop', fresh), null);
  assert.equal(closing('Anuluj', fresh), null);
});
