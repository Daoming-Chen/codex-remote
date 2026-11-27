import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {chromium} from 'playwright-core';
import {WebSocketServer} from '../web/vendor/node_modules/ws/wrapper.mjs';
import {HostPluginRuntime, ClientModeRuntime, resolveConfig} from '../web/vendor/remote.mjs';
import {webPreviewAccess} from '../web/transport.mjs';

test('preview serves a host app and its WebSocket on an isolated browser origin', async t=>{
  const app=createServer((req,res)=>{
    if(req.url==='/app/script.js'){
      res.setHeader('content-type','text/javascript');
      res.end("const socket=new WebSocket('/events'); socket.onopen=()=>socket.send('ping'); socket.onmessage=e=>document.body.dataset.reply=e.data;");
    }else if(req.url==='/app/styles/page.css'){
      res.setHeader('content-type','text/css');
      res.end('body { color: rgb(12, 34, 56) }');
    }else if(req.url==='/app/details?item=2'){
      res.setHeader('content-type','text/html');
      res.end('<h1>Item details</h1>');
    }else if(req.url==='/app/?v=1'){
      res.setHeader('content-type','text/html');
      res.end('<link rel="stylesheet" href="styles/page.css"><body>Host app<a href="details?item=2">Details</a><script src="./script.js"></script></body>');
    }else{res.writeHead(404);res.end()}
  });
  const ws=new WebSocketServer({server:app,path:'/events'});
  ws.on('connection',socket=>socket.on('message',value=>socket.send('received '+value)));
  app.listen(0,'127.0.0.1');
  await once(app,'listening');
  const port=app.address().port;
  t.after(()=>{ws.close();app.closeAllConnections();app.close()});

  // Exercise the shipped host/client preview implementations, replacing only
  // the authenticated peer link with in-process RPC delivery.
  const hostConfig={loopbackPorts:[port],loopbackHosts:new Set()};
  const host=HostPluginRuntime.prototype.createLoopbackHost.call(hostConfig);
  t.after(()=>host.closeAll());
  const client={rpc(method,args){assert.equal(method,'loopback.call');return host.call(args)}};
  const runtime=new ClientModeRuntime(resolveConfig({}),{}, {}, {invoke(){throw Error('unexpected local call')}}, {});
  runtime.connected={client};
  t.after(()=>runtime.closePreview());
  const preview=webPreviewAccess(runtime,client);
  assert.deepEqual(await preview.listPreviewPorts(),{ports:[port]});
  await assert.rejects(preview.openPreviewPort(port===4000?4001:4000),{code:'LOOPBACK_PORT_DENIED'});
  const {url}=await preview.openPreviewPort(port);
  assert.match(url,/^http:\/\/dsh-[a-f0-9]{48}\.localhost:\d+\/$/);
  assert.equal((await preview.openPreviewPort(port)).url,url);
  // Guessing the listener's port on the receiver origin cannot open the app.
  const guessed=new URL(url);
  guessed.hostname='127.0.0.1';
  assert.equal((await fetch(guessed)).status,403);

  const browser=await chromium.launch(process.env.CHROMIUM_PATH
    ? {executablePath:process.env.CHROMIUM_PATH} : {channel:'msedge'});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.goto(new URL('app/?v=1',url).href);
  await page.waitForSelector('[data-reply="received ping"]',{timeout:10000});
  assert.equal(await page.locator('body').evaluate(body=>getComputedStyle(body).color),'rgb(12, 34, 56)');
  await page.getByRole('link',{name:'Details'}).click();
  assert.equal(await page.getByRole('heading').textContent(),'Item details');
  assert.equal(page.url(),new URL('app/details?item=2',url).href);
  HostPluginRuntime.prototype.setLoopbackPorts.call(hostConfig,[]);
  assert.deepEqual(await preview.listPreviewPorts(),{ports:[]});
  assert.equal((await page.reload()).status(),502);
});
