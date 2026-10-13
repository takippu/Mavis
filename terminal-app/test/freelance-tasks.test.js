'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { groups } = require('../src/freelance-tasks');
const today = '2026-10-09';
const task = (id, dueDate = '', done = false) => ({ id, title: id, dueDate, done });
const project = (id, milestones, clientId = 'c1', archived = false) => ({ id, archived, values: { title: id, clientId, milestones } });
const clients = [{ id: 'c1', values: { name: 'Mawar Assurance' } }];
const projects = [project('Portal', [task('Overdue', '2026-10-08'), task('Today', today), task('Future', '2026-10-10'), task('Undated'), task('Done', today, true)]), project('Empty', []), project('Archive', [task('Archived task')], null, true)];
const titles = (filter, query = '') => groups(projects, clients, filter, query, today).flatMap(c => c.projects.flatMap(p => p.tasks.map(t => t.id)));
test('task date views partition open work, include overdue today and keep undated upcoming', () => {
  assert.deepEqual(titles('today'), ['Overdue', 'Today']);
  assert.deepEqual(titles('upcoming'), ['Future', 'Undated']);
  assert.deepEqual(titles('all'), ['Overdue', 'Today', 'Future', 'Undated']);
  assert.deepEqual(titles('completed'), ['Done']);
  assert.deepEqual(titles('archived'), ['Archived task']);
});
test('search covers task, client and project; empty existing projects remain accessible', () => {
  assert.deepEqual(titles('all', 'future'), ['Future']);
  assert.deepEqual(titles('today', 'mawar'), ['Overdue', 'Today']);
  assert.deepEqual(titles('upcoming', 'portal'), ['Future', 'Undated']);
  assert.equal(groups(projects, clients, 'all', '', today)[0].projects.length, 2);
  assert.equal(groups(projects, clients, 'today', 'empty', today).length, 0);
  assert.equal(groups(projects, clients, 'archived', '', today)[0].clientName, 'No linked client');
  assert.deepEqual(titles('all', 'missing'), []);
});
test('task views do not mutate stored projects or their milestone order', () => {
  const original = structuredClone(projects); groups(projects, clients, 'all', '', today);
  assert.deepEqual(projects, original);
});
