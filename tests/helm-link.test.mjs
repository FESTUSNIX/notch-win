import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readNotch, folderFor, doingRequest, projectById, folderOfRequest, spoken, monogram,
  hueOf, requestIdOf, chipFor, needSide, pathKey, readSuggestions,
} from '../src/helm-link.ts';

const project = (id, name) => ({ id, name, logoVersion: null, hue: 'blue', client: null, personal: false });
const notch = readNotch({
  day: '2026-10-28',
  clock: { you: 190, agents: 85 },
  needs: [],
  folders: [
    { folder: 'Esono', path: 'C:\\CODE\\esono', project: project(3, 'Esono Rozwój'), requests: [
      { id: 1, title: 'Koszyk', status: 'doing', estimate: 120, startedAt: '2026-10-28T08:00:00Z' },
      { id: 4, title: 'Galeria', status: 'doing', estimate: 60, startedAt: '2026-10-28T11:00:00Z' },
      { id: 6, title: 'Stopka', status: 'todo', estimate: 30, startedAt: null },
    ] },
    { folder: 'esono', path: 'D:\\work\\esono', project: project(9, 'Esono (fork)'), requests: [] },
    { folder: 'sonocars', path: null, project: project(5, 'sonocars'), requests: [
      { id: 7, title: 'Logo', status: 'todo', estimate: 60, startedAt: null },
    ] },
  ],
});

test('a missing or foreign reading is no reading, never a throw', () => {
  assert.equal(readNotch(null), null);
  assert.equal(readNotch(undefined), null);
  assert.equal(readNotch('<html>404</html>'), null);
  // A Helm that renamed a field hides the cockpit rather than breaking Today.
  assert.equal(readNotch({ day: 'x', folders: [] }), null);
  assert.equal(readNotch({ day: 'x', clock: { you: 1, agents: 2 } }), null);
  // And everything built on it answers "nothing" for an absent one.
  assert.equal(folderFor({ project: 'esono' }, null), null);
  assert.equal(projectById(3, null), null);
});

test('a session is matched to its folder by path first, then by name', () => {
  // Two checkouts named "esono": the path decides.
  assert.equal(folderFor({ project: 'esono', folder: 'd:/work/esono/' }, notch).project.id, 9);
  assert.equal(folderFor({ project: 'esono', folder: 'C:/CODE/esono' }, notch).project.id, 3);
  // No path, or a path Helm does not know: the name, lower-cased, first match.
  assert.equal(folderFor({ project: 'ESONO' }, notch).project.id, 3);
  assert.equal(folderFor({ project: 'sonocars', folder: 'C:/elsewhere/sonocars' }, notch).project.id, 5);
  assert.equal(folderFor({ project: 'akcesfonia' }, notch), null);
});

test('the request a folder is on is the doing one, the latest started', () => {
  const esono = folderFor({ project: 'esono', folder: 'C:\\CODE\\esono' }, notch);
  assert.equal(doingRequest(esono).id, 4, 'the most recent startedAt of the two doing');
  // Nothing doing: nothing, not the first todo.
  assert.equal(doingRequest(folderFor({ project: 'sonocars' }, notch)), null);
  assert.equal(doingRequest(null), null);
  assert.equal(folderOfRequest(7, notch).folder, 'sonocars');
});

test('paths compare whichever way the separators were written', () => {
  assert.equal(pathKey('C:\\CODE\\esono\\'), pathKey('c:/code/esono'));
});

test('time is said the way Helm says it', () => {
  assert.equal(spoken(45), '45 min');
  assert.equal(spoken(120), '2 h');
  assert.equal(spoken(90), '1 h 30');
  assert.equal(spoken(65), '1 h 05');
  assert.equal(spoken(0), '0 min');
});

test('a project without a logo gets two letters and a steady colour', () => {
  assert.equal(monogram('Esono Rozwój'), 'ER');
  assert.equal(monogram('sonocars'), 'SO');
  assert.equal(monogram('—'), '?');
  assert.equal(hueOf('blue'), hueOf('blue', 'anything'));
  assert.equal(hueOf(null, 'sonocars'), hueOf(null, 'sonocars'), 'the same name, the same colour');
});

test('a queue item names its request', () => {
  assert.equal(requestIdOf({ key: 'request:12', kind: 'request', workItemId: 12 }), 12);
  assert.equal(requestIdOf({ key: 'request:5', kind: 'request', workItemId: null }), 5);
  assert.equal(requestIdOf({ key: 'todo:1', kind: 'todo', workItemId: null }), null);
});

test('a row carries one chip, and only when it says something', () => {
  const today = '2026-10-28';
  const none = new Set();
  assert.deepEqual(chipFor({ dueOn: '2026-10-26', kinds: ['request'], projectId: 3 }, today, new Set([3])), { tone: 'late', label: '2 days late' });
  assert.deepEqual(chipFor({ dueOn: today, kinds: ['followup'], projectId: null }, today, none), { tone: 'today', label: 'Today' });
  assert.deepEqual(chipFor({ dueOn: null, kinds: ['followup'], projectId: null }, today, none), { tone: 'move', label: 'Your move' });
  assert.deepEqual(chipFor({ dueOn: '2026-11-02', kinds: ['request'], projectId: 3 }, today, new Set([3])), { tone: 'wait', label: 'Waiting' });
  assert.equal(chipFor({ dueOn: '2026-11-02', kinds: ['request'], projectId: 3 }, today, none), null);
});

test('a need says when, or how much, beside its title', () => {
  const today = '2026-10-28';
  assert.deepEqual(needSide({ kind: 'meeting', at: '2026-10-28T15:00:00', amount: null }, today), { text: '15:00', late: false });
  assert.deepEqual(needSide({ kind: 'renewal', at: '2026-10-20', amount: 1200 }, today), { text: '1\u00a0200\u00a0zł', late: true });
  assert.deepEqual(needSide({ kind: 'reminder', at: '2026-10-28', amount: null }, today), { text: 'today', late: false });
  assert.equal(needSide({ kind: 'request', at: null, amount: null }, today), null);
});

test("the Guardian's chips are read, not trusted: whole ones only, at most four, none for no endpoint", () => {
  const chip = (label, more = {}) => ({ id: label, label, prompt: `${label}.`, icon: 'next', kind: 'now', ...more });
  // A Helm without the endpoint (helm.rs: null) or a foreign answer: no row at all, never the old three.
  assert.equal(readSuggestions(null), null);
  assert.equal(readSuggestions('<html>404</html>'), null);
  assert.equal(readSuggestions({ chips: [] }), null);
  assert.deepEqual(readSuggestions({ suggestions: [] }), []);
  // A chip without words or a sentence is dropped; a repeated label once; an id falls back to the label.
  const read = readSuggestions({ suggestions: [
    chip('Co teraz?'), chip(''), { label: 'Bez zdania' }, chip('Co teraz?'), chip('Podsumuj dzień', { id: '' }),
    chip('Plan na jutro'), chip('Przegląd tygodnia'), chip('Piąty'), 7, null,
  ] });
  assert.deepEqual(read.map(s => s.label), ['Co teraz?', 'Podsumuj dzień', 'Plan na jutro', 'Przegląd tygodnia']);
  assert.equal(read[1].id, 'Podsumuj dzień');
  // Strings are trimmed; an unknown icon or kind is kept as said (the island maps it, or falls back).
  assert.deepEqual(readSuggestions({ suggestions: [{ id: ' a ', label: ' Tak, zrób to ', prompt: ' Tak, zrób to. ', icon: 7, kind: 'nowe' }] }),
    [{ id: 'a', label: 'Tak, zrób to', prompt: 'Tak, zrób to.', icon: '', kind: 'nowe' }]);
});
