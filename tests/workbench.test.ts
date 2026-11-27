import { renderWorkbenchPage } from '../apps/receiver/src/workbench-page.mts';
import { searchDirectoryFiles } from '../apps/workbench/src/PanelSearch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

test('native file search pauses after a bounded scan and can search dependency paths explicitly',async()=>{
  const names=Array.from({length:16},(_,i)=>'dir'+(i+1)),visited:string[]=[];
  let concurrent=0,peak=0;
  const list=async(path:string)=>{
    visited.push(path);peak=Math.max(peak,++concurrent);
    await Promise.resolve();concurrent--;
    return {folders:path?[]:[...names,'node_modules'],files:path==='dir16'||path==='node_modules'?['needle.ts']:[]};
  };
  const signal=new AbortController().signal;
  const pages=searchDirectoryFiles('needle',signal,list);
  const first=await pages.next();assert(!first.done);
  assert(first.value.more&&first.value.skipped);
  assert.equal(visited.length,12);assert.equal(peak,2);
  const last=await pages.next();assert(!last.done);
  assert.deepEqual(last.value.files,['dir16/needle.ts']);assert(!last.value.more);
  assert(!visited.includes('node_modules'));
  const explicit=await searchDirectoryFiles('node_modules/needle',signal,list).next();
  assert(!explicit.done);assert.deepEqual(explicit.value.files,['node_modules/needle.ts']);
});

test('select an authorized host, preview and remove attachments, retain the draft', async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'msedge' });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block', viewport: {width: 1920, height: 1078} });
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
    await page.getByRole('link', {name: '切换设备，当前为 '+host.name}).click();
    await page.getByRole('button', {name: /second.*在线/}).click();
    await page.waitForURL('**/devices/' + second.scope + '/');
    assert.equal(await draft.inputValue(), '');
    await draft.fill('第二台主机的草稿');
    host.name = '改名 & <主机> "__DICTATION_ENGINE__"' + '很长的设备名'.repeat(20);
    await page.goto(directory);
    await page.getByRole('button', {name: /改名/}).click();
    await page.waitForURL('**/devices/' + scope + '/');
    assert.equal(await page.locator('.hostline [data-receiver-name]').textContent(), host.name);
    const hostLink = page.locator('#composer-device');
    assert.equal(await page.locator('.rail-profile').innerText(),'改主');
    const project = page.getByRole('button', {name: '选择远程项目'});
    for (const width of [1920, 820, 390]) {
      await page.setViewportSize({width, height: 1078});
      if(width === 1920) await page.waitForFunction(() => {
        const box = document.getElementById('composer')!.getBoundingClientRect();
        return Math.abs(box.x - 745) <= 2 && Math.abs(box.bottom - 1062) <= 2;
      }, undefined, {timeout: 5000});
      const [linkBox, projectBox, composerBox] = await Promise.all([hostLink.boundingBox(), project.boundingBox(), page.locator('#composer').boundingBox()]);
      assert(linkBox && projectBox && composerBox);
      assert(linkBox.x + linkBox.width <= projectBox.x && projectBox.x + projectBox.width <= width);
      if(width === 1920){
        assert(Math.abs(composerBox.x - 745) <= 2);
        assert(Math.abs(composerBox.width - 736) <= 2);
        const modelBox = await page.locator('#model-picker').boundingBox();
        assert(modelBox && modelBox.x > composerBox.x + composerBox.width / 2);
        assert(modelBox.x + modelBox.width <= composerBox.x + composerBox.width);
        assert(linkBox.y < composerBox.y && Math.abs(composerBox.y + composerBox.height - 1062) <= 2);
      }
    }
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
    await page.getByRole('button', {name: '设置',exact:true}).click();
    await page.getByRole('button', {name: '连接信息',exact:true}).click();
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

for (const mode of ['daemon', 'native', 'legacy'] as const) test('touch selection sends the model and effort shown by the tablet composer · ' + mode, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'msedge' });
  try {
    const page = await browser.newPage({hasTouch: true, isMobile: true, viewport: {width: 960, height: 720}, serviceWorkers: 'block'});
    const errors: Error[] = [];
    page.on('pageerror',error=>errors.push(error));
    if (mode === 'native') await page.addInitScript(() => {
      // Older WebViews lack both the methods and the corresponding selector syntax.
      for (const name of ['showPopover','hidePopover','togglePopover']) Reflect.deleteProperty(HTMLElement.prototype,name);
      const matches = Element.prototype.matches;
      Object.defineProperty(Element.prototype,'matches',{value:function(this:Element,selector:string) {
        if (selector.includes(':popover-open')) throw new DOMException('Unsupported selector','SyntaxError');
        return matches.call(this,selector);
      }});
    });
    page.setDefaultTimeout(8000);
    const directory = process.env.WORKBENCH_ASSET_DIR ?? fileURLToPath(new URL('../web/', import.meta.url));
    const scope = 'c'.repeat(64);
    const origin = 'http://localhost:49005';
    const base = '/devices/' + scope;
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === base + '/') {
        const template = await readFile(directory + '/index.html', 'utf8');
        return route.fulfill({contentType: 'text/html', body: renderWorkbenchPage(template, {
          deviceName: '平板测试主机', scope, version: '0123456789abcdef', dictationEngine: 'browser',
        })});
      }
      if (path === base + '/api/models') return route.fulfill({json: {
        canSetServiceTier: mode !== 'legacy',
        models: ['alpha', 'bravo'].map(id => ({id, name: id, isDefault: id === 'alpha',
          serviceTiers: [{id: 'priority',name: 'Fast'}, {id: 'ultrafast',name: 'Ultrafast'}],
          efforts: ['low', 'medium', 'high'], defaultEffort: 'low'})), defaults: {model: 'alpha', effort: 'low'},
      }});
      if (path === base + '/api/native-capability') return route.fulfill({json: {native: mode !== 'daemon'}});
      if (path === base + '/api/turn') return route.fulfill({json: {id: route.request().postDataJSON().id}});
      if (path.includes('/api/')) return route.fulfill({json: {items: [], projects: [], models: []}});
      return route.fulfill({path: directory + path});
    });
    await page.goto(origin + base + '/');
    if (mode !== 'daemon') {
      await page.locator('[data-action=permissions]').tap();
      await page.getByRole('button', {name: '工作区写入（按需审批）', exact: true}).tap();
    }
    await page.locator('#model-picker').tap();
    await page.locator('.model-view-toggle').tap();
    await page.getByRole('menuitemradio', {name: 'bravo', exact: true}).tap();
    const slider = page.getByRole('slider', {name: '强度'});
    const box = await slider.boundingBox();
    assert(box);
    await slider.tap({position: {x: box.width - 6, y: box.height / 2}});
    assert.equal(await slider.inputValue(), '2');
    await page.locator('.speed-trigger').tap();
    if (mode === 'native') {
      const flyout = page.locator('dialog.speed-flyout[open]');
      await flyout.waitFor();
      await page.setViewportSize({width:780,height:540});
      await page.waitForFunction(() => {
        const panel = document.querySelector('dialog.speed-flyout')!.getBoundingClientRect();
        const anchor = document.querySelector('.speed-trigger')!.getBoundingClientRect();
        const side = anchor.left - 8 >= panel.width + 4 ? anchor.left - panel.width - 4 : anchor.right + 4;
        return panel.width>0 && Math.abs(panel.left - Math.max(8,Math.min(side,innerWidth - 8 - panel.width)))<2 &&
          panel.top>=7 && panel.bottom<=innerHeight-7;
      });
      await page.touchscreen.tap(2,2);
      await flyout.waitFor({state:'hidden'});
      assert(await page.locator('#dialog').isVisible());
      await page.locator('.speed-trigger[aria-expanded=false]').waitFor();
      await page.locator('.speed-trigger').tap();
      const handled = await page.evaluate(() => (window as typeof window & {dismissWorkbenchOverlay:()=>boolean}).dismissWorkbenchOverlay());
      assert(handled);
      await flyout.waitFor({state:'hidden'});
      assert(await page.locator('.speed-trigger').evaluate(el=>el===document.activeElement));
      await page.locator('.speed-trigger').press('ArrowDown');
      await flyout.press('Escape');
      await flyout.waitFor({state:'hidden'});
      assert(await page.locator('#dialog').isVisible());
      await page.setViewportSize({width:960,height:720});
      await page.locator('.speed-trigger').tap();
    }
    const tier = mode === 'daemon' ? 'Fast' : 'Ultrafast';
    const choice = page.getByRole('menuitemradio', {name: tier,exact:true});
    if (mode === 'legacy') {
      assert(await choice.isDisabled());
      await page.getByRole('menuitemradio', {name:'沿用主机设置'}).tap();
    } else {
      await choice.tap();
    }
    await page.reload();
    if (mode !== 'legacy') {
      await page.locator('#model-picker').tap();
      await page.locator('.speed-trigger').tap();
      assert.equal(await choice.getAttribute('aria-checked'), 'true');
      await choice.tap();
    }
    await page.touchscreen.tap(5, 5);
    await page.locator('#dialog').waitFor({state: 'hidden'});
    assert.equal(await page.locator('.model-trigger-name').innerText(), 'bravo');
    assert.equal((await page.locator('.model-strength').innerText()).trim(), '高');
    await page.locator('#prompt').fill('测试模型选择');
    const submitted = page.waitForRequest(req => req.url() === origin + base + '/api/turn' && req.method() === 'POST');
    await page.locator('#send').tap();
    const payload = (await submitted).postDataJSON();
    assert.equal(payload.serviceTier, mode === 'legacy' ? null : mode === 'daemon' ? 'priority' : 'ultrafast');
    assert.deepEqual([payload.model, payload.effort, payload.prompt], ['bravo', 'high', '测试模型选择']);
    assert.deepEqual(errors.map(e=>e.message),[]);
  } finally { await browser.close() }
});

test('browse the selected host project and read nested working files on a tablet', async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH
    ? {executablePath: process.env.CHROMIUM_PATH} : {channel: 'msedge'});
  try {
    const page = await browser.newPage({hasTouch: true, isMobile: true, viewport: {width: 820,height: 900},serviceWorkers: 'block'});
    page.setDefaultTimeout(8000);
    const origin = 'http://localhost:49007', scope = 'd'.repeat(64), base = '/devices/' + scope;
    const root = 'C:\\dev\\demo', project = {name:'平板项目', id:'fixture-project', roots:[root]};
    const directory = process.env.WORKBENCH_ASSET_DIR ?? fileURLToPath(new URL('../web/',import.meta.url));
    let snapshot: unknown;
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === base + '/') return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(
        await readFile(directory + '/index.html','utf8'), {deviceName:'文件主机',scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if (path === base + '/api/threads') return route.fulfill({json:{items:[],projects:[project]}});
      if (path === base + '/api/project-directories') {
        const {relative,workspace} = route.request().postDataJSON();
        assert.equal(workspace,root);
        return route.fulfill({json:{folders:relative ? [] : ['src'],files:relative ? ['note.txt'] : []}});
      }
      if (path === base + '/api/project-file-snapshot') {
        snapshot = route.request().postDataJSON();
        return route.fulfill({json:{source:'working-tree', text:'今天的工作区内容 <b>文本</b>'}});
      }
      if (path.includes('/api/')) return route.fulfill({json:{native:true, items:[],projects:[],models:[]}});
      return route.fulfill({path:directory + path});
    });
    await page.goto(origin + base + '/');
    await page.getByRole('button',{name:'选择远程项目',exact:true}).tap();
    await page.locator('#dialog [data-project-option]').first().tap();
    await page.getByRole('button',{name:'切换侧面板',exact:true}).tap();
    await page.getByRole('button',{name:'新建标签页',exact:true}).tap();
    await page.locator('#dialog').getByRole('button',{name:'文件资源管理器',exact:true}).tap();
    await page.locator('.project-explorer-tree summary').filter({hasText:'src'}).tap();
    await page.getByRole('button',{name:'note.txt',exact:true}).tap();
    await page.locator('.project-explorer-reader pre').waitFor();
    assert.equal(await page.locator('.project-explorer-reader pre').innerText(),'今天的工作区内容 <b>文本</b>');
    assert.deepEqual(snapshot,{root,path:root + '\\src\\note.txt',workspace:root,workingTree:true});
    await page.reload();
    await page.locator('.project-explorer-reader pre').waitFor();
    await page.getByRole('button',{name:'返回文件列表',exact:true}).tap();
    assert(await page.getByRole('button',{name:'note.txt',exact:true}).isVisible());
  } finally { await browser.close() }
});

test('show tabs opens one combobox for project files and approved host web apps on a tablet', async () => {
  const browser=await chromium.launch(process.env.CHROMIUM_PATH
    ? {executablePath:process.env.CHROMIUM_PATH} : {channel:'msedge'});
  try {
    const page=await browser.newPage({hasTouch:true,isMobile:true,viewport:{width:820,height:900},serviceWorkers:'block'});
    page.setDefaultTimeout(7000);
    const origin='http://localhost:49010',scope='f'.repeat(64),base='/devices/'+scope;
    const root='C:\\work\\demo',thread='00000000-0000-4000-8000-000000000010';
    const project={id:'demo',name:'项目',roots:[root]},messages=[{role:'assistant',text:'这是一个已有的聊天。'}];
    const assets=process.env.WORKBENCH_ASSET_DIR ?? fileURLToPath(new URL('../web/',import.meta.url));
    const proxy='http://dsh-'+'c'.repeat(48)+'.localhost:5173';
    let requestedPort=0,readPath='';
    const childThread='00000000-0000-4000-8000-000000000012';
    let sideJob='';
    await page.addInitScript(({scope,root,thread,project,messages})=>{
      const chat={id:thread,thread,cwd:root,projectId:project.id,messages,draft:'保留草稿',files:[],title:'已有聊天',updated:Date.now()};
      localStorage.setItem('receiver:'+scope+':tim-ser-chats-v2',JSON.stringify({active:chat.id,chats:[chat],hostProjects:[project]}));
    },{scope,root,thread,project,messages});
    await page.route(proxy+'/**',route=>route.fulfill({contentType:'text/html',body:'QA Web app'}));
    await page.route(origin+'/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(
        await readFile(assets+'/index.html','utf8'),{deviceName:'主机',scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path===base+'/api/native-capability')return route.fulfill({json:{native:true}});
      if(path===base+'/api/threads')return route.fulfill({json:route.request().postDataJSON().thread
        ? {thread,cwd:root,messages,projectId:project.id} : {items:[],projects:[project]}});
      if(path===base+'/api/project-directories'){
        const {relative}=route.request().postDataJSON();
        if(relative==='slow')return;
        return route.fulfill({json:{folders:relative?[]:['src'],files:relative==='src'?['note.txt']:[]}});
      }
      if(path===base+'/api/project-file-snapshot'){
        readPath=route.request().postDataJSON().path;
        return route.fulfill({json:{source:'working-tree',text:'项目文件内容'}});
      }
      if(path===base+'/api/web-preview/ports')return route.fulfill({json:{ports:[5173]}});
      if(path===base+'/api/thread-fork'){
        const request=route.request().postDataJSON();
        assert.equal(request.thread,thread);assert.equal(request.sideChat,true);
        return route.fulfill({json:{source:thread,thread:childThread}});
      }
      if(path===base+'/api/turn'){
        const request=route.request().postDataJSON();
        assert.equal(request.expectedThread,childThread);assert.equal(request.prompt,'侧边草稿');
        sideJob=request.id;
        return route.fulfill({json:{id:sideJob}});
      }
      if(sideJob&&path.startsWith(base+'/api/turn/'+sideJob)){
        const snapshot={id:sideJob,status:'done',thread:childThread,turn:'side-turn',answer:'侧边回复'};
        return path.endsWith('/events')
          ? route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(snapshot)+'\n\n'})
          : route.fulfill({json:snapshot});
      }
      if(path===base+'/api/web-preview/open'){
        requestedPort=route.request().postDataJSON().port;
        if(requestedPort===5174)return route.fulfill({status:403,json:{error:'主机未允许此端口'}});
        return route.fulfill({json:{url:proxy+'/'}});
      }
      if(path.includes('/api/'))return route.fulfill({json:{items:[],models:[],projects:[]}});
      return route.fulfill({path:assets+path});
    });
    await page.goto(origin+base+'/');
    await page.getByRole('button',{name:'显示标签页',exact:true}).tap();
    const box=page.getByRole('combobox',{name:'搜索文件或输入 URL'});
    assert(await page.getByRole('region',{name:'新标签页'}).isVisible());
    await box.tap();
    await box.fill('文件');
    assert(await page.getByRole('option',{name:'文件资源管理器',exact:true}).isVisible());
    const pending=page.waitForRequest(req=>req.url().endsWith('/api/project-directories')&&req.postDataJSON().relative==='slow');
    await box.fill('slow/obsolete');
    const obsolete=await pending;
    const aborted=page.waitForEvent('requestfailed',req=>req===obsolete);
    await box.fill('note');
    await aborted;
    await page.getByRole('option',{name:'src/note.txt'}).tap();
    await page.locator('.project-explorer-reader pre').waitFor();
    assert.equal(readPath,root+'\\src\\note.txt');
    await page.getByRole('button',{name:'关闭 文件资源管理器',exact:true}).tap();
    await box.fill('localhost:5174');
    await page.getByRole('option',{name:'http://localhost:5174/'}).tap();
    await page.getByText('主机未允许此端口').waitFor();
    await page.getByRole('button',{name:'刷新端口'}).tap();
    await page.getByRole('button',{name:'localhost:5173'}).waitFor();
    await page.getByRole('button',{name:'关闭 浏览器',exact:true}).tap();
    await box.fill('localhost:5173/demo?q=1#view');
    await page.getByRole('option',{name:'http://localhost:5173/demo?q=1#view'}).tap();
    await page.frameLocator('iframe[title="主机网页预览"]').getByText('QA Web app').waitFor();
    assert.equal(requestedPort,5173);
    assert.equal(await page.locator('iframe[title="主机网页预览"]').getAttribute('src'),proxy+'/demo?q=1#view');
    await page.getByRole('textbox',{name:'主机网页地址'}).fill('localhost:5174');
    await page.getByRole('button',{name:'打开',exact:true}).tap();
    await page.getByText('主机未允许此端口').waitFor();
    assert.equal(await page.locator('iframe[title="主机网页预览"]').count(),0);
    await page.getByRole('button',{name:'关闭工作区',exact:true}).tap();
    assert(await page.locator('#workbench').isHidden());
    assert.equal(await page.locator('#prompt').inputValue(),'保留草稿');
    await page.locator('#header-options').tap();
    await page.getByRole('button',{name:'打开侧边聊天',exact:true}).tap();
    const sideDraft=page.getByRole('textbox',{name:'在侧边聊天中提问'});
    await sideDraft.fill('侧边草稿');
    await page.keyboard.press('Control+Alt+s');
    assert.equal(await sideDraft.inputValue(),'');
    assert.equal(await page.locator('#work-tabs .work-tab').count(),2);
    assert(await sideDraft.evaluate(field=>document.activeElement===field));
    await page.getByRole('button',{name:'关闭 侧边聊天 2',exact:true}).tap();
    assert.equal(await sideDraft.inputValue(),'侧边草稿');
    assert.equal(await page.locator('#prompt').inputValue(),'保留草稿');
    await page.getByRole('button',{name:'新建标签页',exact:true}).tap();
    await page.getByRole('dialog').getByRole('button',{name:'侧边聊天',exact:true}).tap();
    assert.equal(await sideDraft.inputValue(),'');
    assert.equal(await page.locator('#work-tabs .work-tab').count(),2);
    assert.equal(await page.locator('#work-tabs .work-tab').nth(1).innerText(),'侧边聊天 2');
    await page.locator('#work-tabs .work-tab').first().tap();
    assert.equal(await sideDraft.inputValue(),'侧边草稿');
    await page.locator('.side-chat').getByRole('button',{name:'发送',exact:true}).tap();
    await page.locator('.side-chat-history').getByText('侧边回复',{exact:true}).waitFor();
    assert.equal(await page.locator('#messages').getByText('侧边回复',{exact:true}).count(),0);
    assert.equal(await page.locator('#prompt').inputValue(),'保留草稿');
  } finally { await browser.close() }
});
