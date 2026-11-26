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
      if (path.endsWith('/api/models')) return route.fulfill({ json: {
        models: ['alpha', 'bravo', 'charlie', 'delta'].map(id => ({
          id, serviceTiers: [{id: 'fast', name: '快速'}], name: 'Model ' + id, isDefault: id === 'alpha', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'low',
        })),
        defaults: { model: 'alpha', effort: 'low' },
      } });
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
    await draft.fill('/model');
    await draft.press('Enter');
    const modelSearch = page.getByRole('textbox', { name: '搜索模型' });
    await modelSearch.waitFor();
    assert.equal(await page.locator('[data-recent]:visible').count(), 3);
    await modelSearch.fill('DELTA model');
    const matches = page.getByRole('menuitemradio');
    assert.equal(await matches.count(), 1);
    assert.equal(await matches.first().getAttribute('data-model-id'), 'delta');
    await modelSearch.press('Enter');
    assert.match(await page.locator('#model-label').innerText(), /delta/);
    await draft.fill('/model');
    await draft.press('Enter');
    await modelSearch.waitFor();
    assert.equal(await page.locator('[data-recent]:visible').first().getAttribute('aria-label'), 'Model delta');
    await modelSearch.press('Escape');
    await page.locator('#model-picker').click();
    const speed = page.locator('.speed-trigger');
    await speed.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.match(await speed.getAttribute('aria-label') || '', /快速/);
    assert(await speed.evaluate(el => el === document.activeElement));
    await speed.click();
    await page.getByRole('menuitemradio', {name: '沿用主机设置'}).click();
    assert.match(await speed.getAttribute('aria-label') || '', /沿用主机设置/);
    await speed.click();
    await page.keyboard.press('Escape');
    assert(await speed.evaluate(el => el === document.activeElement));
    const effort = page.getByRole('slider', { name: '强度' });
    await effort.evaluate(input => {
      const slider = input as HTMLInputElement;
      slider.value = '2';
      slider.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await page.locator('.effort-usage-reminder:visible').waitFor();
    await effort.dispatchEvent('pointercancel');
    assert.equal(await effort.inputValue(), '0');
    await effort.press('End');
    await page.locator('.effort-usage-reminder:visible').waitFor();
    assert.match(await effort.getAttribute('aria-valuetext') || '', /第 3 项/);
    await effort.press('Enter');
    await page.locator('#model-picker').click();
    assert.equal(await effort.inputValue(), '2');
    await effort.press('ArrowLeft');
    await page.locator('.effort-usage-reminder').waitFor({state: 'hidden'});
    await effort.press('Enter');
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
