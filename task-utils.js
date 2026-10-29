'use strict';

const MAX_TASKS = 120;
const MAX_TITLE_LENGTH = 180;

function localDayKey(dateValue = new Date()) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isValidDayKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function cleanTitle(value) {
  return String(value == null ? '' : value)
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

function validIsoString(value) {
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) return '';
  return value;
}

function normalizeTask(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = String(value.id == null ? '' : value.id).replace(/\u0000/g, '').trim().slice(0, 100);
  const title = cleanTitle(value.title);
  if (!id || !title) return null;
  const completed = Boolean(value.completed);
  return {
    id,
    title,
    dueDate: value.dueDate === '' || value.dueDate == null ? '' : (isValidDayKey(value.dueDate) ? value.dueDate : ''),
    completed,
    createdAt: validIsoString(value.createdAt) || now.toISOString(),
    completedAt: completed ? validIsoString(value.completedAt) : '',
  };
}

function normalizeTasks(value, now = new Date()) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const candidate of value.slice(0, MAX_TASKS * 3)) {
    const task = normalizeTask(candidate, now);
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    result.push(task);
    if (result.length >= MAX_TASKS) break;
  }
  return result;
}

function createTask(title, dueDate, id, now = new Date()) {
  const clean = cleanTitle(title);
  const safeId = String(id == null ? '' : id).replace(/\u0000/g, '').trim().slice(0, 100);
  if (!clean || !safeId) return null;
  if (dueDate !== '' && dueDate != null && !isValidDayKey(dueDate)) return null;
  return {
    id: safeId,
    title: clean,
    dueDate: dueDate || '',
    completed: false,
    createdAt: now.toISOString(),
    completedAt: '',
  };
}

function toggleTask(tasks, id, at = new Date()) {
  const targetId = String(id == null ? '' : id);
  const completedAt = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  let changed = false;
  const next = (Array.isArray(tasks) ? tasks : []).map((task) => {
    if (!task || task.id !== targetId) return task;
    changed = true;
    const completed = !Boolean(task.completed);
    return { ...task, completed, completedAt: completed ? completedAt : '' };
  });
  return { tasks: next, changed };
}

module.exports = {
  MAX_TASKS,
  MAX_TITLE_LENGTH,
  cleanTitle,
  createTask,
  isValidDayKey,
  localDayKey,
  normalizeTask,
  normalizeTasks,
  toggleTask,
};
