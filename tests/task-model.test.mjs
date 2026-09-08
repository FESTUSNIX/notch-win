import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskForest, progress, localDay, dateDay, visibleNode, overdueDays, nodeDone, taskId, taskKey } from '../src/task-model.ts';

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
