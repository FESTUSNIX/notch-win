import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskForest, progress, localDay, dateDay, visibleNode, overdueDays, nodeDone, taskId, taskKey, listTally, inList, weekStart } from '../src/task-model.ts';

const today = '2026-09-08';
const date = `${today}T12:00:00Z`;
const task = (id, fields = {}) => ({id,projectId:'p',title:id,status:0,startDate:date,...fields});

test('nested progress counts leaf work once, including checklist items', () => {
  const tasks = [task('parent'),task('child',{parentId:'parent',items:[{id:'a',status:1},{id:'b',status:0}]}),task('done',{parentId:'parent',status:2,completedTime:date})];
  const tree = taskForest(tasks,'today',today);
  assert.equal(tree.length,1);
  assert.equal(tree[0].children.length,2);
  assert.deepEqual(progress(tree),{done:2,total:3});
});
test('unscheduled children inherit a parent schedule; future children do not inflate Today', () => {
  const tasks = [task('parent'),task('child',{parentId:'parent',startDate:undefined}),task('future',{parentId:'parent',startDate:'2026-09-09T12:00:00Z'})];
  assert.deepEqual(progress(taskForest(tasks,'today',today)),{done:0,total:1});
});
test('overdue, unscheduled and spanning tasks have distinct daily membership', () => {
  const tasks = [task('late',{startDate:'2026-09-07T12:00:00Z'}),task('inbox',{startDate:undefined}),task('span',{startDate:'2026-09-07T12:00:00Z',dueDate:'2026-09-09T12:00:00Z'})];
  assert.deepEqual(progress(taskForest(tasks,'today',today)),{done:0,total:1});
  assert.deepEqual(progress(taskForest(tasks,'overdue',today)),{done:0,total:1});
  assert.deepEqual(progress(taskForest(tasks,'all',today)),{done:0,total:3});
});
test('phone completions and the next recurring instance survive deduplication', () => {
  const done = task('repeat',{status:2,completedTime:date});
  const tasks = [done,done,task('repeat',{startDate:'2026-09-09T12:00:00Z'})];
  assert.deepEqual(progress(taskForest(tasks,'today',today)),{done:1,total:1});
  assert.deepEqual(progress(taskForest(tasks,'all',today)),{done:1,total:2});
});
test('cycles and abandoned tasks cannot hide valid tasks or recurse forever', () => {
  const tasks = [task('a',{parentId:'b'}),task('b',{parentId:'a'}),task('cancelled',{status:-1})];
  const tree = taskForest(tasks,'all',today);
  assert.equal(tree.length,1);
  assert.deepEqual(progress(tree),{done:0,total:1});
});
test('completion hiding changes visibility without changing the progress denominator', () => {
  const tree = taskForest([task('done',{status:2,completedTime:date})],'today',today);
  assert.equal(visibleNode(tree[0],true),false);
  assert.deepEqual(progress(tree),{done:1,total:1});
});
test('local calendar boundaries handle UTC offsets and invalid timestamps', () => {
  assert.equal(localDay(new Date('2026-09-07T22:30:00Z'),'Europe/Warsaw'),today);
  assert.equal(dateDay('invalid'),null);
  assert.equal(dateDay(undefined),null);
});

test('the day view carries overdue work that the ring still refuses to score', () => {
  const tasks = [task('late',{startDate:'2026-09-05T12:00:00Z'}),task('now'),task('later',{startDate:'2026-09-10T12:00:00Z'})];
  // Listed together …
  assert.deepEqual(progress(taskForest(tasks,'day',today)),{done:0,total:2});
  // … but the count the ring shows stays the day's own work.
  assert.deepEqual(progress(taskForest(tasks,'today',today)),{done:0,total:1});
  assert.deepEqual(progress(taskForest(tasks,'overdue',today)),{done:0,total:1});
});
test('the day view keeps finished work so it can sink into the done drawer', () => {
  const tasks = [task('shipped',{status:2,completedTime:date}),task('open')];
  assert.deepEqual(progress(taskForest(tasks,'day',today)),{done:1,total:2});
});
test('a parent keeps both an overdue and a scheduled child in one tree', () => {
  const tasks = [task('parent'),task('late',{parentId:'parent',startDate:'2026-09-01T12:00:00Z'}),task('now',{parentId:'parent'})];
  const tree = taskForest(tasks,'day',today);
  assert.equal(tree.length,1);
  assert.equal(tree[0].children.filter(c => c.selected).length,2);
});
test('overdue is counted in whole days and never claims a finished task', () => {
  assert.equal(overdueDays(task('a',{dueDate:'2026-09-05T12:00:00Z'}),today),3);
  // Late in UTC can already be the next day locally, and the day is what counts.
  assert.equal(overdueDays(task('a2',{dueDate:'2026-09-05T23:00:00Z'}),today),2);
  assert.equal(overdueDays(task('b'),today),0);
  assert.equal(overdueDays(task('c',{dueDate:'2026-09-07T12:00:00Z',status:2,completedTime:date}),today),0);
  // No due date falls back to the start day, so a one-day task still ages.
  assert.equal(overdueDays(task('d',{startDate:'2026-09-07T12:00:00Z'}),today),1);
});
test('a row leaves the day only when every leaf under it is finished', () => {
  const half = taskForest([task('parent'),task('a',{parentId:'parent',status:2,completedTime:date}),task('b',{parentId:'parent'})],'day',today);
  assert.equal(nodeDone(half[0]),false);
  const all = taskForest([task('parent'),task('a',{parentId:'parent',status:2,completedTime:date})],'day',today);
  assert.equal(nodeDone(all[0]),true);
});
test('optimistic identity survives the completion it is tracking', () => {
  const open = task('x'), closed = {...open,status:2,completedTime:date};
  assert.equal(taskId(open),taskId(closed));
  assert.notEqual(taskKey(open),taskKey(closed));
});

test('a list count is rows, not tasks, and the order is the order the rows came in', () => {
  const rows = [
    task('work-1', {projectId: 'work'}),
    task('sub', {projectId: 'work', parentId: 'work-1'}),
    task('home-1', {projectId: 'home'}),
    task('work-2', {projectId: 'work'}),
  ];
  const tree = taskForest(rows, 'today', today);
  // Three roots: the subtask is folded into work-1 rather than counted beside it.
  assert.equal(tree.length, 3);
  // Insertion order, which is the order the rows are drawn in — the forest
  // sorts by sortOrder then title, so `home-1` leads.
  const counts = listTally(tree);
  assert.deepEqual([...counts], [['home', 1], ['work', 2]]);
});

test('filtering to a list keeps the whole row, subtasks included', () => {
  const rows = [
    task('work-1', {projectId: 'work'}),
    task('sub', {projectId: 'work', parentId: 'work-1'}),
    task('home-1', {projectId: 'home'}),
  ];
  const tree = taskForest(rows, 'today', today);
  const work = inList(tree, 'work');
  assert.deepEqual(work.map(n => n.task.id), ['work-1']);
  assert.equal(work[0].children.length, 1);
  // An empty id is "all lists", not "the list with no name". Two roots, not
  // three: the subtask is inside work-1.
  assert.equal(inList(tree, '').length, 2);
  // A list nothing is in comes back empty rather than throwing.
  assert.deepEqual(inList(tree, 'nowhere'), []);
});

test('a Monday-first week does not walk forward on a Sunday', () => {
  const iso = (d) => localDay(d);
  // 2026-09-13 is a Sunday. ⚠️ `getDay()` is 0 there, so `day - 1` is -1 and
  // the week would start on the MONDAY AFTER — a grid of days that have not
  // happened, presented as this week.
  const sunday = new Date(2026, 8, 13, 15, 0);
  assert.equal(sunday.getDay(), 0);
  assert.equal(iso(weekStart(sunday, true)), '2026-09-07');
  assert.equal(iso(weekStart(sunday, false)), '2026-09-13');

  // A Monday is its own week start, and stays there.
  const monday = new Date(2026, 8, 14, 9, 0);
  assert.equal(iso(weekStart(monday, true)), '2026-09-14');
  assert.equal(iso(weekStart(monday, false)), '2026-09-13');

  // Midway through: Thursday belongs to the Monday behind it.
  const thursday = new Date(2026, 8, 17, 23, 59);
  assert.equal(iso(weekStart(thursday, true)), '2026-09-14');

  // Local midnight, so seven `setDate` steps cannot drift across a DST hour.
  const start = weekStart(thursday, true);
  assert.deepEqual([start.getHours(), start.getMinutes(), start.getSeconds()], [0, 0, 0]);
});
