import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { stripTypeScriptTypes } from 'node:module';
import { readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const source of ['apps/workbench/public', 'apps/host', 'apps/receiver/windows']) {
  for (const entry of await readdir(resolve(root, source), { withFileTypes: true })) {
    if (entry.isFile()) await copyFile(resolve(root, source, entry.name), resolve(root, 'web', entry.name));
  }
}
for (const [source, output] of [
  ['apps/workbench/src', 'web'],
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
const offline = resolve(root, 'apps/workbench/offline');
const reconnect = await readFile(resolve(offline, 'reconnect.ts'), 'utf8');
const worker = await readFile(resolve(offline, 'receiver-worker.ts'), 'utf8');
await writeFile(resolve(root, 'web/receiver-worker.js'),
  stripTypeScriptTypes(worker).replace('/* OFFLINE_RECONNECT */', () => stripTypeScriptTypes(reconnect)));
await build({
  absWorkingDir: root, entryPoints: ['apps/workbench/src/markdown.ts'],
  outfile: 'web/markdown.js', bundle: true, minify: true, target: 'es2020',
});
const components = await build({
  absWorkingDir: root, entryPoints: ['apps/workbench/src/WorkbenchComponents.tsx'],
  bundle: true, write: false, minify: true, target: 'es2020',
  jsx: 'automatic', jsxImportSource: 'preact', globalName: 'WorkbenchComponents',
});
const chat = resolve(root, 'web/chat.js');
await writeFile(chat, "'use strict';\n" + components.outputFiles[0].text + '\n' + await readFile(chat, 'utf8'));
const directory = await build({
  absWorkingDir: root, entryPoints: ['apps/workbench/src/DeviceDirectory.tsx'],
  bundle: true, write: false, minify: true, target: 'es2020',
  jsx: 'automatic', jsxImportSource: 'preact',
});
const template = await readFile(resolve(root, 'apps/workbench/src/devices.html'), 'utf8');
const script = directory.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile(resolve(root, 'web/devices.html'), template.replace('/* DEVICE_DIRECTORY */', () => script));
