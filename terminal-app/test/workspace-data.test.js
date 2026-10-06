'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { daily, topicMatches, projectColor, variant } = require('../src/renderer/workspace-data');
test('project scope excludes adjacent project sections and frontmatter', () => {
  const text = '---\ndate: 2026-10-06\n---\n# 2026-10-06\n\n## app — shipped\nkeep\n## app-next — other\nexclude\n## app - fixed\nkeep again\n';
  assert.match(daily(text, 'app'), /keep again/); assert.doesNotMatch(daily(text, 'app'), /exclude|date:/);
  assert.equal(daily(text, 'absent'), ''); assert.match(daily(text), /exclude/);
});
test('topic scope follows durable project references exactly', () => {
  assert.equal(topicMatches({refs:['`projects/app/notes.md` (details)']}, 'app'), true);
  assert.equal(topicMatches({refs:['projects/app-next/notes.md']}, 'app'), false);
  assert.equal(topicMatches({}, 'app'), false); assert.equal(topicMatches({}, null), true);
});
test('draft edits survive repeated concise/detailed switches', () => {
  const flow = {draft:'my concise edits',detailed:false,composed:{concise:'original',detailed:'full original'}};
  assert.equal(variant(flow,true),'full original'); flow.draft='my detailed edits';
  assert.equal(variant(flow,false),'my concise edits'); assert.equal(variant(flow,true),'my detailed edits');
  flow.draft=''; variant(flow,false); assert.equal(variant(flow,true),'');
});
test('tab colour follows the registered slug without borrowing an adjacent project colour', () => {
  const catalog = [{slug:'app',name:'Same',dir:'/projects/app',color:'#2f6f9e'}, {slug:'app-next',name:'Same',dir:'/projects/next',color:'#b2542f'}];
  assert.equal(projectColor({slug:'app',root:'/projects/next'},catalog,'darwin'),'#2f6f9e');
  assert.equal(projectColor({slug:'missing',root:'/projects/app'},catalog,'darwin'),null);
  assert.equal(projectColor({name:'Same',root:'/elsewhere'},catalog,'darwin'),null);
});
test('folder tabs match normalized paths with platform-specific case handling', () => {
  const catalog = [{slug:'app',dir:'C:\\Projects\\App\\',color:'#2F6F9E'}];
  assert.equal(projectColor({root:'c:/projects/app'},catalog,'win32'),'#2F6F9E');
  assert.equal(projectColor({root:'c:/projects/app'},catalog,'darwin'),null);
  assert.equal(projectColor({root:'/projects/app/'},[{dir:'/projects/app',color:'#b2542f'}],'darwin'),'#b2542f');
});
test('cleared or malformed project colours leave tabs neutral', () => {
  for (const color of [null,'','red','#fff','url(test)']) assert.equal(projectColor({slug:'app'},[{slug:'app',color}],'darwin'),null);
});
