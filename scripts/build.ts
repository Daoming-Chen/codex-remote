import { execFileSync } from 'node:child_process';
import { build, transform } from 'esbuild';
import { stripTypeScriptTypes } from 'node:module';
import { readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const browserTarget = 'chrome83';
for (const source of ['apps/workbench/public', 'apps/host', 'apps/receiver/windows']) {
  for (const entry of await readdir(resolve(root, source), { withFileTypes: true })) {
    if (entry.isFile()) await copyFile(resolve(root, source, entry.name), resolve(root, 'web', entry.name));
  }
}
for (const [source, output] of [
  ['apps/receiver/src', 'web'],
  ['android/src', 'android'],
]) {
  for (const name of await readdir(resolve(root, source))) {
    if (!/\.(ts|mts|cts)$/.test(name) || name === 'markdown.ts') continue;
    const script = await readFile(resolve(root, source, name), 'utf8');
    const filename = name.replace(/ts$/, 'js');
    const emitted = resolve(root, output, filename);
    await writeFile(emitted, stripTypeScriptTypes(script));
    execFileSync(process.execPath, ['--check', emitted], { stdio: 'inherit' });
  }
}
// These classic scripts share global bindings with each other and the Android bridge.
for (const name of ['chat', 'voice-chat', 'dictation', 'voice-capture']) {
  const script = await readFile(resolve(root, 'apps/workbench/src', name + '.ts'), 'utf8');
  const {code} = await transform(script, {loader: 'ts', target: browserTarget});
  await writeFile(resolve(root, 'web', name + '.js'), code);
}
const offline = resolve(root, 'apps/workbench/offline');
const reconnect = await readFile(resolve(offline, 'reconnect.ts'), 'utf8');
const worker = await readFile(resolve(offline, 'receiver-worker.ts'), 'utf8');
await writeFile(resolve(root, 'web/receiver-worker.js'),
  stripTypeScriptTypes(worker).replace('/* OFFLINE_RECONNECT */', () => stripTypeScriptTypes(reconnect)));
await build({
  absWorkingDir: root, entryPoints: ['apps/workbench/src/markdown.ts'],
  outfile: 'web/markdown.js', bundle: true, minify: true, target: browserTarget,
});
// All supported WebViews have WOFF2. Embed those fonts so formulas also work offline.
const katexDist = resolve(root, 'node_modules/katex/dist');
const katexCss = (await readFile(resolve(katexDist, 'katex.css'), 'utf8'))
  .replace(/(format\("woff2"\)),[^;]+;/g, '$1;');
const mathStyles = await build({
  stdin: {contents:katexCss, loader:'css', resolveDir:katexDist},
  bundle:true, write:false, minify:true, loader:{'.woff2':'dataurl'}, target:browserTarget,
});
const css = resolve(root, 'web/chat.css');
const katexLicense = await readFile(resolve(katexDist, '../LICENSE'), 'utf8');
await writeFile(css, (await readFile(css, 'utf8')) + '\n/*! KaTeX\n' + katexLicense + '*/\n' + mathStyles.outputFiles[0].text);
const components = await build({
  absWorkingDir: root, entryPoints: ['apps/workbench/src/WorkbenchComponents.tsx'],
  bundle: true, write: false, minify: true, target: browserTarget,
  banner: {js: '/*! core-js\n' + await readFile(resolve(root, 'node_modules/core-js/LICENSE'), 'utf8') + '*/'},
  jsx: 'automatic', jsxImportSource: 'preact', globalName: 'WorkbenchComponents',
});
const chat = resolve(root, 'web/chat.js');
await writeFile(chat, "'use strict';\n" + components.outputFiles[0].text + '\n' + await readFile(chat, 'utf8'));
const directory = await build({
  absWorkingDir: root, entryPoints: ['apps/workbench/src/DeviceDirectory.tsx'],
  bundle: true, write: false, minify: true, target: browserTarget,
  jsx: 'automatic', jsxImportSource: 'preact',
});
const template = await readFile(resolve(root, 'apps/workbench/src/devices.html'), 'utf8');
const script = directory.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile(resolve(root, 'web/devices.html'), template.replace('/* DEVICE_DIRECTORY */', () => script));
