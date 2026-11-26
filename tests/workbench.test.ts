import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

test('select an authorized host, preview and remove attachments, retain the draft', async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'msedge' });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const scope = 'a'.repeat(64);
    const host = { name: '同名主机', deviceId: 'first', scope, online: true };
    await page.route('http://localhost:49002/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/devices') return route.fulfill({ json: { devices: [
        host, { ...host, deviceId: 'second', scope: 'b'.repeat(64), online: false },
      ] } });
      if (path.includes('/api/')) return route.fulfill({ json: { items: [], models: [], projects: [] } });
      const file = path === '/' ? 'devices.html' : path === '/devices/' + scope + '/' ? 'index.html' : path.slice(1);
      await route.fulfill({ path: fileURLToPath(new URL('../web/' + file, import.meta.url)) });
    });
    await page.goto('http://localhost:49002/');
    assert(await page.getByRole('button', { name: /second.*离线/ }).isDisabled());
    await page.getByRole('button', { name: /first.*在线/ }).click();
    await page.waitForURL('**/devices/' + scope + '/');
    assert.equal(await page.evaluate(() => localStorage.getItem('codex-receiver-selected-device')), 'first');
    assert.equal(await page.locator('#home-title').innerText(), '我们要构建什么？');
    const draft = page.locator('#prompt');
    await draft.fill('保留这份草稿');
    await page.locator('#file').setInputFiles({ name: 'demo.png', mimeType: 'image/png',
      buffer: await readFile(new URL('../web/codex.png', import.meta.url)) });
    await page.getByRole('button', { name: '查看demo.png' }).click();
    await page.locator('dialog.image-viewer[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '移除 demo.png' }).click();
    assert.equal(await page.locator('#attachment .chip').count(), 0);
    assert.equal(await draft.inputValue(), '保留这份草稿');
  } finally { await browser.close() }
});
