import { renderWorkbenchPage } from '../apps/receiver/src/workbench-page.mts';
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
    const second = {...host, deviceId: 'second', scope: 'b'.repeat(64), online: false};
    let turnRequests = 0;
    await page.route('http://localhost:49002/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/api/turn')) turnRequests++;
      if (path === '/api/devices') return route.fulfill({ json: { devices: [
        host, second,
      ] } });
      if (path.endsWith('/api/native-capability')) return route.fulfill({json: {native: false}});
      if (path.endsWith('/api/models')) return route.fulfill({ json: {
        models: ['alpha', 'bravo', 'charlie', 'delta'].map(id => ({
          id, retirementAt: id === 'bravo' ? 1893456000 : undefined, description: '主机模型说明', serviceTiers: [{id: 'fast', name: '快速'}], name: 'Model ' + id, isDefault: id === 'alpha', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'low',
        })),
        defaults: { model: 'alpha', effort: 'low' },
      } });
      if (path.includes('/api/')) return route.fulfill({ json: { items: [], models: [], projects: [] } });
      const selected = [host, second].find(device => path === '/devices/' + device.scope + '/');
      if (selected) {
        const template = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
        return route.fulfill({contentType: 'text/html', body: renderWorkbenchPage(template, {
          deviceName: selected.name, scope: selected.scope, version: '0123456789abcdef', dictationEngine: 'windows',
        })});
      }
      const file = path === '/' || path === '/devices' ? 'devices.html' : path.slice(1);
      await route.fulfill({ path: fileURLToPath(new URL('../web/' + file, import.meta.url)) });
    });
    await page.goto('http://localhost:49002/');
    assert(await page.getByRole('button', { name: /second.*离线/ }).isDisabled());
    await page.getByRole('button', { name: /first.*在线/ }).click();
    await page.waitForURL('**/devices/' + scope + '/');
    assert.equal(await page.evaluate(() => localStorage.getItem('codex-receiver-selected-device')), 'first');
    assert.equal(await page.locator('#home-title').innerText(), '我们要构建什么？');
    assert.equal(await page.locator('.hostline [data-receiver-name]').textContent(), host.name);
    const panelToggle = page.getByRole('button', { name: '切换侧面板', exact: true });
    assert(await page.locator('#header-options').isHidden());
    await panelToggle.click();
    assert(await page.locator('#empty-work-panel').isVisible());
    assert.equal(await panelToggle.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Control+Alt+b');
    assert(await page.locator('#workbench').isHidden());
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
    await page.locator('.model-view-toggle').click();
    const retiring = page.getByRole('menuitemradio', {name: 'Model bravo'});
    assert.equal(await retiring.locator('.model-default-description').innerText(), '将于1月1日下线');
    assert.match(await retiring.getAttribute('aria-description') || '', /下线 · 主机模型说明/);
    assert.equal(await page.getByRole('menuitemradio', {name: 'Model delta'}).getAttribute('aria-checked'), 'true');
    await retiring.click();
    assert.match(await page.locator('.model-view-name').innerText(), /bravo/);
    await page.locator('.model-view-toggle').click();
    await page.getByRole('menuitemradio', {name: '默认',exact: true}).click();
    assert.match(await page.locator('.model-view-name').innerText(), /alpha/);
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
    await page.getByRole('button', {name: '查看任务权限'}).click();
    await page.getByRole('button', {name: '工作区写入', exact: true}).click();
    assert.equal(await page.locator('#sandbox-label').innerText(), '工作区写入');
    assert.equal(await draft.inputValue(), '保留这份草稿');
    assert.equal(turnRequests, 0);
    await page.locator('#file').setInputFiles({ name: 'demo.png', mimeType: 'image/png',
      buffer: await readFile(new URL('../web/codex.png', import.meta.url)) });
    await page.getByRole('button', { name: '查看demo.png' }).click();
    await page.locator('dialog.image-viewer[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '移除 demo.png' }).click();
    assert.equal(await page.locator('#attachment .chip').count(), 0);
    assert.equal(await draft.inputValue(), '保留这份草稿');
    second.online = true;
    const directory = 'http://localhost:49002/devices';
    await page.goto(directory);
    await page.getByRole('button', {name: /second.*在线/}).click();
    await page.waitForURL('**/devices/' + second.scope + '/');
    assert.equal(await draft.inputValue(), '');
    await draft.fill('第二台主机的草稿');
    host.name = '改名 & <主机> "__DICTATION_ENGINE__"';
    await page.goto(directory);
    await page.getByRole('button', {name: /改名/}).click();
    await page.waitForURL('**/devices/' + scope + '/');
    assert.equal(await page.locator('.hostline [data-receiver-name]').textContent(), host.name);
    assert.equal(await page.locator('#dictate').getAttribute('data-engine'), 'windows');
    assert.equal(await draft.inputValue(), '保留这份草稿');
    await page.goto(directory);
    await page.getByRole('button', {name: /同名主机/}).click();
    await page.waitForURL('**/devices/' + second.scope + '/');
    assert.equal(await draft.inputValue(), '第二台主机的草稿');
  } finally { await browser.close() }
});

test('authorization refresh discards a stale device before restoring a saved selection', async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'msedge' });
  try {
    const page = await browser.newPage();
    let requests = 0;
    let openGate!: () => void;
    const gate = new Promise<void>(resolve => { openGate = resolve });
    const origin = 'http://localhost:49003';
    await page.addInitScript(() => localStorage.setItem('codex-receiver-selected-device', 'old'));
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({path: fileURLToPath(new URL('../web/devices.html', import.meta.url))});
      if (path !== '/api/devices') return route.fulfill({status: 404, body: ''});
      const first = ++requests === 1;
      if (first) await gate;
      return route.fulfill({json: {devices: first ? [
        {deviceId: 'old', scope: 'a'.repeat(64), name: '先前的主机', online: true},
      ] : []}});
    });
    const firstRequest = page.waitForRequest(origin + '/api/devices');
    await page.goto(origin);
    await firstRequest;
    await page.evaluate(() => {
      window.receiverAuthorized?.();
      window.receiverAuthorized?.();
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    openGate();
    await page.getByText('当前账号暂无已授权设备').waitFor();
    assert.equal(requests, 2);
    assert.equal(page.url(), origin + '/');
    assert.equal(await page.locator('#devices button').count(), 0);
  } finally { await browser.close() }
});

test('restore a streaming turn after sending on another device with the same thread ID', async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'msedge' });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    page.setDefaultTimeout(10000);
    const hosts = ['a', 'b'].map(key => ({deviceId: key, scope: key.repeat(64), name: '同名设备', online: true}));
    const origin = 'http://localhost:49004';
    const template = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
    const jobs = new Map<string, {id: string; done: boolean}>();
    const posts: string[] = [];
    const wrongHost: string[] = [];
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const device = hosts.find(host => path.startsWith('/devices/' + host.scope + '/'));
      const api = device ? path.slice(('/devices/' + device.scope).length) : path;
      if (path === '/api/devices') return route.fulfill({json: {devices: hosts}});
      if (device && api === '/') return route.fulfill({contentType: 'text/html', body: renderWorkbenchPage(template, {
        deviceName: device.name, scope: device.scope, version: '0123456789abcdef', dictationEngine: 'browser',
      })});
      if (api === '/api/native-capability') return route.fulfill({json: {native: false}});
      if (device && api === '/api/turn') {
        const {id} = route.request().postDataJSON();
        posts.push(device.deviceId);
        jobs.set(device.deviceId, {id, done: device.deviceId === 'b'});
        return route.fulfill({json: {id}});
      }
      if (device && api.startsWith('/api/turn/')) {
        const job = jobs.get(device.deviceId);
        if (!job || api.split('/')[3] !== job.id) {
          wrongHost.push(path);
          return route.fulfill({status: 404});
        }
        const snapshot = {id: job.id, created: 1000, observedTextAt: 1100, thread: 'shared-thread', turn: 'shared-turn',
          progress: job.done ? {} : {message: '第一台正在流式输出'},
          status: job.done ? 'done' : 'running', answer: job.done ? device.deviceId + ' 的最终回复' : ''};
        if (api.endsWith('/events')) return route.fulfill({contentType: 'text/event-stream',
          body: 'data: ' + JSON.stringify(snapshot) + '\n\n'});
        return route.fulfill({json: snapshot});
      }
      if (api.includes('/api/')) return route.fulfill({json: {items: [], projects: [], models: [], ids: []}});
      const file = path === '/devices' ? 'devices.html' : path.slice(1);
      return route.fulfill({path: fileURLToPath(new URL('../web/' + file, import.meta.url))});
    });
    async function select(index: number) {
      await page.goto(origin + '/devices');
      const host = hosts[index];
      await page.locator('#devices button').filter({has: page.getByText(host.deviceId, {exact: true})}).click();
      await page.waitForURL('**/devices/' + host.scope + '/');
    }
    async function send(message: string) {
      await page.locator('#prompt').fill(message);
      await page.locator('#prompt').press('Enter');
    }
    const messages = page.locator('#messages');
    await select(0);
    const started = page.waitForRequest(req => req.url().includes('/api/turn/') && req.url().endsWith('/events'));
    await send('第一台的提问');
    await started;
    await messages.getByText('第一台正在流式输出', {exact: true}).waitFor();
    await select(1);
    jobs.get('a')!.done = true;
    await send('第二台的提问');
    await messages.getByText('b 的最终回复', {exact: true}).waitFor();
    assert.doesNotMatch(await messages.innerText(), /第一台的提问|第一台正在流式输出|a 的最终回复/);
    await page.getByRole('button', {name: 'Codex 连接信息'}).click();
    await page.getByText(/前台发送到页面收到首段正文/).waitFor();
    await page.keyboard.press('Escape');
    await select(0);
    await messages.getByText('a 的最终回复', {exact: true}).waitFor();
    assert.match(await messages.innerText(), /第一台的提问/);
    assert.doesNotMatch(await messages.innerText(), /第二台的提问|b 的最终回复/);
    assert.deepEqual(posts, ['a', 'b']);
    assert.deepEqual(wrongHost, []);
  } finally { await browser.close() }
});
