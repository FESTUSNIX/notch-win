import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choose, decay, readings, DWELL_MS, HOLD_MS } from '../src/pill-modules.ts';

const quiet = {
  now: new Date('2026-09-14T14:53:00'),
  machine: {cpu: 20, memory: 40, diskUsed: 61, diskFree: 400e9},
  weather: {place: 'Krakow', celsius: 17, summary: 'Partly cloudy', icon: 'wxPartly'},
  nextEvent: null,
  tasks: {done: 2, total: 6, reliable: true, view: 'day'},
  agents: 0,
};

const withDisk = pct => ({...quiet, machine: {cpu: 20, memory: 40, diskUsed: pct, diskFree: 7.6e9}});

test('a module with nothing to say yields the slot', () => {
  const silent = {...quiet, weather: null, tasks: {done: 0, total: 0, reliable: true, view: 'day'}};
  assert.deepEqual(readings(silent).map(r => r.id), []);
  assert.equal(choose(readings(silent), 0), null);
});

test('every module says one token, never a sentence', () => {
  // The strip is on screen all day: after a week you read the glyph and the
  // colour, not the words. Anything longer than this is width being spent on
  // something the module's own screen already says properly.
  const busy = readings({...quiet, agents: 2, nextEvent: {minutes: 95, title: 'Design review'},
    machine: {cpu: 94, memory: 91, diskUsed: 97, diskFree: 7.6e9}});
  assert.ok(busy.length >= 6);
  for (const reading of busy) {
    assert.ok(reading.text.length <= 4, `${reading.id} says ${JSON.stringify(reading.text)}`);
    assert.ok(reading.icon, `${reading.id} has no glyph to be recognised by`);
    assert.equal(reading.note, undefined, `${reading.id} still carries a second line`);
  }
});

test('ambient readings rotate, loudest first, and come back round', () => {
  const all = readings(quiet);
  assert.deepEqual(all.map(r => r.id), ['tasks', 'weather']);
  assert.equal(choose(all, 0).id, 'tasks');
  assert.equal(choose(all, DWELL_MS - 1).id, 'tasks');
  assert.equal(choose(all, DWELL_MS).id, 'weather');
  assert.equal(choose(all, DWELL_MS * 2).id, 'tasks');
});

test('news holds the slot', () => {
  const fresh = decay(readings(withDisk(97)), {}, 1000);
  assert.equal(fresh.readings[0].id, 'disk');
  for (const elapsed of [0, DWELL_MS, DWELL_MS * 5]) {
    assert.equal(choose(fresh.readings, elapsed).id, 'disk', `held at ${elapsed}ms`);
  }
});

test('a STANDING condition rejoins the rotation instead of owning the strip forever', () => {
  /* ⚠️ The rule that stops the hold becoming the thing it was meant to
   * prevent. A disk at 95% until someone buys a new one is a fact about the
   * machine, not an alert, and a permanent red warning is exactly the warning
   * you stop seeing. */
  const all = readings(withDisk(97));
  let state = decay(all, {}, 0).held;
  const later = decay(readings(withDisk(97)), state, HOLD_MS + 1);

  const disk = later.readings.find(r => r.id === 'disk');
  assert.ok(disk.urgency < 50, 'no longer holds');
  // Still the first thing in the cycle, so it is seen every time round.
  assert.equal(later.readings[0].id, 'disk');
  assert.equal(choose(later.readings, 0).id, 'disk');
  // …and the others now get their turn, which is the whole point.
  const seen = new Set();
  for (let i = 0; i < later.readings.length; i++) seen.add(choose(later.readings, DWELL_MS * i).id);
  assert.ok(seen.has('weather') && seen.has('tasks'), [...seen].join(','));
});

test('a standing reading getting materially worse is news again', () => {
  let state = decay(readings(withDisk(92)), {}, 0).held;
  const settled = decay(readings(withDisk(92)), state, HOLD_MS + 1);
  assert.ok(settled.readings.find(r => r.id === 'disk').urgency < 50);

  // One point is the disk creeping; five is something happening.
  const crept = decay(readings(withDisk(94)), settled.held, HOLD_MS + 2);
  assert.ok(crept.readings.find(r => r.id === 'disk').urgency < 50, 'creeping is not news');
  const jumped = decay(readings(withDisk(99)), settled.held, HOLD_MS + 3);
  assert.ok(jumped.readings.find(r => r.id === 'disk').urgency >= 50, 'a jump re-arms');
});

test('a reading that dips and climbs back does not re-arm on old ground', () => {
  let state = decay(readings(withDisk(99)), {}, 0).held;
  state = decay(readings(withDisk(93)), state, 1000).held;
  const back = decay(readings(withDisk(98)), state, 2000);
  assert.ok(back.readings.find(r => r.id === 'disk').urgency >= 50 === false
    || back.held.disk.level === 99, 'the high-water mark is what re-arming is measured from');
  assert.equal(back.held.disk.level, 99);
});

test('a reading that falls silent loses its arming, so coming back is news', () => {
  const state = decay(readings(withDisk(97)), {}, 0).held;
  const gone = decay(readings(withDisk(61)), state, 1000);
  assert.equal(gone.held.disk, undefined);
  const again = decay(readings(withDisk(97)), gone.held, 2000);
  assert.ok(again.readings.find(r => r.id === 'disk').urgency >= 50);
});

test('CPU speaks at 90, not at the 80 the System meters use', () => {
  // A developer's machine sits at 80% with an editor and a browser open. A
  // pill that says so all day is one that is ignored on the day it matters.
  const busy = pct => readings({...quiet, machine: {cpu: pct, memory: 40, diskUsed: 61, diskFree: 400e9}});
  assert.equal(busy(85).some(r => r.id === 'cpu'), false);
  assert.equal(busy(91).some(r => r.id === 'cpu'), true);
  assert.equal(busy(91).find(r => r.id === 'cpu').tone, 'warn');
});

test('the event module starts where the calendar screen stops claiming the pill', () => {
  // Inside 30 minutes the screen takes the WHOLE pill, so a module covering
  // the same window would either never show or say it twice.
  const at = minutes => readings({...quiet, nextEvent: {minutes, title: 'Design review'}});
  assert.equal(at(12).some(r => r.id === 'event'), false);
  assert.equal(at(31).some(r => r.id === 'event'), true);
  assert.equal(at(200).some(r => r.id === 'event'), false);
  assert.equal(at(95).find(r => r.id === 'event').text, '1h');
});

test('agents are ambient, and counted', () => {
  assert.equal(readings({...quiet, agents: 0}).some(r => r.id === 'agents'), false);
  assert.equal(readings({...quiet, agents: 3}).find(r => r.id === 'agents').text, '3');
});

test('nothing read yet is not the same as nothing to report', () => {
  // -1 is what the Rust side returns for a figure it could not take. Reading
  // it as a number would make "-1%" a quiet reading rather than no reading.
  const unread = readings({...quiet, machine: {cpu: -1, memory: -1, diskUsed: -1, diskFree: 0}});
  assert.equal(unread.some(r => ['cpu', 'memory', 'disk'].includes(r.id)), false);
});
