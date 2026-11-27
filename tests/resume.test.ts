import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {renderWorkbenchPage} from '../apps/receiver/src/workbench-page.mts';
import {createDeviceDirectory} from '../apps/receiver/src/device-directory.mts';

const assets = process.env.WORKBENCH_ASSET_DIR ?? fileURLToPath(new URL('../web/',import.meta.url));
const origin = 'http://localhost:49009';
const host = {name:'恢复测试主机',deviceId:'reconnected-host',scope:'a'.repeat(64),online:true};
const base = '/devices/' + host.scope;

function launch() {
  return chromium.launch(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {channel:'msedge'});
}

test('restarted discovery owns the device list when the superseded host replies last', async () => {
  let oldReply!: (hosts:typeof host[]) => void;
  let oldSignal: AbortSignal | undefined;
  let attempts = 0;
  const directory = createDeviceDirectory(signal => {
    if (++attempts === 1) {
      oldSignal = signal;
      return new Promise(resolve => {oldReply=resolve});
    }
    return Promise.resolve([host]);
  });
  const first = directory.list();
  const second = await directory.list(true);
  assert(oldSignal?.aborted);
  oldReply([{...host,deviceId:'old-host',name:'过期主机'}]);
  assert.deepEqual(await first,second);
  assert.deepEqual([...directory.devices.values()].map(h=>h.deviceId),[host.deviceId]);
  assert.equal(attempts,2,'a superseded response must not launch another discovery');
});

for (const hidden of [false,true]) test('network resume replaces a hanging tablet device-list request, hidden=' + hidden, async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({serviceWorkers:'block',hasTouch:true,viewport:{width:820,height:920}});
    page.setDefaultTimeout(5000);
    let count = 0;
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/devices') return route.fulfill({path:resolve(assets,'devices.html')});
      if (path === '/api/devices') {
        count++;
        if (count === 1) return; // Old connection never delivers response headers.
        assert.equal(route.request().headers()['x-receiver-network-resumed'],'1');
        return route.fulfill({json:{devices:[host]}});
      }
      return route.abort();
    });
    const pending = page.waitForRequest(req => req.url().endsWith('/api/devices'));
    await page.goto(origin + '/devices');
    const stale = await pending;
    const aborted = page.waitForEvent('requestfailed',req => req === stale);
    await page.evaluate(hidden => {
      if (hidden) Object.defineProperty(document,'hidden',{value:true,configurable:true});
      window.receiverNetworkResumed!();
      if (hidden) {
        Reflect.deleteProperty(document,'hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      }
    },hidden);
    await aborted;
    const device = page.getByRole('button',{name:/恢复测试主机.*在线/});
    await device.waitFor();
    assert(await device.isEnabled());
    assert.equal(count,2);
  } finally { await browser.close() }
});

test('failed network resume retries once, restores the same turn and preserves the unsent draft', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({serviceWorkers:'block',hasTouch:true,viewport:{width:820,height:920}});
    page.setDefaultTimeout(8000);
    // WebView 83 lacks these APIs on the startup, send, and foreground recovery paths.
    await page.addInitScript(() => {
      Reflect.deleteProperty(Crypto.prototype, 'randomUUID');
      Reflect.deleteProperty(AbortSignal, 'timeout');
      Reflect.deleteProperty(Element.prototype, 'replaceChildren');
      Reflect.deleteProperty(Array.prototype, 'at');
      Reflect.deleteProperty(Array.prototype, 'findLast');
      Reflect.deleteProperty(Array.prototype, 'findLastIndex');
      Reflect.deleteProperty(String.prototype, 'replaceAll');
      Reflect.deleteProperty(Object, 'hasOwn');
    });
    const template = await readFile(resolve(assets,'index.html'),'utf8');
    let resumeCount = 0, submitCount = 0, jobId = '', recovered = false;
    let failFirst!: () => void;
    const firstFailure = new Promise<void>(resolve => {failFirst=resolve});
    const firstResume = page.waitForRequest(req => req.url() === origin+base+'/api/resume');
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === base + '/') return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(template,{
        deviceName:host.name,scope:host.scope,version:'0123456789abcdef',dictationEngine:'browser',
      })});
      if (path === base + '/api/resume') {
        assert.equal(route.request().method(),'POST');
        if (++resumeCount === 1) {
          await firstFailure;
          return route.fulfill({status:503,json:{error:'暂时离线'}});
        }
        recovered = true;
        return route.fulfill({json:{connected:true,reused:resumeCount>2}});
      }
      if (path === base + '/api/turn') {
        submitCount++;
        jobId = route.request().postDataJSON().id;
        assert.match(jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        return route.fulfill({json:{id:jobId}});
      }
      if (jobId && path.startsWith(base + '/api/turn/')) {
        assert.equal(path.split('/')[5],jobId);
        const snapshot = {id:jobId,created:1000,thread:'fixture-thread',turn:'fixture-turn',
          status:recovered?'done':'running',answer:recovered?'恢复后收到原轮次的回复':'',progress:recovered?{}:{message:'正在处理已发送消息'}};
        return path.endsWith('/events')
          ? route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(snapshot)+'\n\n'})
          : route.fulfill({json:snapshot});
      }
      if (path === base + '/api/native-capability') return route.fulfill({json:{native:false}});
      if (path.includes('/api/')) return route.fulfill({json:{items:[],projects:[],models:[]}});
      return route.fulfill({path:resolve(assets,path.slice(1))});
    });
    await page.goto(origin + base + '/');
    const draft = page.locator('#prompt');
    await draft.fill('首次发送');
    await page.locator('#send').tap();
    await page.locator('#messages').getByText('正在处理已发送消息',{exact:true}).waitFor();
    await draft.fill('切网时仍在编辑');
    await page.evaluate(() => { void window.receiverNetworkResumed!() });
    await firstResume;
    await page.evaluate(() => { void window.receiverNetworkResumed!() });
    failFirst();
    await page.locator('.rail-profile[data-offline]').waitFor();
    assert.equal(await page.locator('main .connection-recovery').count(),0);
    await page.locator('#messages').getByText('恢复后收到原轮次的回复',{exact:true}).waitFor();
    // Cross the first backoff deadline to catch a stale retry after the queued resume.
    await page.waitForTimeout(1200);
    assert.equal(await draft.inputValue(),'切网时仍在编辑');
    assert.equal(await page.locator('.rail-profile[data-offline]').count(),0);
    assert.equal(resumeCount,2);
    const reconnectEvents=await page.evaluate(async()=>{
      let count=0;
      const onReconnect=()=>{count++};
      window.addEventListener('receiver-reconnected',onReconnect);
      try{await window.receiverNetworkResumed!();return count}
      finally{window.removeEventListener('receiver-reconnected',onReconnect)}
    });
    assert.equal(resumeCount,3);
    assert.equal(reconnectEvents,0);
    assert.equal(submitCount,1);
  } finally { await browser.close() }
});

test('reopening after an offline directory lookup restores the saved device when it returns', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(id => localStorage.setItem('codex-receiver-selected-device', id), host.deviceId);
    let online = false;
    await page.route(origin + '/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/devices') return route.fulfill({path:resolve(assets,'devices.html')});
      if (path === '/api/devices') return route.fulfill({json:{devices:[{...host,online}]}});
      if (path === base + '/') return route.fulfill({contentType:'text/html',body:'工作台'});
      return route.abort();
    });
    await page.goto(origin + '/devices#directory-unavailable');
    await page.getByText(/正在等待上次使用的主机上线/).waitFor();
    online = true;
    await page.evaluate(() => window.receiverNetworkResumed!());
    await page.waitForURL(origin + base + '/');
  } finally { await browser.close() }
});
