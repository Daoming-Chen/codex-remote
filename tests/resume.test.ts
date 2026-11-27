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

for(const side of [false,true])test('streamed Markdown finalizes TeX and preserves literal code, side='+side,async()=>{
  const browser=await launch();
  try{
    const page=await browser.newPage({serviceWorkers:'block'});
    const thread='00000000-0000-4000-8000-000000000024',job='00000000-0000-4000-8000-000000000025';
    await page.addInitScript(({thread,job,scope,side})=>{
      const chat={id:thread,thread,pending:job,title:'公式',draft:'',files:[],messages:[{role:'user',text:'解释公式'}]};
      const tab='receiver:side-chat';
      const owner=side?{...chat,id:'parent',thread:'00000000-0000-4000-8000-000000000020',pending:null,
        sideChats:[chat],workView:{ids:[tab],active:tab}}:chat;
      localStorage.setItem('receiver:'+scope+':tim-ser-chats-v2',JSON.stringify({active:owner.id,chats:[owner]}))
    },{thread,job,scope:host.scope,side});
    const start='行内 $x^2$ 和 \\(a_i\\)。\n\n$$\n\\frac{1}{';
    const answer=start+'2}\n$$\n\n\\[\\sqrt{x}\\]\n\n`$code$`，价格 $5 和 $10。\n\n```math\nx^3\n```';
    const longEquation=Array.from({length:80},(_,i)=>'x_{'+i+'}').join('+')+'=z';
    const mixed=String.raw`结论：\[a^2+b^2=c^2\]，以及 $$E=mc^2$$。

换行也属于同一个公式：\[a+
b\]，以及 $$c+
d$$。`;
    const boundary='\\[a+b\\] 是第一条。\n\n这段说明应该单独显示。\n\n\\[\nc+d\n\\]';
    const text=answer+'\n\n'+mixed+'\n\n'+boundary+'\n\n$$\n'+longEquation+'\n$$\n\n```math\n\\frac{1}{';
    let complete=false;
    const template=await readFile(resolve(assets,'index.html'),'utf8');
    await page.route(origin+'/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(template,{
        deviceName:host.name,scope:host.scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path.startsWith(base+'/api/turn/'+job)){
        const snapshot={id:job,thread,turn:'math-turn',status:complete?'done':'running',progress:{message:text},answer:complete?text:''};
        return path.endsWith('/events')?route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(snapshot)+'\n\n'}):route.fulfill({json:snapshot})
      }
      if(path.includes('/api/'))return route.fulfill({json:{items:[],models:[],projects:[]}});
      return route.fulfill({path:resolve(assets,path.slice(1))})
    });
    await page.goto(origin+base+'/');
    const messages=page.locator(side?'.side-chat-history':'#messages');
    await messages.locator('.katex').nth(4).waitFor();
    assert.equal(await messages.locator('.katex-error').count(),0);
    complete=true;
    await messages.locator('.answer .katex-error').waitFor();
    assert.equal(await messages.locator('.katex').count(),12);
    assert.equal(await messages.locator('.katex-display').count(),5);
    assert.equal(await messages.getByText('这段说明应该单独显示。',{exact:true}).count(),1);
    assert.equal(await messages.locator('code').innerText(),'$code$');
    assert.match(await messages.innerText(),/价格 \$5 和 \$10/);
    assert(await page.evaluate(async()=>(await document.fonts.load('16px KaTeX_Main')).some(face=>face.status==='loaded')));
    const bounds=await messages.locator('.katex-display').last().evaluate(display=>{
      const symbols=display.querySelectorAll('.katex-html > .katex-base');
      const start=symbols[0].getBoundingClientRect().left-display.getBoundingClientRect().left;
      display.scrollLeft=display.scrollWidth;
      const end=display.getBoundingClientRect().right-symbols[symbols.length-1].getBoundingClientRect().right;
      return {start,end,scrolled:display.scrollLeft}
    });
    assert(bounds.scrolled>0&&bounds.start>=-1&&bounds.end>=-1,JSON.stringify(bounds));
    assert(await messages.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  }finally{await browser.close()}
});

test('sending from older side chat history reveals the submitted question',async()=>{
  const browser=await launch();
  try{
    const page=await browser.newPage({serviceWorkers:'block'});
    const parent='00000000-0000-4000-8000-000000000030',thread='00000000-0000-4000-8000-000000000031';
    await page.addInitScript(({parent,thread,scope})=>{
      const messages=Array.from({length:50},(_,i)=>({role:'assistant',text:'历史回复 '+i}));
      messages.unshift({role:'user',text:Array.from({length:30},(_,i)=>'问题第 '+i+' 行').join('\n')});
      const side={id:thread,thread,messages,draft:'',files:[]};
      const tab='receiver:side-chat';
      const owner={id:parent,thread:parent,messages:[],sideChats:[side],workView:{ids:[tab],active:tab}};
      localStorage.setItem('receiver:'+scope+':tim-ser-chats-v2',JSON.stringify({active:parent,chats:[owner]}))
    },{parent,thread,scope:host.scope});
    const template=await readFile(resolve(assets,'index.html'),'utf8');
    await page.route(origin+'/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(template,{
        deviceName:host.name,scope:host.scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path.includes('/api/'))return route.fulfill({json:{items:[],models:[],projects:[],messages:[]}});
      return route.fulfill({path:resolve(assets,path.slice(1))})
    });
    await page.goto(origin+base+'/');
    const history=page.locator('.side-chat-history');
    await history.getByText('历史回复 49',{exact:true}).waitFor();
    const longQuestion=history.locator('.side-question').first();
    const viewport=longQuestion.locator('.user-text-viewport');
    const more=longQuestion.getByRole('button',{name:'显示更多'});
    await more.waitFor();
    assert(await viewport.evaluate(el=>el.clientHeight<el.scrollHeight));
    await more.click();
    assert(await viewport.evaluate(el=>el.clientHeight===el.scrollHeight));
    await longQuestion.getByRole('button',{name:'收起'}).click();
    assert(await viewport.evaluate(el=>el.clientHeight<el.scrollHeight));
    await page.locator('.side-chat textarea').fill('从历史位置发送');
    assert(await history.evaluate(el=>{el.scrollTop=0;return el.scrollHeight-el.clientHeight>500}));
    await page.locator('.side-chat').getByRole('button',{name:'发送',exact:true}).click();
    const question=history.getByText('从历史位置发送',{exact:true});
    await question.waitFor();
    assert(await question.evaluate(el=>{
      const bubble=el.getBoundingClientRect(),pane=el.closest('.side-chat-history')!.getBoundingClientRect();
      return bubble.top>=pane.top-1&&bubble.bottom<=pane.bottom+1
    }));
  }finally{await browser.close()}
});

test('a dropped shared turn resumes without a reconnect toast over the chat',async()=>{
  const browser=await launch();
  try{
    const page=await browser.newPage({serviceWorkers:'block',viewport:{width:820,height:920}});
    const thread='00000000-0000-4000-8000-000000000019';
    const messages=[{role:'user',text:'主机上的任务',turn:'active-turn'}];
    await page.addInitScript(({thread,messages,scope})=>{
      const chat={id:thread,thread,title:'共享聊天',activeTurn:'active-turn',messages,draft:'尚未发送',files:[]};
      localStorage.setItem('receiver:'+scope+':tim-ser-chats-v2',JSON.stringify({active:thread,chats:[chat]}));
    },{thread,messages,scope:host.scope});
    let reads=0,probes=0;
    const template=await readFile(resolve(assets,'index.html'),'utf8');
    await page.route(origin+'/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(template,{
        deviceName:host.name,scope:host.scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path===base+'/api/threads'&&route.request().postDataJSON().thread===thread){
        if(++reads===1)return route.abort('connectionreset');
        return route.fulfill({json:{thread,messages:[...messages,{role:'assistant',text:'主机回复已完成',turn:'active-turn'}]}});
      }
      if(path===base+'/api/resume'){probes++;return route.fulfill({json:{connected:true,reused:true}})}
      if(path.includes('/api/'))return route.fulfill({json:{items:[],projects:[],models:[]}});
      return route.fulfill({path:resolve(assets,path.slice(1))});
    });
    await page.goto(origin+base+'/');
    await page.locator('#messages').getByText('主机回复已完成',{exact:true}).waitFor({timeout:15000});
    assert.doesNotMatch(await page.locator('#toast').textContent()||'',/连接中断|重新连接/);
    assert.equal(await page.locator('#prompt').inputValue(),'尚未发送');
    assert.equal(probes,1);
  }finally{await browser.close()}
});

test('foreground recovery replaces a pending history read without reporting a host failure',async()=>{
  const browser=await launch();
  try{
    const page=await browser.newPage({serviceWorkers:'block'});
    const thread='00000000-0000-4000-8000-000000000141';
    await page.addInitScript(({thread,scope})=>{
      const chat={id:thread,thread,title:'历史',messages:[{role:'assistant',text:'已缓存'}],draft:'',files:[]};
      localStorage.setItem('receiver:'+scope+':tim-ser-chats-v2',JSON.stringify({active:thread,chats:[chat]}));
    },{thread,scope:host.scope});
    const template=await readFile(resolve(assets,'index.html'),'utf8');
    let reads=0;
    await page.route(origin+'/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(template,{
        deviceName:host.name,scope:host.scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path===base+'/api/threads'&&route.request().postDataJSON()?.thread===thread){
        if(++reads===1)return;
        return route.fulfill({json:{thread,messages:[{role:'assistant',text:'来自主机的新记录'}]}});
      }
      if(path===base+'/api/resume')return route.fulfill({json:{connected:true,reused:true}});
      if(path.includes('/api/'))return route.fulfill({json:{items:[],projects:[],models:[]}});
      return route.fulfill({path:resolve(assets,path.slice(1))});
    });
    const reading=page.waitForRequest(req=>req.url()===origin+base+'/api/threads'&&req.postDataJSON()?.thread===thread);
    await page.goto(origin+base+'/');
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await reading;
    await page.evaluate(()=>window.receiverNetworkResumed!());
    await page.locator('#messages').getByText('来自主机的新记录',{exact:true}).waitFor({timeout:6000});
    assert.doesNotMatch(await page.locator('#toast').textContent()||'',/主机刷新失败/);
  }finally{await browser.close()}
});

for(const [side,stop] of [[false,false],[true,false],[true,true]])test('cold reopening a reconnecting turn preserves received text, side='+side+', stop='+stop,async()=>{
  const browser=await launch();
  try{
    const page=await browser.newPage({serviceWorkers:'block'});
    const thread='00000000-0000-4000-8000-000000000021',job='00000000-0000-4000-8000-000000000022';
    await page.addInitScript(({thread,job,scope,side})=>{
      const chat={id:thread,thread,pending:job,title:'原聊天',messages:[
        {role:'user',turn:'cached-question-turn',text:'已缓存的问题'},
        {role:'assistant',turn:'partial-turn',text:'缓存片'},
        {role:'user',text:'原问题'}],draft:'',files:[]};
      const key='receiver:'+scope+':tim-ser-chats-v2';
      if(localStorage.getItem(key))return;
      const tab='receiver:side-chat';
      const owner=side?{...chat,id:'parent',thread:'00000000-0000-4000-8000-000000000020',pending:null,
        sideChats:[chat],workView:{ids:[tab],active:tab}}:chat;
      localStorage.setItem(key,JSON.stringify({active:owner.id,chats:[owner]}));
    },{thread,job,scope:host.scope,side});
    const template=await readFile(resolve(assets,'index.html'),'utf8');
    let resumed=false;
    let externalDone=false;
    let connectionReplaced=false;
    let sharedRequest='',sharedAttempts=0;
    let parentReads=0,branchReads=0;
    let holdUpdates=false,releaseUpdates!:()=>void;
    const networkRestored=new Promise<void>(resolve=>{releaseUpdates=resolve});
    await page.route(origin+'/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(template,{
        deviceName:host.name,scope:host.scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path===base+'/api/interrupt/'+job && stop){
        assert.equal(route.request().method(),'POST');
        resumed=true;releaseUpdates();
        return route.fulfill({status:202,json:{id:job}})
      }
      if(stop&&resumed&&path===base+'/api/thread-interrupt/'+thread+'/live-turn'){
        assert.equal(route.request().method(),'POST');
        externalDone=true;return route.fulfill({status:202,json:{}})
      }
      if(stop&&resumed&&path===base+'/api/thread-steer/'+thread){
        const payload=route.request().postDataJSON();
        assert.equal(payload.turn,'live-turn');assert.equal(payload.text,'侧聊补充');
        if(!sharedAttempts++) {
          sharedRequest=payload.request;
          return route.fulfill({status:503,json:{error:'主机暂时未确认'}})
        }
        assert.equal(payload.request,sharedRequest);
        return route.fulfill({json:{turn:'live-turn'}})
      }
      if(stop&&resumed&&path===base+'/api/threads'){
        const id=route.request().postDataJSON().thread;
        if(id){
          if(id===thread)branchReads++;else parentReads++;
          const inherited={turn:'parent-turn',role:'user',text:'主聊天上下文'};
          const messages=id===thread?[inherited,{turn:'cached-question-turn',role:'user',text:'已缓存的问题'},
            {turn:'cached-question-turn',role:'assistant',text:'停止前的文字'},
            {turn:'cached-question-turn',role:'status',text:'',status:'interrupted',turnDurationMs:6000},
            {turn:'partial-turn',role:'assistant',text:'缓存片段的后续'},
            {turn:'partial-turn',role:'assistant',text:'侧聊第二段'},
            {turn:'original-turn',role:'user',text:'原问题'},
            {turn:'other-client-turn',role:'assistant',text:'来自另一台设备的回复'}]:[inherited];
          if(id===thread&&externalDone)messages.push({turn:'live-turn',role:'assistant',text:'跨端最终回复'});
          return route.fulfill({json:{thread:id,messages,activeTurn:id===thread&&!externalDone?'live-turn':null}})
        }
      }
      if(stop&&path===base+'/api/thread-events/'+thread){
        const text=(delta:string|null)=>'event: text\ndata: '+JSON.stringify(['live-turn','live-item',delta])+'\n\n';
        return route.fulfill({contentType:'text/event-stream',body:externalDone?'data: CHANGED\n\n':
          'retry: '+(connectionReplaced?200:60000)+'\n\n'+text(null)+text('跨端')+text('流式首段')+
          (connectionReplaced?text('及续段'):'')})
      }
      if(path.startsWith(base+'/api/turn/'+job)){
        if(holdUpdates)await networkRestored;
        const snapshot={id:job,thread,turn:'original-turn',status:resumed?(stop?'interrupted':'done'):'waiting',reconnecting:!resumed,
          turnDurationMs:resumed?12000:undefined,
          parts:['已收到的第一段'],progress:{message:'已收到的第二段',items:[{id:'check',type:'commandExecution',
            command:'pwd',status:resumed?'completed':'inProgress',output:resumed?'remote-dir':'remote-'}]},answer:'已收到的第一段\n\n已收到的第二段。'};
        return path.endsWith('/events')?route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(snapshot)+'\n\n'}):route.fulfill({json:snapshot});
      }
      if(path.includes('/api/'))return route.fulfill({json:{items:[],models:[],projects:[]}});
      return route.fulfill({path:resolve(assets,path.slice(1))});
    });
    await page.goto(origin+base+'/');
    const messages=page.locator(side?'.side-chat-history':'#messages');
    await messages.getByText('已收到的第二段',{exact:true}).waitFor({timeout:4000});
    assert.equal(await messages.getByText('已收到的第一段',{exact:true}).count(),1);
    assert.doesNotMatch(await messages.innerText(),/正在重新连接/);
    if(side){
      const timeline=messages.locator('.timeline');
      await timeline.locator('summary').click();
      assert.equal(await timeline.locator('.command-output').innerText(),'remote-');
      assert.equal(await timeline.getByText('执行中',{exact:true}).count(),1)
    }
    holdUpdates=true;
    await page.reload({waitUntil:'domcontentloaded'});
    await messages.getByText('已收到的第二段',{exact:true}).waitFor({timeout:4000});
    if(stop)await page.locator('.side-chat').getByRole('button',{name:'停止',exact:true}).click();
    else{resumed=true;releaseUpdates()}
    await messages.getByText('已收到的第二段。',{exact:true}).waitFor();
    assert.equal(await messages.getByText('已收到的第一段',{exact:true}).count(),1);
    if(stop){
      await messages.getByText('你已停止，已用时 12秒',{exact:true}).waitFor();
      await page.reload();
      await messages.getByText('你已停止，已用时 12秒',{exact:true}).waitFor();
      await messages.getByText('来自另一台设备的回复',{exact:true}).waitFor();
      await messages.getByText('停止前的文字',{exact:true}).waitFor();
      assert.equal(await messages.getByText('缓存片段的后续',{exact:true}).count(),1);
      assert.equal(await messages.getByText('缓存片',{exact:true}).count(),0);
      assert.equal(await messages.getByText('侧聊第二段',{exact:true}).count(),1);
      assert.equal(await messages.getByText('你已停止，已用时 6秒',{exact:true}).count(),1);
      assert.equal(await messages.getByText('已缓存的问题',{exact:true}).count(),1);
      await messages.getByText('跨端流式首段',{exact:true}).waitFor();
      let checks=0;
      await page.route(origin+base+'/api/resume',route=>{
        connectionReplaced=++checks>1;
        return route.fulfill({json:{connected:true,reused:true,connectionId:connectionReplaced?'new':'old'}})
      });
      await page.evaluate(()=>window.receiverNetworkResumed?.());
      await page.evaluate(()=>window.receiverNetworkResumed?.());
      await messages.getByText('跨端流式首段及续段',{exact:true}).waitFor({timeout:4000});
      const beforeFinal={parentReads,branchReads};
      const panel=page.locator('.side-chat'),field=panel.locator('textarea');
      await field.fill('侧聊补充');
      const supplement=panel.getByRole('button',{name:'补充要求',exact:true});
      await supplement.click();
      await page.getByText('主机暂时未确认',{exact:true}).waitFor();
      assert.equal(await field.inputValue(),'侧聊补充');
      await supplement.click();await supplement.waitFor({state:'hidden'});
      assert.equal(await field.inputValue(),'');assert.equal(sharedAttempts,2);
      await field.fill('保留侧聊草稿');
      await field.press('Control+Enter');
      assert.equal(externalDone,false);
      await panel.getByRole('button',{name:'停止',exact:true}).click();
      assert.equal(await field.inputValue(),'保留侧聊草稿');
      await messages.getByText('跨端最终回复',{exact:true}).waitFor();
      assert(branchReads>beforeFinal.branchReads);
      assert.equal(parentReads,beforeFinal.parentReads);
      assert.equal(await messages.getByText('跨端流式首段',{exact:true}).count(),0);
      assert.equal(await messages.getByText('主聊天上下文',{exact:true}).count(),0);
      assert.equal(await messages.getByText('原问题',{exact:true}).count(),1);
      await page.locator('.side-chat').getByRole('button',{name:'发送',exact:true}).waitFor()
    }
    if(side){
      const timeline=messages.locator('.timeline');
      assert.equal(await timeline.count(),1);
      if(!await timeline.evaluate(el=>(el as HTMLDetailsElement).open))await timeline.locator('summary').click();
      assert.equal(await timeline.locator('.command-output').innerText(),'remote-dir');
      assert.equal(await timeline.getByText('已完成',{exact:true}).count(),1)
    }
  }finally{await browser.close()}
});

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

test('a timed-out device lookup starts fresh discovery without another Android network event', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({serviceWorkers:'block'});
    await page.clock.install();
    let reads=0;
    await page.route(origin+'/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/devices')return route.fulfill({path:resolve(assets,'devices.html')});
      if(path==='/api/devices'){
        if(++reads===1)return;
        assert.equal(route.request().headers()['x-receiver-network-resumed'],'1');
        return route.fulfill({json:{devices:[host]}});
      }
      return route.abort();
    });
    const first=page.waitForRequest(req=>req.url().endsWith('/api/devices'));
    await page.goto(origin+'/devices');
    const stale=await first;
    const aborted=page.waitForEvent('requestfailed',req=>req===stale);
    await page.clock.fastForward(25001);
    await aborted;
    await page.getByRole('button',{name:'刷新设备',disabled:false}).waitFor();
    await page.clock.fastForward(15001);
    await page.getByRole('button',{name:/恢复测试主机.*在线/}).waitFor();
    assert.equal(reads,2);
  } finally { await browser.close() }
});

for(const superseded of [false,true])test('network recovery restores the same turn and draft, superseded='+superseded, async () => {
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
    if(superseded){
      await page.evaluate(() => { void window.receiverNetworkResumed!() });
    }else{
      failFirst();
      await page.locator('.rail-profile[data-offline]').waitFor()
    }
    assert.equal(await page.locator('main .connection-recovery').count(),0);
    await page.locator('#messages').getByText('恢复后收到原轮次的回复',{exact:true}).waitFor();
    failFirst();
    // A late failure must not mark the restored connection offline or start another retry.
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
    let directoryAvailable = false;
    await page.route(origin + '/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/devices') return route.fulfill({path:resolve(assets,'devices.html')});
      if (path === '/api/devices') return directoryAvailable
        ? route.fulfill({json:{devices:[{...host,online}]}})
        : route.fulfill({status:503,json:{code:'CONNECTION_FAILED',error:'无法连接 Remote 服务。'}});
      if (path === base + '/') return route.fulfill({contentType:'text/html',body:'工作台'});
      return route.abort();
    });
    await page.goto(origin + '/devices#directory-unavailable');
    await page.getByText(/无法连接 Remote 服务/).waitFor();
    directoryAvailable = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByText(/正在等待上次使用的主机上线/).waitFor({timeout:4000});
    online = true;
    await page.evaluate(() => window.receiverNetworkResumed!());
    await page.waitForURL(origin + base + '/');
  } finally { await browser.close() }
});
