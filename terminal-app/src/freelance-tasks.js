'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FreelanceTasks = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  function groups(projects, clients, filter, query, today) {
    const result = new Map(), needle = query.trim().toLowerCase();
    for (const record of projects) {
      if (record.archived !== (filter === 'archived')) continue;
      const clientName = clients.find(c => c.id === record.values.clientId)?.values.name || 'No linked client';
      const context = (clientName + ' ' + record.values.title).toLowerCase();
      const tasks = record.values.milestones.filter(task => {
        if (needle && !context.includes(needle) && !task.title.toLowerCase().includes(needle)) return false;
        if (filter === 'archived') return true;
        if (filter === 'completed') return task.done;
        if (task.done) return false;
        if (filter === 'today') return !!task.dueDate && task.dueDate <= today;
        if (filter === 'upcoming') return !task.dueDate || task.dueDate > today;
        return true;
      }).sort((a, b) => Number(a.done) - Number(b.done) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
      const emptyProject = !record.values.milestones.length && ['all', 'archived'].includes(filter) && (!needle || context.includes(needle));
      if (!tasks.length && !emptyProject) continue;
      const key = record.values.clientId || '';
      if (!result.has(key)) result.set(key, { clientName, projects: [] });
      result.get(key).projects.push({ record, tasks });
    }
    for (const group of result.values()) group.projects.sort((a, b) => Number(!a.tasks.length) - Number(!b.tasks.length) || (a.tasks[0]?.dueDate || '9999').localeCompare(b.tasks[0]?.dueDate || '9999'));
    return [...result.values()];
  }
  return { groups };
});
