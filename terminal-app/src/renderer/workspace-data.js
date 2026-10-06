'use strict';
(function(root) {
  const strip = text => String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  function daily(text, project) {
    if (!project) return strip(text);
    return strip(text).split(/(?=^## )/m).filter(section => {
      const heading = section.split(/\r?\n/)[0];
      return heading.startsWith('## ' + project + ' — ') || heading.startsWith('## ' + project + ' - ');
    }).join('\n');
  }
  function topicMatches(topic, project) { return !project || (topic.refs || []).some(ref => String(ref).includes('projects/' + project + '/')); }
  function projectColor(workspace, catalog, platform) {
    const normalize = value => { const path = String(value || '').replace(/\\/g, '/').replace(/\/+$/, ''); return platform === 'win32' ? path.toLowerCase() : path; };
    const project = workspace.slug ? catalog.find(p => p.slug === workspace.slug)
      : catalog.find(p => p.dir && normalize(p.dir) === normalize(workspace.root));
    return /^#[0-9a-f]{6}$/i.test(project?.color || '') ? project.color : null;
  }
  function variant(flow, detailed) {
    flow.variants ||= {};
    flow.variants[flow.detailed ? 'detailed' : 'concise'] = flow.draft || '';
    flow.detailed = detailed;
    const key = detailed ? 'detailed' : 'concise';
    flow.draft = flow.variants[key] ?? flow.composed?.[key] ?? '';
    return flow.draft;
  }
  const api = { daily, topicMatches, projectColor, variant };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MT ||= {}).workspaceData = api;
})(typeof window === 'object' ? window : globalThis);
