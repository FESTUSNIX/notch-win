import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskForest, progress, localDay, dateDay, visibleNode } from '../src/task-model.ts';

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
