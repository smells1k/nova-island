'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const taskUtils = require('../task-utils');

test('day keys use local calendar dates and reject impossible dates', () => {
  const local = new Date(2026, 9, 29, 23, 45);
  assert.equal(taskUtils.localDayKey(local), '2026-10-29');
  assert.equal(taskUtils.isValidDayKey('2024-02-29'), true);
  assert.equal(taskUtils.isValidDayKey('2026-02-29'), false);
  assert.equal(taskUtils.isValidDayKey('2026-13-01'), false);
  assert.equal(taskUtils.isValidDayKey('2026-1-01'), false);
});

test('new task titles are trimmed, single-line, bounded, and reject blank input', () => {
  const now = new Date('2026-10-29T01:00:00.000Z');
  const task = taskUtils.createTask('  Ответить\n   на письмо  ', '2026-10-29', 'task-1', now);
  assert.equal(task.title, 'Ответить на письмо');
  assert.equal(task.dueDate, '2026-10-29');
  assert.equal(task.completed, false);
  assert.equal(task.createdAt, now.toISOString());
  assert.equal(taskUtils.createTask('  \n ', '', 'task-2', now), null);
  assert.equal(taskUtils.createTask('Задача', '2026-02-30', 'task-3', now), null);
});

test('saved tasks are normalized, deduplicated, and bounded', () => {
  const now = new Date('2026-10-29T00:00:00.000Z');
  const tasks = taskUtils.normalizeTasks([
    { id: 'a', title: '  First  ', dueDate: '2026-10-29', completed: false },
    { id: 'a', title: 'duplicate id' },
    { id: 'b', title: 'Second', dueDate: 'not-a-date', completed: true },
    { id: 'c', title: '   ' },
  ], now);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, 'First');
  assert.equal(tasks[1].dueDate, '');
  assert.equal(tasks[1].completedAt, '');
  assert.equal(tasks[0].createdAt, now.toISOString());
});

test('task completion toggles with a completion timestamp and can be unchecked', () => {
  const tasks = [{ id: 'a', title: 'Ship update', completed: false, completedAt: '' }];
  const completedAt = new Date('2026-10-29T06:30:00.000Z');
  const completed = taskUtils.toggleTask(tasks, 'a', completedAt);
  assert.equal(completed.changed, true);
  assert.equal(completed.tasks[0].completed, true);
  assert.equal(completed.tasks[0].completedAt, completedAt.toISOString());
  const reopened = taskUtils.toggleTask(completed.tasks, 'a', completedAt);
  assert.equal(reopened.tasks[0].completed, false);
  assert.equal(reopened.tasks[0].completedAt, '');
  assert.equal(taskUtils.toggleTask(tasks, 'missing', completedAt).changed, false);
});
