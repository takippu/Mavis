'use strict';
const path = require('path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const outdir = path.join(root, 'src', 'renderer', 'editor-build');
async function build() {
  await esbuild.build({ entryPoints: [path.join(root, 'src', 'renderer', 'editor-entry.js')], bundle: true, minify: true, format: 'iife', outdir, loader: { '.ttf': 'file' }, target: 'chrome130' });
  for (const [name, entry] of Object.entries({ editor: 'vs/editor/editor.worker.js', json: 'vs/language/json/json.worker.js', css: 'vs/language/css/css.worker.js', html: 'vs/language/html/html.worker.js', ts: 'vs/language/typescript/ts.worker.js' })) {
    await esbuild.build({ entryPoints: [path.join(root, 'node_modules/monaco-editor/esm', entry)], bundle: true, minify: true, format: 'iife', outfile: path.join(outdir, name + '.worker.js'), target: 'chrome130' });
  }
}
build().catch(e => { console.error(e); process.exitCode = 1; });
