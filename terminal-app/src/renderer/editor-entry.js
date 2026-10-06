import * as monaco from 'monaco-editor';
const workerBase = new URL('./editor-build/', location.href);
globalThis.MonacoEnvironment = { getWorkerUrl(_id, label) { const name = label === 'typescript' || label === 'javascript' ? 'ts' : ['json', 'css', 'html'].includes(label) ? label : 'editor'; return new URL(name + '.worker.js', workerBase).href; } };
globalThis.mavisEditor = monaco;
