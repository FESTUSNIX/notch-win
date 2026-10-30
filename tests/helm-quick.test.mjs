import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuick, takeMinutes, takeDay, takeProject } from '../src/helm-quick.ts';

// 2026-10-30 is a Friday.
const today = '2026-10-30';
const projects = [{ id: 3, name: 'Esono Rozwój' }, { id: 4, name: 'Esono Repricer' }, { id: 5, name: 'sonocars' }, { id: 30, name: 'Codenotch' }];
const q = (line, mentioned) => parseQuick(line, { projects, mentioned, today });

test('lengths, in every way he writes them', () => {
  for (const [text, minutes] of [['30m', 30], ['45 min', 45], ['1h', 60], ['1,5h', 90], ['1.5h', 90], ['1.5 h', 90], ['90min', 90], ['1h30', 90], ['2 godz', 120]]) {
    assert.equal(takeMinutes(`zrobić ${text} coś`)?.minutes, minutes, text);
  }
  assert.equal(takeMinutes('Poprawki w 5 wersji'), null);
});

test('days: words, weekdays (the next one), dates this year or next', () => {
  assert.equal(takeDay('x dziś', today)?.day, '2026-10-30');
  assert.equal(takeDay('x dzisiaj', today)?.day, '2026-10-30');
  assert.equal(takeDay('x jutro', today)?.day, '2026-10-31');
  assert.equal(takeDay('x tomorrow', today)?.day, '2026-10-31');
  assert.equal(takeDay('x pojutrze', today)?.day, '2026-11-01');
  assert.equal(takeDay('x w poniedziałek', today)?.day, '2026-11-02');
  assert.equal(takeDay('x środa', today)?.day, '2026-11-04');
  assert.equal(takeDay('x piątek', today)?.day, '2026-11-06', 'said on a Friday: next week');
  assert.equal(takeDay('x Monday', today)?.day, '2026-11-02');
  assert.equal(takeDay('x 5.11', today)?.day, '2026-11-05');
  assert.equal(takeDay('x 05.11', today)?.day, '2026-11-05');
  assert.equal(takeDay('x 3.01', today)?.day, '2027-01-03', 'gone this year: next year');
  assert.equal(takeDay('x 31.02', today), null);
  assert.equal(takeDay('Wtorkowy raport', today), null);
});

test('projects: a mention, a full name, a word of one', () => {
  assert.equal(takeProject('a @Esono Rozwój b', projects, [3])?.id, 3);
  assert.equal(takeProject('a @esono rozwoj b', projects)?.id, 3);
  assert.equal(takeProject('a @sono b', projects)?.id, 5);
  assert.equal(takeProject('a @repricer b', projects)?.id, 4);
  assert.equal(takeProject('a @nikt b', projects), null);
  assert.equal(takeProject('bez projektu', projects), null);
});

test('a line to add: the title without its tokens', () => {
  assert.deepEqual(q('Poprawki w stopce @Esono Rozwój 45m jutro', [3]), { act: 'add', title: 'Poprawki w stopce', projectId: 3, minutes: 45, dueOn: '2026-10-31' });
  assert.deepEqual(q('Zadzwonić do Piotra'), { act: 'add', title: 'Zadzwonić do Piotra' });
  assert.deepEqual(q('@sonocars galeria 1,5h 5.11'), { act: 'add', title: 'galeria', projectId: 5, minutes: 90, dueOn: '2026-11-05' });
  assert.deepEqual(q('Faktura w piątek'), { act: 'add', title: 'Faktura', dueOn: '2026-11-06' });
  assert.deepEqual(q('45m jutro'), { error: 'Add needs a title' });
});

test('a line to log: a project and a length, the rest is the note', () => {
  assert.deepEqual(q('log 1h @Codenotch poprawki Today'), { act: 'log_time', projectId: 30, minutes: 60, note: 'poprawki', day: '2026-10-30' });
  assert.deepEqual(q('zaloguj 1,5h @esono rozwoj'), { act: 'log_time', projectId: 3, minutes: 90 });
  assert.deepEqual(q('log 30m wczoraj @sono spotkanie'), { act: 'log_time', projectId: 5, minutes: 30, note: 'spotkanie', day: '2026-10-29' });
  assert.deepEqual(q('log 1h poprawki'), { error: 'Log needs an @project' });
  assert.deepEqual(q('log @Codenotch poprawki'), { error: 'Log needs a time, like 1h' });
  // "Logo" is not "log ".
  assert.deepEqual(q('Logo nowe'), { act: 'add', title: 'Logo nowe' });
});
