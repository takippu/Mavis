'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const DEFAULT_MODEL = 'gpt-5.5';
const DIRECT_WEB_MODELS = Object.freeze(['gpt-6.1-sol']);
const LABELS = Object.freeze({
  'gpt-5.5': 'GPT-5.5', 'gpt-5.4': 'GPT-5.4',
  'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6-sol': 'GPT-6 Sol', 'gpt-6-luna': 'GPT-6 Luna',
  'gpt-5.6-sol': 'GPT-5.6 Sol', 'gpt-5.6-terra': 'GPT-5.6 Terra', 'gpt-5.6-luna': 'GPT-5.6 Luna'
});
function validateModel(value = DEFAULT_MODEL) {
  if (typeof value !== 'string' || !Object.hasOwn(LABELS, value)) throw Object.assign(new Error('Unsupported Discover model. Choose a model from the agent menu.'), { code: 'HUNTER_INVALID' });
  return value;
}
function listModels({ cacheFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json') } = {}) {
  // Account access is still checked by Codex at launch; no automatic model fallback.
  const models = [{ id: DEFAULT_MODEL, label: LABELS[DEFAULT_MODEL], available: true },
    ...DIRECT_WEB_MODELS.map(id => ({ id, label: LABELS[id], available: true })),
    { id: 'gpt-5.4', label: LABELS['gpt-5.4'], available: false, reason: 'Codex does not support this model with the current ChatGPT login.' }];
  try {
    if (fs.statSync(cacheFile).size > 2 * 1024 * 1024) return models;
    const catalog = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!Array.isArray(catalog.models)) return models;
    for (const entry of catalog.models.slice(0, 100)) {
      const id = entry?.slug;
      if (!Object.hasOwn(LABELS, id) || entry.visibility !== 'list' || models.some(m => m.id === id)) continue;
      // Catalog search support is not proof of compatibility with this isolated runner.
      models.push({ id, label: LABELS[id], available: false, reason: 'Search-only compatibility has not been verified for this model yet.' });
    }
  } catch { /* Missing or malformed metadata leaves the native-search choices intact. */ }
  return models;
}
module.exports = { DEFAULT_MODEL, DIRECT_WEB_MODELS, validateModel, listModels };
