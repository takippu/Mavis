'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DEFAULT_MODEL, validateModel, listModels } = require('../src/lead-hunter-models');
test('model selection accepts known exact IDs and defaults only legacy omissions', () => {
  assert.equal(DEFAULT_MODEL, 'gpt-5.5');
  assert.equal(validateModel(undefined), DEFAULT_MODEL);
  assert.equal(validateModel('gpt-5.4'), 'gpt-5.4');
  assert.equal(validateModel('gpt-6.1-sol'), 'gpt-6.1-sol');
  for (const value of [null, '', ' gpt-5.5', '--sandbox', 'unknown', {}, 5]) assert.throws(() => validateModel(value), { code: 'HUNTER_INVALID' });
});
test('bounded local catalog exposes names and search-only compatibility without exposing private fields', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-models-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'models_cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', tool_mode: 'code_mode_only', private: 'never exposed' },
    { slug: 'gpt-6-astra', visibility: 'list', tool_mode: 'code_mode_only' },
    { slug: 'gpt-reserve', visibility: 'hide' }, { slug: 'invented', visibility: 'list' }
  ] }));
  const models = listModels({ cacheFile });
  assert.ok(models.find(m => m.id === DEFAULT_MODEL && m.available));
  assert.ok(models.find(m => m.id === 'gpt-5.4' && !m.available && /ChatGPT login/.test(m.reason)));
  assert.deepEqual(models.find(m => m.id === 'gpt-6.1-sol'), { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', available: true });
  assert.deepEqual(models.find(m => m.id === 'gpt-6-astra'), { id: 'gpt-6-astra', label: 'GPT-6 Astra', available: false, reason: 'Search-only compatibility has not been verified for this model yet.' });
  assert.equal(JSON.stringify(models).includes('never exposed'), false);
  assert.equal(models.some(m => ['gpt-reserve', 'invented'].includes(m.id)), false);
  fs.writeFileSync(cacheFile, '{broken'); assert.equal(listModels({ cacheFile }).length, 3);
  fs.writeFileSync(cacheFile, ' '.repeat(2 * 1024 * 1024 + 1)); assert.equal(listModels({ cacheFile }).length, 3);
});
