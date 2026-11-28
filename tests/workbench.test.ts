import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import { renderWorkbenchPage } from '../apps/receiver/src/workbench-page.mts';
import { searchDirectoryFiles } from '../apps/workbench/src/PanelSearch.ts';
import {fileChunks, fileMime, filePreview, filePreviewLimit} from '../apps/receiver/src/project-file-content.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Route } from 'playwright-core';

test('tablet opens independent Codex and Antigravity sessions in parallel',async()=>{
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'msedge'});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:800},hasTouch:true,serviceWorkers:'block'});
    page.setDefaultTimeout(8000);
    const assets=fileURLToPath(new URL('../web/',import.meta.url));
    const origin='http://localhost:49026',scope='b'.repeat(64),base='/devices/'+scope;
    const codex={thread:'00000000-0000-4000-8000-000000000029',cwd:'/project',title:'Existing Codex task',updated:1700000000};
    let codexJob='',codexReads=0,agyJob='',agyFinished=false,followUp='',followUpAttached=false,forks=0;
    let approval:unknown;
    await page.addInitScript(scope=>{
      const chat={id:'main',harness:'antigravity',agySession:'main-agy',title:'Main Antigravity task',cwd:'/project',
        draft:'',files:[],messages:[{role:'assistant',text:'Antigravity main history'}]};
      localStorage.setItem('receiver:'+scope+':tim-ser-chats-v2',JSON.stringify({active:chat.id,chats:[chat]}));
    },scope);
    await page.route(origin+'/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(await readFile(join(assets,'index.html'),'utf8'),
        {deviceName:'主机',scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path.endsWith('/antigravity/availability'))return route.fulfill({json:{available:true}});
      if(path.endsWith('/antigravity/workspaces'))return route.fulfill({json:[{path:'/project'}]});
      if(path.endsWith('/antigravity/history'))return route.fulfill({json:{messages:[{role:'assistant',text:'Antigravity main history'}]}});
      if(path.endsWith('/antigravity/session'))return route.fulfill({json:{sessionId:'parallel-agy'}});
      if(path.endsWith('/antigravity/options'))return route.fulfill({json:{
        modes:{currentModeId:'ask',availableModes:[{id:'ask',name:'审批操作'}]},
        models:{groups:[{models:[{id:'long',name:'Antigravity model with a deliberately long name '.repeat(4)}]}]}
      }});
      if(path.endsWith('/antigravity/submit')){
        const sent=route.request().postDataJSON();
        assert.equal(sent.cwd,'/project');assert.equal(sent.mode,'ask');assert.equal(sent.model,'long');
        if(sent.prompt.startsWith('Split follow-up')){
          assert.equal(sent.session,'parallel-agy');
          if(sent.queue){assert.equal(sent.afterJobId,agyJob);followUp=sent.id}
          else{assert.equal(sent.id,followUp);followUpAttached=true}
          return route.fulfill({json:{id:sent.id,queued:sent.queue}})
        }
        assert.equal(sent.prompt,'Draft preserved');agyJob=sent.id;
        return route.fulfill({json:{id:agyJob}})
      }
      if(path.endsWith('/antigravity/status')){
        if(route.request().postDataJSON().id===followUp)return route.fulfill({json:{session:'parallel-agy',status:'done',text:'Split follow-up reply'}});
        return route.fulfill({json:{
          session:'parallel-agy',status:agyFinished?'done':'running',text:agyFinished?'Antigravity final reply':'Antigravity partial reply'
        }})
      }
      if(path.endsWith('/threads')){
        const sent=route.request().postDataJSON();
        if(sent.thread)return route.fulfill({json:{...codex,messages:[
          {role:'assistant',text:'Existing Codex history'},...(approval?[{role:'assistant',text:'Codex final reply',turn:'codex-turn'}]:[])
        ]}});
        return route.fulfill({json:{items:[codex],projects:[{id:'project-id',name:'Project',roots:['/project']}]}})
      }
      if(path.endsWith('/thread-fork')){forks++;return route.fulfill({status:500,json:{error:'Workspace sessions must use standalone turns'}})}
      if(path.endsWith('/api/turn')){
        const sent=route.request().postDataJSON();codexJob=sent.id;
        assert.equal(sent.expectedThread,codex.thread);assert.equal(sent.cwd,'/project');assert.equal(sent.prompt,'Continue Codex');
        return route.fulfill({json:{id:codexJob}})
      }
      if(codexJob&&path.includes('/api/turn/'+codexJob)){
        const status=approval?'done':++codexReads===1?'running':'waiting';
        const snapshot={id:codexJob,thread:codex.thread,turn:'codex-turn',status,
          progress:{message:'Codex partial reply',started:true},answer:'Codex final reply',
          inputRequests:{review:[{id:'decision',question:'Approve Codex step?',commandReview:{command:'git status'},options:[{label:'允许一次'}]}]}};
        return path.endsWith('/events')?route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(snapshot)+'\n\n'}):route.fulfill({json:snapshot})
      }
      if(codexJob&&path.endsWith('/api/answer/'+codexJob)){
        approval=route.request().postDataJSON();return route.fulfill({json:{ok:true}})
      }
      if(path.includes('/api/'))return route.fulfill({json:{items:[],projects:[],models:[],native:false}});
      return route.fulfill({path:join(assets,path)})
    });
    await page.goto(origin+base+'/');
    const main=page.locator('#messages'),split=page.locator('#workbench .split-session'),dialog=page.locator('#dialog');
    await main.getByText('Antigravity main history').waitFor();
    const remoteRow=page.locator('.history-row').filter({hasText:codex.title});
    const session=remoteRow.getByRole('button',{name:/Existing Codex task/});
    await session.waitFor();
    assert.equal(await remoteRow.getByRole('button').count(),1);
    await session.click({button:'right'});
    await dialog.getByRole('button',{name:'在右侧面板打开'}).waitFor();
    await page.keyboard.press('Escape');
    await session.press('Shift+F10');
    await dialog.getByRole('button',{name:'在右侧面板打开'}).waitFor();
    await page.keyboard.press('Escape');
    const bounds=await session.boundingBox();
    assert(bounds);
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:bounds.x+10,y:bounds.y+bounds.height/2}]});
    await dialog.getByRole('button',{name:'在右侧面板打开'}).waitFor();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert(await dialog.isVisible());
    await cdp.detach();
    await dialog.getByRole('button',{name:'在右侧面板打开'}).click();
    await split.getByText('Existing Codex history').waitFor();
    assert(await main.getByText('Antigravity main history').isVisible());
    assert((await split.boundingBox())!.x>(await main.boundingBox())!.x);
    await split.locator('textarea').fill('Continue Codex');
    await split.getByRole('button',{name:'发送',exact:true}).click();
    await split.getByText('Codex partial reply').waitFor();
    await split.getByRole('radio',{name:'允许一次'}).check();
    assert.equal(await page.locator('#pending-questions').getByText('Approve Codex step?').count(),0);
    assert(await page.locator('#workspace-switcher').isHidden());
    await split.getByRole('button',{name:'提交审批决定'}).click();
    await split.getByText('Codex final reply').waitFor();
    assert.deepEqual(approval,{turn:'codex-turn',token:'review',answers:{decision:{answers:['允许一次']}}});

    await page.keyboard.press('Control+k');
    await page.getByRole('textbox',{name:'查找命令'}).fill('新建并行会话');
    await dialog.getByRole('button',{name:'新建并行会话'}).click();
    const field=split.locator('textarea'),agent=split.locator('.side-agent-picker');
    assert(await field.evaluate(node=>node===document.activeElement));
    assert.match(await agent.innerText(),/Codex/);
    await field.fill('Draft preserved');
    await agent.click();
    await dialog.getByRole('menuitemradio',{name:'Antigravity',exact:true}).click();
    assert.equal(await field.inputValue(),'Draft preserved');
    await split.locator('.side-permission-picker').click();
    await dialog.getByRole('button',{name:'审批操作'}).click();
    await split.locator('.side-model-picker').click();
    await dialog.getByRole('menuitemradio',{name:/Antigravity model/}).click();
    assert(await split.locator('.side-chat-actions').evaluate(actions=>actions.scrollWidth<=actions.clientWidth));
    await split.getByRole('button',{name:'发送',exact:true}).click();
    await split.getByText('Antigravity partial reply').waitFor();
    assert.equal(await agent.getAttribute('data-locked'),'true');
    assert(await agent.isDisabled());
    await split.getByRole('button',{name:'停止',exact:true}).waitFor();
    await field.fill('Split follow-up '+ 'x'.repeat(220));
    assert(await split.getByRole('button',{name:'排队发送',exact:true}).isEnabled());
    await Promise.all([page.waitForResponse(response=>response.url().endsWith('/antigravity/submit')&&response.request().postDataJSON().queue===true),field.press('Enter')]);
    const queue=split.locator('.split-agy-queue');
    await queue.getByText('待发送 · 1').waitFor();
    assert.equal(await field.inputValue(),'');
    assert(await queue.evaluate(bar=>bar.scrollWidth<=bar.clientWidth&&bar.querySelector('.agy-queue-preview')!.scrollWidth>bar.querySelector('.agy-queue-preview')!.clientWidth));
    assert.equal(followUpAttached,false);
    agyFinished=true;
    await split.getByText('Antigravity final reply').waitFor();
    await split.getByText('Split follow-up reply').waitFor();
    assert(await queue.isHidden());assert(followUpAttached);
    await page.locator('#work-tabs .work-tab').filter({hasText:codex.title}).click();
    await split.getByRole('button',{name:'切到主视图'}).click();
    await main.getByText('Codex final reply').waitFor();
    assert(await split.isHidden());
    assert.equal(forks,0)
  }finally{await browser.close()}
});

test('mobile Antigravity composer queues, edits, removes and sends follow-ups',async()=>{
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'msedge'});
  try{
    const page=await browser.newPage({viewport:{width:393,height:795},hasTouch:true,serviceWorkers:'block'});
    page.setDefaultTimeout(8000);
    const assets=fileURLToPath(new URL('../web/',import.meta.url));
    const origin='http://localhost:49028',scope='d'.repeat(64),base='/devices/'+scope;
    const session='mobile-agy',first=crypto.randomUUID();
    const jobs=new Map<string,{status:string;text:string}>([[first,{status:'running',text:'First turn running'}]]);
    const submissions:{id:string;afterJobId?:string;queue?:boolean;prompt:string}[]=[];
    const cancelled:string[]=[],interrupts:{id:string;nextId:string}[]=[];
    await page.addInitScript(({scope,first,session})=>{
      const chat={id:'main',harness:'antigravity',agySession:session,title:'Queue test',cwd:'/project',pending:first,
        draft:'',files:[],messages:[{role:'user',text:'First question',submissionId:first}]};
      localStorage.setItem('receiver:'+scope+':tim-ser-chats-v2',JSON.stringify({active:chat.id,chats:[chat]}));
    },{scope,first,session});
    await page.route(origin+'/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(await readFile(join(assets,'index.html'),'utf8'),
        {deviceName:'主机',scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path.endsWith('/antigravity/submit')){
        const body=route.request().postDataJSON();submissions.push(body);
        assert.equal(body.session,session);
        if(!jobs.has(body.id))jobs.set(body.id,{status:body.queue?'queued':'running',text:''});
        return route.fulfill({json:{id:body.id}})
      }
      if(path.endsWith('/antigravity/status'))return route.fulfill({json:{session,...jobs.get(route.request().postDataJSON().id)}});
      if(path.endsWith('/antigravity/cancel-queued')){
        const {id}=route.request().postDataJSON();cancelled.push(id);jobs.set(id,{status:'cancelled',text:''});
        return route.fulfill({json:{ok:true}})
      }
      if(path.endsWith('/antigravity/interrupt-next')){
        const body=route.request().postDataJSON();interrupts.push(body);
        jobs.set(body.id,{status:'stopped',text:'Second turn interrupted'});
        jobs.set(body.nextId,{status:'done',text:'Promoted follow-up reply'});
        return route.fulfill({json:{ok:true}})
      }
      if(path.endsWith('/antigravity/availability'))return route.fulfill({json:{available:true}});
      if(path.endsWith('/antigravity/workspaces'))return route.fulfill({json:[{path:'/project'}]});
      if(path.includes('/api/'))return route.fulfill({json:{items:[],projects:[],models:[]}});
      return route.fulfill({path:join(assets,path)})
    });
    await page.goto(origin+base+'/');
    const prompt=page.locator('#prompt'),send=page.locator('#send'),queue=page.locator('#agy-queue'),messages=page.locator('#messages');
    await page.getByRole('button',{name:'停止当前任务',exact:true}).waitFor();
    async function enqueue(text:string,afterJobId:string,enter=false){
      await prompt.fill(text);
      assert.equal(await send.getAttribute('aria-label'),'排队发送');
      assert.equal(await send.getAttribute('title'),'当前轮结束后发送下一条消息');
      const [response]=await Promise.all([
        page.waitForResponse(response=>response.url().endsWith('/antigravity/submit')&&response.request().postDataJSON().queue===true),
        enter?prompt.press('Enter'):send.tap()
      ]);
      const body=response.request().postDataJSON();
      assert.equal(body.afterJobId,afterJobId);assert.equal(await prompt.inputValue(),'');
      return body.id as string
    }
    const editId=await enqueue('Edit this',first,true);
    await prompt.fill('Existing draft');
    await Promise.all([page.waitForResponse(response=>response.url().endsWith('/antigravity/cancel-queued')),queue.getByRole('button',{name:'编辑'}).tap()]);
    assert.equal(await prompt.inputValue(),'Existing draft\nEdit this');
    assert(await prompt.evaluate(node=>node===document.activeElement));
    const removeId=await enqueue('Remove this',first);
    await Promise.all([page.waitForResponse(response=>response.url().endsWith('/antigravity/cancel-queued')),queue.getByRole('button',{name:'移除'}).tap()]);
    assert.deepEqual(cancelled,[editId,removeId]);await queue.waitFor({state:'hidden'});
    const followUp='Second question '+ 'x'.repeat(240);
    const second=await enqueue(followUp,first);
    assert(await queue.getByText('待发送 · 1').isVisible());
    assert(await queue.evaluate(bar=>bar.scrollWidth<=bar.clientWidth&&document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await messages.getByText(followUp).count(),0);
    jobs.set(first,{status:'done',text:'First turn reply'});
    jobs.set(second,{status:'running',text:'Second turn reply'});
    await messages.getByText('Second turn reply').waitFor();
    assert(submissions.some(body=>body.id===second&&!body.queue));
    const promoted=await enqueue('Send now',second);
    await queue.getByRole('button',{name:'立即发送'}).tap();
    await messages.getByText('Promoted follow-up reply').waitFor();
    assert.deepEqual(interrupts,[{id:second,nextId:promoted}]);
    await queue.waitFor({state:'hidden'});
  }finally{await browser.close()}
});

test('mobile switcher and Activity show active Codex and Antigravity sessions',async()=>{
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'msedge'});
  try{
    const page=await browser.newPage({viewport:{width:393,height:795},hasTouch:true,serviceWorkers:'block'});
    page.setDefaultTimeout(8000);
    const assets=fileURLToPath(new URL('../web/',import.meta.url));
    const origin='http://localhost:49027',scope='c'.repeat(64),base='/devices/'+scope;
    const codex={thread:'00000000-0000-4000-8000-000000000030',cwd:'/project',title:'Running Codex task',active:true,updated:1700000000};
    const agy={session:'host-agy',cwd:'/project',title:'Antigravity task with a long title on mobile',running:true,waitingOnApproval:true};
    let active=false,hostRunning=true,followUpSubmitted=false;
    await page.route(origin+'/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(await readFile(join(assets,'index.html'),'utf8'),
        {deviceName:'主机',scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path.endsWith('/threads'))return route.fulfill({json:{items:[codex],projects:[{id:'project-id',name:'Project',roots:['/project']}]}});
      if(path.endsWith('/active-threads'))return route.fulfill({json:{items:active?[codex]:[]}});
      if(path.endsWith('/antigravity/availability'))return route.fulfill({json:{available:true}});
      if(path.endsWith('/antigravity/workspaces'))return route.fulfill({json:[{path:'/project'}]});
      if(path.endsWith('/antigravity/active')){
        assert.deepEqual(route.request().postDataJSON().paths,['/project']);
        return route.fulfill({json:{items:active?[agy]:[]}})
      }
      if(path.endsWith('/antigravity/history')){
        assert.equal(route.request().postDataJSON().session,agy.session);
        return route.fulfill({json:{running:hostRunning,messages:[{role:'assistant',text:'Opened host Antigravity task'}]}})
      }
      if(path.endsWith('/antigravity/submit')){
        const body=route.request().postDataJSON();
        assert(!hostRunning);assert.equal(body.session,agy.session);assert.equal(body.prompt,'Follow up on the host turn');
        followUpSubmitted=true;return route.fulfill({json:{id:body.id}})
      }
      if(path.endsWith('/antigravity/status'))return route.fulfill({json:{session:agy.session,status:'done',text:'Host follow-up reply'}});
      if(path.includes('/api/'))return route.fulfill({json:{items:[],projects:[],models:[],native:false}});
      return route.fulfill({path:join(assets,path)})
    });
    await Promise.all([page.waitForResponse(response=>response.url().endsWith('/antigravity/active')),page.goto(origin+base+'/')]);
    const bar=page.locator('#workspace-switcher'),activity=page.locator('#activity-view'),main=page.locator('#messages');
    assert(await bar.isHidden());
    await page.getByRole('button',{name:'打开侧边栏',exact:true}).tap();
    const showActivity=page.getByRole('button',{name:'活动视图',exact:true});
    await showActivity.tap();
    await activity.getByText('当前没有活动任务。').waitFor();
    active=true;
    await activity.getByRole('button',{name:'刷新'}).tap();
    await activity.getByText('Codex · 进行中').waitFor();
    await activity.getByText('Antigravity · 等待审批').waitFor();
    await showActivity.tap();
    const waiting=page.locator('.history-row').getByRole('button',{name:/Antigravity task.*等待审批/});
    await waiting.locator('.sidebar-session-dot[data-status=waiting]').waitFor();
    assert.doesNotMatch(await waiting.innerText(),/等待审批/);
    await page.getByRole('button',{name:'收起侧边栏',exact:true}).tap();
    const pill=bar.getByRole('button',{name:/Antigravity task.*等待审批/});
    assert.equal(await pill.getAttribute('data-waiting'),'true');
    assert(await bar.evaluate(node=>node.getBoundingClientRect().right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth));
    await pill.tap();
    await main.getByText('Opened host Antigravity task').waitFor();
    assert.equal(await pill.count(),0);
    assert(await bar.getByRole('button',{name:/Running Codex task/}).isVisible());
    await page.locator('#prompt').fill('Follow up on the host turn');
    await page.getByRole('button',{name:'排队发送'}).tap();
    await page.locator('#agy-queue').getByText('待发送 · 1').waitFor();
    assert.equal(followUpSubmitted,false);
    hostRunning=false;
    await main.getByText('Host follow-up reply').waitFor();
    assert(followUpSubmitted)
  }finally{await browser.close()}
});

test('project file ranges preserve bytes, detect concurrent writes and inspect image signatures', async()=>{
  const zipHeader=Buffer.from([80,75,3,4]);
  assert.equal(fileMime('build/Android.APK',zipHeader),'application/vnd.android.package-archive');
  assert.equal(fileMime('build/archive.zip',zipHeader),'application/zip');
  const original=Buffer.alloc(filePreviewLimit+25,127);
  original.write('GIF89a');
  const info={bytes:original.length,source:'working-tree',version:'v1'};
  const read=async(offset:number,length:number)=>({...info,offset,eof:offset+length===original.length,
    data:original.subarray(offset,offset+length).toString('base64')});
  const preview=await filePreview('renamed.pdf',info,read);
  assert.equal(preview.mime,'image/gif');
  assert.equal('data' in preview,false);
  const chunks=[];
  for await(const part of fileChunks(info,read))chunks.push(part);
  assert.deepEqual(Buffer.concat(chunks),original);
  await assert.rejects(async()=>{
    for await(const part of fileChunks(info,async(offset,length)=>({...await read(offset,length),version:offset?'v2':'v1'})))assert(part.length);
  },/发生了变化/);
});

for(const android of [false,true])test('mobile workspace mixes host and migrated sessions and keeps running turns and drafts with their agent, android='+android,async()=>{
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'msedge'});
  try{
    const page=await browser.newPage({hasTouch:true,viewport:{width:393,height:795},serviceWorkers:'block'});
    page.setDefaultTimeout(6000);
    const assets=fileURLToPath(new URL('../web/',import.meta.url));
    const origin='http://localhost:49025',scope='a'.repeat(64),base='/devices/'+scope;
    const machineName='远程研发主机 Alpha '.repeat(8).trim();
    const modelName='Antigravity model with a deliberately long display name '.repeat(4).trim();
    const html=await readFile(join(assets,'index.html'),'utf8');
    const template=android?html.replace('<body>','<body class="android-receiver">'):html;
    await page.addInitScript(scope=>{
      const prefix='receiver:'+scope+':antigravity:';
      const chat={id:'local',session:'native',cwd:'/project',title:'A long conversation title on a narrow screen '.repeat(5),draft:'',images:[],messages:[]};
      for(const [key,value] of Object.entries({chats:[chat],selected:chat.id,cwd:chat.cwd}))localStorage.setItem(prefix+key,JSON.stringify(value));
    },scope);
    const codex={thread:'00000000-0000-4000-8000-000000000025',cwd:'/project',title:'Codex task',updated:1700000000};
    let finish=false,hostReady=false,preparedSessions=0,historyAttempts=0,newSubmission:string|undefined;
    let releaseHistory!:()=>void;
    const historyReady=new Promise<void>(resolve=>{releaseHistory=resolve});
    const sessionRequests:string[]=[];
    await page.route(origin+'/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(template,{deviceName:machineName,scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path.endsWith('/antigravity/submit')){
        const sent=route.request().postDataJSON();
        assert.equal(sent.cwd,'/project');
        if(sent.prompt==='Hello'){assert.equal(sent.session,'native');assert.equal(sent.model,'model')}
        else{
          assert.equal(sent.prompt,'Keep this draft');assert.equal(sent.session,undefined);assert.equal(sent.model,undefined);
          newSubmission=sent.id
        }
        return route.fulfill({json:{id:sent.id}})
      }
      if(path.endsWith('/antigravity/status')){
        if(route.request().postDataJSON().id===newSubmission)return route.fulfill({json:{session:'submitted',status:'done',text:'New AGY reply'}});
        return route.fulfill({json:{session:'native',status:finish?'done':'running',text:finish?'Unified reply':''}})
      }
      if(path.endsWith('/capabilities'))return route.fulfill({json:{fullAccess:true}});
      if(path.endsWith('/threads')){
        if(route.request().postDataJSON().thread)return route.fulfill({json:{...codex,messages:[{role:'assistant',text:'Codex reply'}]}});
        return route.fulfill({json:{items:[codex],pinned:[{...codex,thread:'00000000-0000-4000-8000-000000000026',title:'Pinned task'}],
          projects:[{id:'project-id',name:'Project',roots:['/project']},{id:'empty-id',name:'Empty project',roots:['/empty']}]}})
      }
      if(path.endsWith('/sessions')){
        const cwd=route.request().postDataJSON().cwd;
        if(cwd==='/empty')return route.fulfill({json:{items:[]}});
        sessionRequests.push(cwd);
        return route.fulfill({json:{items:[{conversationId:'remote-agy',title:'Discovered task',updatedAt:1700000001000}]}})
      }
      if(path.endsWith('/availability'))return hostReady
        ?route.fulfill({json:{available:true}})
        :route.fulfill({status:503,json:{error:'Host connecting'}});
      if(path.endsWith('/workspaces'))return route.fulfill({json:[]});
      if(path.endsWith('/resume'))return route.fulfill({json:{connected:true}});
      if(path.endsWith('/session')){
        assert.equal(route.request().postDataJSON().cwd,'/project');
        return route.fulfill({json:{sessionId:'prepared-'+ ++preparedSessions}})
      }
      if(path.endsWith('/history')){
        if(route.request().postDataJSON().session!=='remote-agy')return route.fulfill({json:{messages:[]}});
        if(++historyAttempts===1){
          await historyReady;
          return route.fulfill({status:503,json:{error:'History temporarily unavailable'}})
        }
        return route.fulfill({json:{messages:[{role:'user',text:'Question from host'},{role:'assistant',text:'Reply from host'}],running:true}})
      }
      if(path.endsWith('/options'))return route.fulfill({json:{models:{groups:[{models:[{id:'model',name:modelName}]}],current:{model:'model'}},modes:{availableModes:[{id:'default',name:'Default'}],currentModeId:'default'}}});
      if(path.includes('/api/'))return route.fulfill({json:{items:[],projects:[],models:[],native:false}});
      return route.fulfill({path:join(assets,path)});
    });
    await Promise.all([page.waitForResponse(response=>response.url().endsWith('/availability')&&response.status()===503),page.goto(origin+base+'/')]);
    const drawer=page.getByRole('button',{name:android?'切换聊天侧栏':'打开侧边栏',exact:true});
    const project=page.locator('.project-group').filter({has:page.getByRole('button',{name:'在 Project 中新建任务'})});
    const discovered=project.getByRole('button',{name:/^Discovered task，Antigravity(?:，|$)/});
    const codexChat=project.getByRole('button',{name:/^Codex task，Codex(?:，|$)/});
    const brand=page.locator('#device-switch'),filter=page.locator('#sidebar-agent-filter');
    const picker=page.locator('#agent-picker'),dialog=page.locator('#dialog'),prompt=page.locator('#prompt');
    const activeChat=()=>page.evaluate(scope=>{
      const prefix='receiver:'+scope+':';
      const {active}=JSON.parse(localStorage.getItem(prefix+'tim-ser-chats-v2')!);
      return JSON.parse(localStorage.getItem(prefix+'tim-ser-chat-record:'+active)!)
    },scope);
    async function checkComposerRow(){
      assert(await page.locator('.compose-row').evaluate(row=>{
        const composer=row.closest('#composer')!.getBoundingClientRect();
        const controls=Array.from(row.querySelectorAll('#attach-menu,[data-action=permissions],#agent-picker,#model-picker,#dictate,#send'))
          .map(control=>control.getBoundingClientRect());
        return controls.every(rect=>rect.width>0&&rect.left>=composer.left&&rect.right<=composer.right&&
          Math.abs(rect.top+rect.height/2-controls[0].top-controls[0].height/2)<=1)
      }));
      assert(await picker.evaluate(button=>button.nextElementSibling?.id==='model-picker'))
    }
    async function pickAgent(name:string){
      await picker.click();
      assert.equal(await picker.getAttribute('aria-expanded'),'true');
      assert(await dialog.evaluate(menu=>menu.classList.contains('composer-menu')&&!menu.matches(':modal')));
      await dialog.getByRole('menuitemradio',{name,exact:true}).click();
      assert.equal(await picker.getAttribute('aria-expanded'),'false');
      assert.equal(await dialog.isVisible(),false)
    }
    async function checkBlankDraft(){
      assert.equal(await dialog.isVisible(),false);
      assert.equal(await prompt.inputValue(),'');
      assert(await page.locator('#layout.empty').count());
      const active=await activeChat();
      assert.equal(active.cwd,'/project');
      assert.equal(active.projectId,'project-id');
      assert.equal(active.agySession,undefined);
      assert.equal(active.thread,undefined);
      return active
    }
    await drawer.click();
    await codexChat.waitFor();
    assert.equal(await filter.isVisible(),false);
    // Retry immediately after a failed availability probe, without waiting for the normal throttle.
    hostReady=true;
    await page.waitForFunction(()=>{
      if(!document.getElementById('sidebar-agent-filter')!.hidden)return true;
      document.dispatchEvent(new Event('visibilitychange'));
      return false
    },undefined,{polling:100});
    await discovered.waitFor();
    assert.deepEqual(sessionRequests,['/project']);
    // A successful reconnect should also recheck an already populated directory.
    const reprobe=page.waitForResponse(response=>response.url().endsWith('/availability')&&response.ok());
    await page.evaluate(()=>void (window as Window&{receiverNetworkResumed:()=>void}).receiverNetworkResumed());
    await reprobe;
    await codexChat.waitFor();
    assert.equal(await brand.innerText(),machineName);
    assert.equal(await brand.getAttribute('title'),machineName);
    assert.equal(await brand.getAttribute('aria-label'),'切换设备，当前为 '+machineName);
    assert.equal(await brand.locator('svg use').getAttribute('href'),'/icons.svg#chevron-down');
    assert(!/Codex|Antigravity|工作区/.test(await brand.innerText()));
    await page.waitForFunction(()=>{
      const label=document.querySelector<HTMLElement>('#device-switch')!;
      const head=label.parentElement!.getBoundingClientRect(),rect=label.getBoundingClientRect();
      const actions=Array.from(label.parentElement!.querySelectorAll('button:not(#device-switch)'))
        .map(button=>button.getBoundingClientRect()).filter(rect=>rect.width);
      const name=label.querySelector('bdi')!;
      return name.scrollWidth>name.clientWidth&&getComputedStyle(name).textOverflow==='ellipsis'&&
        rect.left>=head.left&&actions.length>0&&actions.every(action=>action.left>=rect.right&&action.right<=head.right+1&&
          action.top>=head.top-2&&action.bottom<=head.bottom+2)
    });
    assert.equal(await page.locator('#header-agent').count(),0);
    assert.equal(await codexChat.locator('.session-agent[data-agent=codex]').textContent(),'C');
    assert.equal(await discovered.locator('.session-agent[data-agent=antigravity]').textContent(),'A');
    const longChat=project.getByRole('button',{name:/A long conversation.*Antigravity/});
    assert(await longChat.locator('.session-agent').evaluate(badge=>
      badge.getBoundingClientRect().right<=badge.closest('.history-row')!.getBoundingClientRect().right+1));
    assert(await page.locator('#side .history').evaluate(side=>side.scrollWidth<=side.clientWidth));
    const initialChat=(await activeChat()).id;
    await filter.getByRole('button',{name:'Codex',exact:true}).click();
    assert.equal(await discovered.count(),0);
    assert(await codexChat.isVisible());
    assert(await page.locator('#pins').isVisible());
    await filter.getByRole('button',{name:'Antigravity',exact:true}).click();
    assert.equal(await codexChat.count(),0);
    assert(await page.getByRole('button',{name:'在 Empty project 中新建任务'}).isVisible());
    assert(await discovered.isVisible());
    assert.equal(await page.locator('#pins').isVisible(),false);
    assert.equal((await activeChat()).id,initialChat);
    assert.equal(await brand.innerText(),machineName);
    await filter.getByRole('button',{name:'全部',exact:true}).click();
    await discovered.click();
    try{
      await page.locator('#history-load').getByText(/正在读取/).waitFor();
      assert.equal(await page.locator('#layout.empty').count(),0);
      assert.equal(await page.title(),'Discovered task · '+machineName);
      assert(await picker.isDisabled())
    }finally{releaseHistory()}
    await page.locator('#history-load').getByText('读取失败：History temporarily unavailable').waitFor();
    await page.locator('#history-load').getByRole('button',{name:'重试'}).click();
    await page.locator('#messages').getByText('Reply from host',{exact:true}).waitFor();
    assert.equal(await page.locator('#layout.empty').count(),0);
    assert.match(await page.locator('#notice').innerText(),/Antigravity 正在主机上处理/);
    assert.equal(await page.locator('#history-load').isVisible(),false);
    await page.locator('#header-options').click();
    assert.equal(await dialog.getByRole('button',{name:/计划模式|目标/}).count(),0);
    assert(await dialog.getByRole('button',{name:'复制 Markdown'}).isVisible());
    assert(await dialog.getByRole('button',{name:'导出 Markdown'}).isVisible());
    assert.equal(await page.locator('#header-share,.rail-profile').count(),0);
    await page.keyboard.press('Escape');
    await drawer.click();
    await longChat.click();
    await page.locator('#model-picker').click();
    await dialog.getByText(modelName,{exact:true}).click();
    await prompt.fill('Hello');
    await page.locator('#send').click();
    await drawer.click();
    const running=project.getByRole('button',{name:/Hello.*Antigravity.*进行中/});
    await running.locator('.sidebar-session-dot[data-status=running]').waitFor();
    assert.doesNotMatch(await running.innerText(),/进行中/);
    await codexChat.click();
    await page.locator('#messages').getByText('Codex reply',{exact:true}).waitFor();
    await page.locator('#prompt').fill('Codex draft');
    finish=true;
    await page.waitForFunction(scope=>{
      const chat=JSON.parse(localStorage.getItem('receiver:'+scope+':tim-ser-chat-record:local')!);
      return chat.messages.some((m:{text:string})=>m.text==='Unified reply')
    },scope);
    assert.equal(await page.locator('#messages').getByText('Unified reply').count(),0);
    await drawer.click();
    await codexChat.locator('.sidebar-session-dot[data-status=done]').waitFor();
    await project.getByRole('button',{name:/Hello.*Antigravity/}).click();
    await page.locator('#messages').getByText('Unified reply',{exact:true}).waitFor();
    await page.locator('#prompt').fill('Antigravity draft');
    await page.reload();
    assert.equal(await page.locator('#prompt').inputValue(),'Antigravity draft');
    await drawer.click();
    await codexChat.click();
    assert.equal(await prompt.inputValue(),'Codex draft');
    await drawer.click();
    await project.getByRole('button',{name:'在 Project 中新建任务'}).click();
    const blank=await checkBlankDraft();
    assert.equal(blank.harness,'codex');
    await drawer.click();
    await page.getByRole('button',{name:'新聊天',exact:true}).click();
    assert.equal((await checkBlankDraft()).id,blank.id);
    await page.keyboard.press('Control+n');
    assert.equal((await checkBlankDraft()).id,blank.id);
    if(android){
      await page.getByRole('button',{name:'新建聊天',exact:true}).click();
      assert.equal((await checkBlankDraft()).id,blank.id)
    }
    await checkComposerRow();
    await prompt.fill('Keep this draft');
    await page.locator('#file').setInputFiles({name:'draft-notes.txt',mimeType:'text/plain',buffer:Buffer.from('Draft notes')});
    const attachment=page.locator('#attachment').getByText('draft-notes.txt',{exact:true});
    await attachment.waitFor();
    await pickAgent('Antigravity');
    assert.equal(await picker.innerText(),'AGY');
    assert.match((await picker.getAttribute('aria-label'))!,/Antigravity/);
    assert.equal(await prompt.inputValue(),'Keep this draft');
    assert.equal((await activeChat()).id,blank.id);
    assert(await attachment.isVisible());
    await page.locator('#model-picker').click();
    await dialog.getByText(modelName,{exact:true}).click();
    assert.equal((await activeChat()).agySessionPrecreated,true);
    assert.equal(await picker.isDisabled(),false);
    for(const width of [393,360,801]){
      await page.setViewportSize({width,height:795});
      await checkComposerRow();
      assert(await page.locator('#model-label .model-trigger-name').evaluate(name=>name.scrollWidth>name.clientWidth))
    }
    await page.setViewportSize({width:393,height:795});
    await pickAgent('Codex');
    assert.equal(await picker.innerText(),'Codex');
    assert.equal(await prompt.inputValue(),'Keep this draft');
    const switched=await activeChat();
    assert.equal(switched.cwd,'/project');
    assert.equal(switched.projectId,'project-id');
    assert.equal(switched.agySession,undefined);
    assert.equal(switched.agySessionPrecreated,undefined);
    assert.equal(switched.agyModel,undefined);
    assert(await attachment.isVisible());
    await page.locator('#attachment').getByRole('button',{name:/移除/}).click();
    // The manual project path is available even while the current draft belongs to Codex.
    await page.locator('.hostline [data-action=project]').click();
    await dialog.getByRole('searchbox').fill('/another-project');
    assert(await dialog.getByRole('button',{name:'打开输入的主机目录'}).isVisible());
    await page.keyboard.press('Escape');
    await page.locator('#composer [data-action=permissions]').click();
    await dialog.getByRole('button',{name:'完全访问权限',exact:true}).click();
    await dialog.getByRole('button',{name:'确认',exact:true}).click();
    await page.locator('#sandbox-label.full-access').waitFor();
    await page.locator('#attach-menu').click();
    assert.equal(await dialog.getByRole('menuitem',{name:'目标',exact:true}).count(),1);
    await dialog.getByRole('menuitem',{name:'启用计划模式',exact:true}).click();
    await pickAgent('Antigravity');
    assert.equal(await page.locator('#sandbox-label.full-access').count(),0);
    assert.equal((await activeChat()).collaborationMode,'default');
    await page.locator('#attach-menu').click();
    assert.equal(await dialog.getByRole('menuitem',{name:/计划模式|目标/}).count(),0);
    await page.keyboard.press('Escape');
    await Promise.all([page.waitForResponse(response=>response.url().endsWith('/antigravity/submit')&&response.ok()),page.locator('#send').click()]);
    await page.locator('#messages').getByText('New AGY reply',{exact:true}).waitFor();
    assert(await picker.isDisabled());
    assert.equal(await picker.getAttribute('data-locked'),'true');
    assert.equal(await picker.getAttribute('title'),'当前会话由 Antigravity 处理');
    assert.equal(await picker.locator('i').isVisible(),false);
    await drawer.click();
    await project.getByRole('button',{name:'在 Project 中新建任务'}).click();
    assert.equal((await checkBlankDraft()).harness,'antigravity');
  }finally{await browser.close()}
});

for(const side of [false,true])test('upload originals and restore attachment previews on tablet, side='+side,async()=>{
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'msedge'});
  try{
    const page=await browser.newPage({hasTouch:true,viewport:{width:960,height:900},serviceWorkers:'block'});
    page.setDefaultTimeout(6000);
    const assets=process.env.WORKBENCH_ASSET_DIR??fileURLToPath(new URL('../web/',import.meta.url));
    const origin='http://localhost:49025',cwd='/home/project',scope='b'.repeat(64),base='/devices/'+scope;
    const mainThread='00000000-0000-4000-8000-000000000025',sideThread='00000000-0000-4000-8000-000000000026';
    const expectedThread=side?sideThread:mainThread,tab='receiver:side-chat';
    const key='receiver:'+scope+':tim-ser-chats-v2';
    await page.addInitScript(({mainThread,sideThread,cwd,side,key,tab})=>{
      if(localStorage.getItem(key))return;
      const owner={id:mainThread,thread:mainThread,cwd,title:'附件',draft:'',files:[],messages:[]};
      if(side)Object.assign(owner,{sideChats:[{...owner,id:sideThread,thread:sideThread}],workView:{ids:[tab],active:tab}});
      localStorage.setItem(key,JSON.stringify({active:owner.id,chats:[owner]}))
    },{mainThread,sideThread,cwd,side,key,tab});
    const template=await readFile(assets+'/index.html','utf8'),chunks=new Map<string,Buffer>();
    const binary=Buffer.alloc(150000,0x9e);binary[0]=0;
    const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/llKiZcAAAAASUVORK5CYII=','base64');
    const drawing=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5"/></svg>');
    let loseReceipt=true;
    await page.route(origin+'/**',async route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(template,{deviceName:'主机',scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path===base+'/api/capabilities')return route.fulfill({json:{attachmentUpload:true}});
      if(path===base+'/api/attachments/upload'){
        const q=url.searchParams,name=q.get('name')!,offset=Number(q.get('offset')),total=Number(q.get('total'));
        const bytes=route.request().postDataBuffer()||Buffer.alloc(0);
        assert.equal(q.get('thread'),expectedThread);
        const old=chunks.get(name)||Buffer.alloc(0);
        const saved=offset===old.length?Buffer.concat([old,bytes]):old;
        chunks.set(name,saved);
        if(loseReceipt){loseReceipt=false;return route.abort('failed')}
        return route.fulfill({json:saved.length===total?
          {complete:true,offset:total,size:total,name,path:cwd+'/.attachments/'+name,root:cwd}:{complete:false,offset:saved.length}})
      }
      if(path===base+'/api/turn')return route.fulfill({json:{id:route.request().postDataJSON().id}});
      if(path===base+'/api/threads'&&route.request().postDataJSON()?.thread){
        const {thread}=route.request().postDataJSON();
        return route.fulfill({json:{thread,cwd,messages:thread===expectedThread?[
          {role:'user',turn:'old-image',text:'旧消息\n\n上传附件（主机文件）：'+cwd+'/.attachments/old.png',
            images:['data:image/png;base64,'+image.toString('base64')]}
        ]:[]}})
      }
      if(path.includes('/api/'))return route.fulfill({json:{items:[],projects:[],models:[],native:false}});
      return route.fulfill({path:assets+path})
    });
    await page.goto(origin+base+'/');
    const history=page.locator(side?'.side-chat-history':'#messages');
    await history.getByText('旧消息',{exact:true}).waitFor();
    assert.doesNotMatch(await history.innerText(),/old\.png/);
    const composer=page.locator(side?'.side-chat form':'#composer');
    const picker=side?composer.locator('input[type=file]'):page.locator('#file');
    await picker.setInputFiles([
      {name:'设计稿.psd',mimeType:'application/octet-stream',buffer:binary},
      {name:'平板.png',mimeType:'image/png',buffer:image},
      {name:'线稿.svg',mimeType:'image/svg+xml',buffer:drawing},
      {name:'empty.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(0)}
    ]);
    await composer.getByRole('button',{name:'打开主机文件 empty.bin'}).waitFor();
    assert.deepEqual(chunks.get('设计稿.psd'),binary);assert.deepEqual(chunks.get('平板.png'),image);assert.deepEqual(chunks.get('线稿.svg'),drawing);
    await page.reload();
    await composer.getByRole('button',{name:'查看线稿.svg'}).waitFor();
    const images=composer.locator('.image-chip');
    assert.equal(await images.count(),2);
    assert.deepEqual(await images.allTextContents(),['','']);
    const remove=images.first().locator('.image-attachment-remove');
    assert.equal(await remove.evaluate(button=>button.getBoundingClientRect().width),32);
    assert.equal(await remove.locator('svg').evaluate(icon=>icon.getBoundingClientRect().width),11);
    assert.equal(await remove.evaluate(button=>getComputedStyle(button).position),'absolute');
    assert.deepEqual(await images.evaluateAll(chips=>chips.map(chip=>chip.getAttribute('title'))),[null,null]);
    await composer.getByRole('button',{name:'查看平板.png'}).tap();
    await page.locator('#dialog.image-viewer img').waitFor();
    assert.equal(await page.locator('#dialog-title').textContent(),'图片附件');
    assert(await page.getByRole('button',{name:'打开主机上的原图'}).isVisible());
    await page.locator('#dialog [data-action=close]').tap();
    const submission=page.waitForRequest(request=>request.url()===origin+base+'/api/turn');
    await composer.getByRole('button',{name:side?'发送':'发送消息',exact:true}).tap();
    const data=(await submission).postDataJSON();
    assert.equal(data.expectedThread,expectedThread);
    for(const name of ['设计稿.psd','平板.png','线稿.svg','empty.bin'])assert(data.prompt.includes(cwd+'/.attachments/'+name));
    assert.equal(data.images.length,2);
    await history.getByRole('button',{name:'打开主机文件 设计稿.psd'}).waitFor();
    assert.doesNotMatch(await history.innerText(),/平板\.png|线稿\.svg/);
    await history.getByRole('button',{name:'查看图片附件'}).first().tap();
    await page.locator('#dialog.image-viewer img').waitFor();
  }finally{await browser.close()}
});

test('tablet goal composer creates a host goal, preserves failed drafts and confirms replacement',async()=>{
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'msedge'});
  try{
    const page=await browser.newPage({hasTouch:true,viewport:{width:980,height:800},serviceWorkers:'block'});
    const assets=process.env.WORKBENCH_ASSET_DIR??fileURLToPath(new URL('../web/',import.meta.url));
    const origin='http://localhost:49019',thread='c0ffee00-0000-4000-8000-000000000001';
    let supported=false,loseReceipt=true,ordinaryTurns=0;
    let confirmReplacement:(()=>void)|undefined;
    let goal:{objective:string,status:string,createdAt:number,timeUsedSeconds:number,updatedAt:number,tokensUsed:number,tokenBudget:number|null}|null=null;
    const requests:any[]=[];
    const template=await readFile(assets+'/index.html','utf8');
    await page.route(origin+'/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(template,{deviceName:'主机',scope:'',version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path==='/api/capabilities')return route.fulfill({json:{goalMode:supported}});
      if(path==='/api/thread-goal'){
        const request=route.request().postDataJSON();requests.push(request);
        goal={objective:request.objective,status:'active',createdAt:100,timeUsedSeconds:60,updatedAt:Math.floor(Date.now()/1000),
          tokensUsed:500,tokenBudget:request.thread?2000:null};
        if(loseReceipt){loseReceipt=false;return route.abort('failed')}
        if(request.thread)await new Promise<void>(resolve=>{confirmReplacement=resolve});
        return route.fulfill({json:{thread,goal}})
      }
      if(path==='/api/turn')ordinaryTurns++;
      if(path==='/api/threads'&&route.request().postDataJSON()?.thread)return route.fulfill({json:{thread,goal,messages:[]}});
      if(path.includes('/api/'))return route.fulfill({json:{items:[],models:[],projects:[]}});
      return route.fulfill({path:assets+path})
    });
    await page.goto(origin);
    const prompt=page.locator('#prompt');
    await prompt.fill('/go');
    await page.getByRole('option',{name:/^\/goal/}).tap();
    assert.equal(await prompt.inputValue(),'');
    assert.match(await prompt.getAttribute('placeholder')||'',/可衡量/);
    const goalButton=page.getByRole('button',{name:'退出目标模式',exact:true});
    for(const viewport of [{width:800,height:1100},{width:980,height:800}]){
      await page.setViewportSize(viewport);
      const parts=await Promise.all([
        goalButton,goalButton.locator('i svg'),goalButton.locator('span'),goalButton.locator('.goal-dismiss'),page.locator('#attach-menu')
      ].map(part=>part.boundingBox()));
      const center=(box:NonNullable<typeof parts[number]>)=>box.y+box.height/2;
      const [button,target,label,dismiss,attach]=parts;
      assert(button&&target&&label&&dismiss&&attach);
      assert.equal(target.width,16);
      assert.equal(target.height,16);
      assert(target.x+target.width<=label.x && label.x+label.width<=dismiss.x);
      for(const part of [target,label,dismiss,attach])assert(Math.abs(center(part)-center(button))<=1);
    }
    await goalButton.tap();
    await page.locator('#attach-menu').tap();
    await page.getByRole('menuitem',{name:'目标',exact:true}).tap();
    assert.match(await prompt.getAttribute('placeholder')||'',/可衡量/);
    await prompt.fill('检查平板布局');
    await page.locator('#send').tap();
    await page.getByText('当前主机连接不支持设置目标。草稿已保留。',{exact:true}).waitFor();
    assert.equal(await prompt.inputValue(),'检查平板布局');
    supported=true;
    await page.locator('#send').tap();
    await page.waitForFunction(()=>!(document.querySelector('#send') as HTMLButtonElement).disabled);
    await page.reload();
    assert.equal(await prompt.inputValue(),'检查平板布局');
    await page.locator('#send').tap();
    await page.locator('#goal-objective').getByText('检查平板布局').waitFor();
    assert.match(await page.locator('#goal-time').innerText(),/^1m/);
    assert.equal(requests.length,2);
    assert.deepEqual(requests[0],requests[1]);
    assert.equal(requests[0].expected,null);
    assert.equal(requests[0].activate,true);
    assert.equal(await prompt.inputValue(),'');
    await prompt.fill('/goal 验证横屏');
    await page.locator('#send').tap();
    await page.getByRole('button',{name:'取消',exact:true}).tap();
    assert.equal(requests.length,2);
    assert.equal(await prompt.inputValue(),'验证横屏');
    await page.locator('#send').tap();
    const replacing=page.waitForRequest(request=>request.url()===origin+'/api/thread-goal');
    await page.getByRole('button',{name:'替换目标',exact:true}).tap();
    await replacing;
    assert.equal(await page.locator('#model-picker').isDisabled(),true);
    assert.equal(await page.locator('[data-action=permissions]').isDisabled(),true);
    await prompt.fill('保留后续问题');
    await prompt.press('Enter');
    confirmReplacement!();
    await page.locator('#goal-objective').getByText('验证横屏').waitFor();
    assert.equal(await page.locator('#goal-time').innerText(),'500 / 2000');
    assert.equal(await prompt.inputValue(),'保留后续问题');
    assert.equal(await page.locator('#goal-mode').isHidden(),true);
    assert.deepEqual(requests[2].expected,{objective:'检查平板布局',status:'active',createdAt:100});
    assert.equal(requests[2].thread,thread);
    assert.equal(ordinaryTurns,0)
  }finally{await browser.close()}
});

test('tablet account usage shows remaining quota graphically and refreshes after a failed read',async()=>{
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'msedge'});
  try{
    const page=await browser.newPage({hasTouch:true,viewport:{width:960,height:900},serviceWorkers:'block'});
    page.setDefaultTimeout(6000);
    const assets=process.env.WORKBENCH_ASSET_DIR??fileURLToPath(new URL('../web/',import.meta.url));
    const origin='http://localhost:49012',scope='d'.repeat(64),base='/devices/'+scope;
    const template=await readFile(assets+'/index.html','utf8');
    let fail=false,failAntigravity=false;
    await page.route(origin+'/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(template,{deviceName:'主机',scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path===base+'/api/account-usage')return fail?route.fulfill({status:503,json:{error:'用量暂时不可用'}}):route.fulfill({json:{
        groups:[{name:'Codex',windows:[{windowDurationMins:300,usedPercent:67},{windowDurationMins:10080,usedPercent:12}]}]}});
      if(path===base+'/api/antigravity/usage')return failAntigravity
        ?route.fulfill({status:503,json:{error:'Antigravity 用量暂时不可用'}})
        :route.fulfill({json:{groups:[{name:'Gemini',windows:[
          {windowDurationMins:300,usedPercent:20,resetsAt:1893456000}
        ]},{name:'Claude 与 GPT',windows:[{windowDurationMins:10080,usedPercent:52.5}]}]}});
      if(path.includes('/api/'))return route.fulfill({json:{items:[],models:[],projects:[]}});
      return route.fulfill({path:assets+path});
    });
    await page.goto(origin+base+'/');
    const rail=page.locator('#app-rail [data-action="account-usage"]');
    await rail.tap();
    await page.getByRole('progressbar',{name:'Claude 与 GPT 7 天剩余额度'}).waitFor();
    assert.deepEqual(await page.getByRole('progressbar').evaluateAll(bars=>bars.map(el=>(el as HTMLProgressElement).value)),[33,88,80,47.5]);
    assert(await page.getByText('47.5%',{exact:true}).isVisible());
    assert(await page.getByText(/^重置时间/).isVisible());
    assert.doesNotMatch(await rail.getAttribute('title')||'',/%/);
    fail=true;
    await page.getByRole('button',{name:'刷新用量'}).tap();
    await page.getByText('用量暂时不可用',{exact:true}).waitFor();
    assert.equal(await page.locator('.quota-provider').nth(0).getByRole('progressbar').count(),0);
    await page.getByRole('progressbar',{name:'Gemini 5 小时剩余额度'}).waitFor();
    fail=false;failAntigravity=true;
    await page.getByRole('button',{name:'刷新用量'}).tap();
    await page.getByText('Antigravity 用量暂时不可用',{exact:true}).waitFor();
    await page.getByRole('progressbar',{name:'Codex 5 小时剩余额度'}).waitFor();
  }finally{await browser.close()}
});

test('side chat keeps its opening mode and routes plan questions to its own turn',async()=>{
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'msedge'});
  try{
    const page=await browser.newPage({hasTouch:true,viewport:{width:960,height:900},serviceWorkers:'block'});
    page.setDefaultTimeout(6000);
    const origin='http://localhost:49011',scope='e'.repeat(64),base='/devices/'+scope;
    const parent='00000000-0000-4000-8000-000000000015',child='00000000-0000-4000-8000-000000000016';
    const assets=process.env.WORKBENCH_ASSET_DIR??fileURLToPath(new URL('../web/',import.meta.url));
    let job='',mode='',answer:unknown,forks=0;
    await page.addInitScript(({scope,parent})=>{
      const chat={id:parent,thread:parent,title:'计划',messages:[{role:'user',text:'主任务'}],draft:'',files:[],collaborationMode:'plan',
        threadConfig:{model:'alpha',effort:'high'},threadServiceTier:'ultrafast',speedChoice:{model:'alpha',id:'default'}};
      localStorage.setItem('receiver:'+scope+':tim-ser-chats-v2',JSON.stringify({active:parent,chats:[chat]}));
    },{scope,parent});
    await page.route(origin+'/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path===base+'/')return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(await readFile(assets+'/index.html','utf8'),{deviceName:'主机',scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if(path===base+'/api/thread-fork'){
        forks++;
        if(forks===3)return route.fulfill({status:503,json:{error:'主机暂时离线'}});
        return route.fulfill({json:{thread:child}})
      }
      if(path===base+'/api/models')return route.fulfill({json:{
        canSetServiceTier:true,
        models:['alpha','bravo','charlie'].map(id=>({id,name:id,efforts:['low','high'],defaultEffort:'low',serviceTiers:[{id:'priority',name:'Fast'}]})),
        defaults:{model:'alpha',effort:'low'}}});
      if(path===base+'/api/turn'){
        const request=route.request().postDataJSON();mode=request.collaborationMode;job=request.id;
        assert.equal(request.expectedThread,child);return route.fulfill({json:{id:job}});
      }
      if(job&&path.startsWith(base+'/api/turn/'+job)){
        const snapshot={id:job,thread:child,turn:'side-turn',status:answer?'done':'waiting',answer:'已收到回答',
          stepPlan:{steps:[{step:'确认交付格式',status:answer?'completed':'inProgress'}]},
          order:[{kind:'steps',id:'plan-1'},...(answer?[{kind:'assistant',id:'reply',part:0}]:[])],
          parts:answer?['已收到回答']:[],
          inputRequests:{pick:[{id:'format',question:'选择交付格式',options:[{label:'表格'}]}]}};
        return path.endsWith('/events')?route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(snapshot)+'\n\n'}):route.fulfill({json:snapshot});
      }
      if(job&&path===base+'/api/answer/'+job){
        answer=route.request().postDataJSON();return route.fulfill({json:{ok:true}});
      }
      if(path.includes('/api/'))return route.fulfill({json:{items:[],projects:[],models:[],native:false}});
      return route.fulfill({path:assets+path});
    });
    await page.goto(origin+base+'/');
    const forked=page.waitForResponse(res=>res.url()===origin+base+'/api/thread-fork',{timeout:4000});
    await page.locator('#prompt').fill('/side');
    await page.locator('#prompt').press('Enter');
    await forked;
    assert.equal(job,'');
    await page.locator('#plan-mode').click();
    await page.locator('#model-picker').click();
    await page.locator('.model-view-toggle').click();
    await page.getByRole('menuitemradio',{name:'bravo',exact:true}).click();
    await page.keyboard.press('Escape');
    const side=page.locator('.side-chat');
    assert.equal(await side.locator('textarea').getAttribute('placeholder'),'描述你的任务以生成计划…');
    assert.equal(await page.locator('#prompt').getAttribute('placeholder'),'和 Codex 一起工作');
    const sideModels=side.getByRole('button',{name:'选择模型与推理强度'});
    assert.match(await sideModels.innerText(),/alpha/);
    await sideModels.tap();
    await page.locator('.model-view-toggle').tap();
    await page.getByRole('menuitemradio',{name:'charlie',exact:true}).tap();
    const sideSpeed=page.getByRole('menuitemcheckbox',{name:'启用快速模式',exact:true});
    await sideSpeed.tap();
    await page.getByRole('menuitemcheckbox',{name:'启用标准模式',exact:true}).tap();
    assert.equal(await sideSpeed.getAttribute('aria-checked'),'false');
    assert.equal(await page.locator('.speed-flyout').count(),0);
    await page.keyboard.press('Escape');
    assert.match(await sideModels.innerText(),/charlie/);
    assert.match(await page.locator('#model-picker').innerText(),/bravo/);
    const editor=side.locator('textarea');
    const initialHeight=await editor.evaluate(field=>field.clientHeight);
    await editor.fill(Array(8).fill('侧聊草稿').join('\n'));
    assert(await editor.evaluate(field=>field.clientHeight)>initialHeight);
    await side.locator('textarea').fill('讨论计划');
    assert.equal(await editor.evaluate(field=>field.clientHeight),initialHeight);
    const choosing=page.waitForEvent('filechooser');
    await side.getByRole('button',{name:'添加文件等内容'}).tap();
    await page.getByRole('menuitem',{name:'添加本地文件'}).tap();
    await (await choosing).setFiles({name:'side-note.txt',mimeType:'text/plain',buffer:Buffer.from('侧聊附件正文')});
    await side.getByText('side-note.txt',{exact:true}).waitFor();
    assert.equal(await page.locator('#attachment').getByText('side-note.txt').count(),0);
    const pastedImage=await editor.evaluate(async field=>{
      const image=document.createElement('canvas');image.width=image.height=2;
      const blob=await new Promise<Blob>(resolve=>image.toBlob(data=>resolve(data!),'image/png'));
      const clipboardData=new DataTransfer();
      clipboardData.setData('text/plain','附件');
      clipboardData.items.add(new File([blob],'侧聊截图.png',{type:'image/png'}));
      if(!(field instanceof HTMLTextAreaElement))throw Error('missing side chat editor');
      field.setSelectionRange(2,4);
      field.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
      return image.toDataURL()
    });
    await side.getByRole('button',{name:'查看侧聊截图.png'}).waitFor();
    assert.equal(await editor.inputValue(),'讨论附件');
    assert.equal(await page.locator('#attachment .chip').count(),0);
    const submitted=page.waitForResponse(res=>res.url()===origin+base+'/api/turn');
    await side.getByRole('button',{name:'发送',exact:true}).tap();
    const selection=(await submitted).request().postDataJSON();
    assert.equal(selection.prompt,'讨论附件\n\n文件：side-note.txt\n侧聊附件正文');
    assert.deepEqual(selection.images,[pastedImage]);
    assert.equal(forks,1);
    assert.equal(selection.model,'charlie');
    assert.equal(selection.effort,'high');
    assert.equal(selection.serviceTier,'default');
    assert.equal(mode,'plan');
    await side.locator('.plan-steps li[data-status="inProgress"]').getByText('确认交付格式').waitFor();
    assert.equal(await page.locator('#messages .turn-plan').count(),0);
    await side.getByRole('radio',{name:'表格'}).check();
    assert.equal(await page.locator('#pending-questions').getByText('选择交付格式').count(),0);
    await side.getByRole('button',{name:'提交回答'}).tap();
    await side.getByText('已收到回答',{exact:true}).waitFor();
    await side.locator('.plan-steps li[data-status="completed"]').getByText('确认交付格式').waitFor();
    assert.deepEqual(answer,{turn:'side-turn',token:'pick',answers:{format:{answers:['表格']}}});
    const commandTurn=page.waitForRequest(req=>req.url()===origin+base+'/api/turn');
    const file={name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('附件正文')};
    const image={name:'demo.png',mimeType:'image/png',buffer:await readFile(assets+'/codex.png')};
    await page.locator('#file').setInputFiles([file,image]);
    await page.locator('#attachment').getByRole('button',{name:'查看'+image.name}).waitFor();
    await page.locator('#attachment').getByText(file.name).waitFor();
    await page.locator('#prompt').fill('/side 单独追问');
    await page.locator('#prompt').press('Enter');
    const commandRequest=(await commandTurn).postDataJSON();
    assert.equal(commandRequest.expectedThread,child);
    assert.equal(commandRequest.prompt,'单独追问\n\n文件：note.txt\n附件正文');
    assert.equal(commandRequest.images.length,1);
    await side.getByRole('button',{name:'查看图片附件'}).tap();
    assert.equal(await page.locator('dialog.image-viewer[open] .image-viewport img').getAttribute('src'),commandRequest.images[0]);
    await page.keyboard.press('Escape');
    await page.reload();
    await side.getByRole('button',{name:'查看图片附件'}).waitFor();
    assert.equal(forks,2);
    assert.equal(await page.locator('#prompt').inputValue(),'');
    await page.locator('#file').setInputFiles(file);
    await page.locator('#attachment').getByText(file.name).waitFor();
    await page.locator('#prompt').fill('/side 仍待发送');
    await page.locator('#prompt').press('Enter');
    await side.getByText('主机暂时离线').waitFor();
    assert.equal(await side.locator('textarea').inputValue(),'仍待发送');
    await side.getByRole('button',{name:'移除 note.txt'}).tap();
    assert.equal(await side.locator('.chip').count(),0);
  }finally{await browser.close()}
});

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
    assert.deepEqual(await page.locator('#work-tabs .work-tab').allTextContents(),['文件资源管理器','侧边聊天']);
    assert(await page.locator('#work-tabs').getByRole('button',{name:'侧边聊天'}).isDisabled());
    assert.equal(await panelToggle.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Control+Alt+b');
    assert(await page.locator('#workbench').isHidden());
    const draft = page.locator('#prompt');
    await draft.fill('/');
    const suggestions = page.getByRole('listbox', {name: '命令'});
    assert.deepEqual(await suggestions.getByRole('option').allTextContents(), [
      '/model　选择模型', '/goal　设置要持续追求的目标', '/plan　计划模式',
    ]);
    await draft.press('ArrowDown');
    assert.equal(await draft.getAttribute('aria-activedescendant'), 'goal-command-option');
    await draft.press('Escape');
    assert(await suggestions.isHidden());
    assert.equal(await draft.inputValue(), '/');
    await draft.fill('正文 /mo');
    await draft.press('Tab');
    await page.getByRole('textbox', {name: '搜索模型'}).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await draft.inputValue(), '正文 ');
    assert.equal(turnRequests, 0);
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
    assert.equal(await page.getByRole('menuitemradio', {name: 'Model delta'}).innerText(), 'Model delta');
    assert.equal(await page.getByRole('menuitemradio', {name: 'Model delta'}).getAttribute('aria-checked'), 'true');
    await retiring.click();
    assert.match(await page.locator('.model-view-name').innerText(), /bravo/);
    await page.locator('.model-view-toggle').click();
    await page.getByRole('menuitemradio', {name: '默认',exact: true}).click();
    assert.match(await page.locator('.model-view-name').innerText(), /alpha/);
    const speed = page.locator('.speed-trigger');
    assert.equal(await speed.getAttribute('role'),'menuitemcheckbox');
    assert.equal(await speed.getAttribute('aria-label'),'启用快速模式');
    await speed.press('Enter');
    assert.equal(await speed.getAttribute('aria-checked'),'true');
    assert.equal(await speed.getAttribute('aria-label'),'启用标准模式');
    assert(await speed.evaluate(el => el === document.activeElement));
    await speed.press('Space');
    assert.equal(await speed.getAttribute('aria-checked'),'false');
    assert.equal(await speed.getAttribute('aria-label'),'启用快速模式');
    assert.equal(await page.locator('.speed-flyout').count(),0);
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
    const picker=page.getByRole('button',{name:'切换设备，当前为 '+host.name});
    await picker.click();
    await page.getByRole('button',{name:/当前设备/}).waitFor();
    assert(page.url().endsWith('/devices/'+scope+'/'));
    assert.equal(await picker.getAttribute('aria-expanded'),'true');
    await page.getByRole('button',{name:/在线$/}).click();
    await page.waitForURL('**/devices/' + second.scope + '/');
    assert.equal(await draft.inputValue(), '');
    await draft.fill('第二台主机的草稿');
    host.name = '改名 & <主机> "__DICTATION_ENGINE__"' + '很长的设备名'.repeat(20);
    await page.goto(directory);
    await page.getByRole('button', {name: /改名/}).click();
    await page.waitForURL('**/devices/' + scope + '/');
    assert.equal(await page.locator('.hostline [data-receiver-name]').textContent(), host.name);
    const hostLink = page.locator('#composer-device');
    assert.equal(await page.locator('#device-switch bdi').textContent(),host.name);
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

test('restore a streaming turn after sending on another device with the same thread ID', async t => {
  const profile = await mkdtemp(join(tmpdir(),'codex-remote-host-switch-'));
  t.after(()=>rm(profile,{recursive:true,force:true,maxRetries:3}));
  const openBrowser = () => chromium.launchPersistentContext(profile,{
    ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {channel:'msedge'}),
    serviceWorkers:'block',
  });
  let browser = await openBrowser();
  try {
    let page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const hosts = ['a', 'b'].map(key => ({deviceId: key, scope: key.repeat(64), name: '同名设备', online: true}));
    const origin = 'http://localhost:49004';
    const template = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
    const jobs = new Map<string, {id: string; done: boolean}>();
    const posts: string[] = [];
    const wrongHost: string[] = [];
    let publishRename!:()=>void;
    const renamed=new Promise<void>(resolve=>{publishRename=resolve});
    async function hostResponse(route:Route) {
      const path = new URL(route.request().url()).pathname;
      const device = hosts.find(host => path.startsWith('/devices/' + host.scope + '/'));
      const api = device ? path.slice(('/devices/' + device.scope).length) : path;
      if (path === '/api/devices') return route.fulfill({json: {devices: hosts}});
      if (device && api === '/') return route.fulfill({contentType: 'text/html', body: renderWorkbenchPage(template, {
        deviceName: device.name, scope: device.scope, version: '0123456789abcdef', dictationEngine: 'browser',
      })});
      if (api === '/api/native-capability') return route.fulfill({json: {native: false}});
      if (device?.deviceId==='a'&&api==='/api/directory-events'){
        await renamed;
        return route.fulfill({contentType:'text/event-stream',body:'event: device-name\ndata: '+JSON.stringify(device.name)+'\n\n'})
      }
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
        const firstParagraph = '第一台的第一段';
        const finalAnswer = device.deviceId === 'a' ? firstParagraph + '\n\n第二段已完成' : 'b 的最终回复';
        const snapshot = {id: job.id, created: 1000, observedTextAt: 1100, thread: 'shared-thread', turn: 'shared-turn',
          parts: [firstParagraph], progress: job.done ? {} : {message: '第二段正在输出'},
          status: job.done ? 'done' : 'running', answer: job.done ? finalAnswer : ''};
        if (api.endsWith('/events')) return route.fulfill({contentType: 'text/event-stream',
          body: 'data: ' + JSON.stringify(snapshot) + '\n\n'});
        return route.fulfill({json: snapshot});
      }
      if (api.includes('/api/')) return route.fulfill({json: {items: [], projects: [], models: [], ids: []}});
      const file = path === '/devices' || path === '/' ? 'devices.html' : path.slice(1);
      return route.fulfill({path: fileURLToPath(new URL('../web/' + file, import.meta.url))});
    }
    await page.route(origin+'/**',hostResponse);
    async function select(index: number) {
      const host = hosts[index];
      if(page.url()==='about:blank'){
        await page.goto(origin+'/devices');
        const label=hosts.filter(item=>item.name===host.name).length>1?host.deviceId:host.name;
        await page.locator('#devices button').filter({has:page.getByText(label,{exact:true})}).click()
      }else{
        await page.locator('#device-switch').click();
        await page.locator('#dialog').getByRole('button',{name:host.name+'，在线',exact:true}).click()
      }
      await page.waitForURL('**/devices/'+host.scope+'/')
    }
    async function send(message: string) {
      await page.locator('#prompt').fill(message);
      await page.locator('#prompt').press('Enter');
    }
    let messages = page.locator('#messages');
    await select(0);
    const started = page.waitForRequest(req => req.url().includes('/api/turn/') && req.url().endsWith('/events'));
    await send('第一台的提问');
    await started;
    await messages.getByText('第二段正在输出', {exact: true}).waitFor();
    await page.locator('#prompt').fill('第一台未发送');
    hosts[0].name='Studio North';
    publishRename();
    const renamedLink=page.getByRole('button',{name:'切换设备，当前为 Studio North'});
    await renamedLink.waitFor();
    assert.equal(await renamedLink.textContent(),'Studio North');
    await select(1);
    assert.equal(await page.locator('#prompt').inputValue(),'');
    await send('第二台的提问');
    await messages.getByText('b 的最终回复', {exact: true}).waitFor();
    assert.doesNotMatch(await messages.innerText(), /第一台的提问|第一台的第一段|第二段正在输出/);
    await page.locator('#prompt').fill('第二台未发送');
    await page.getByRole('button', {name: '设置',exact:true}).click();
    await page.getByRole('button', {name: '连接信息',exact:true}).click();
    await page.getByText(/前台发送到页面收到首段正文/).waitFor();
    await page.keyboard.press('Escape');
    await select(0);
    assert.equal(await page.locator('#prompt').inputValue(),'第一台未发送');
    await messages.getByText('第二段正在输出', {exact: true}).waitFor();
    await browser.close();
    browser=await openBrowser();
    page=await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.route(origin+'/**',hostResponse);
    messages=page.locator('#messages');
    await page.goto(origin+'/');
    await page.waitForURL('**/devices/'+hosts[0].scope+'/');
    assert.equal(await page.getByRole('button',{name:'切换设备，当前为 Studio North'}).textContent(),'Studio North');
    assert.equal(await page.locator('#prompt').inputValue(),'第一台未发送');
    await messages.getByText('第二段正在输出', {exact: true}).waitFor();
    assert.equal(await messages.getByText('第一台的第一段', {exact: true}).count(), 1);
    jobs.get('a')!.done = true;
    await messages.getByText('第二段已完成', {exact: true}).waitFor();
    assert.equal(await messages.getByText('第一台的第一段', {exact: true}).count(), 1);
    assert.doesNotMatch(await messages.innerText(), /第二段正在输出/);
    assert.match(await messages.innerText(), /第一台的提问/);
    assert.doesNotMatch(await messages.innerText(), /第二台的提问|b 的最终回复/);
    await select(1);
    assert.equal(await page.locator('#prompt').inputValue(),'第二台未发送');
    await messages.getByText('b 的最终回复',{exact:true}).waitFor();
    assert.deepEqual(posts, ['a', 'b']);
    assert.deepEqual(wrongHost, []);
  } finally { await browser.close() }
});

for (const [mode,tier,expectedTier] of [
  ['daemon','快速','priority'],['native','超快','ultrafast'],['native','标准','default'],['legacy','超快',null],
] as const) test('touch selection sends the model and effort shown by the tablet composer · ' + mode + ' · ' + tier, async () => {
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
          efforts: ['low', 'medium', 'high'], defaultEffort: 'low'})), defaults: {model: 'alpha', effort: 'low',serviceTier:'ultrafast'},
      }});
      if (path === base + '/api/native-capability') return route.fulfill({json: {native: mode !== 'daemon',hostPermissions:mode!=='legacy'}});
      if (path === base + '/api/capabilities') return route.fulfill({json: {autoReview: mode !== 'legacy', fullAccess: true}});
      if (path === base + '/api/turn') return route.fulfill({json: {id: route.request().postDataJSON().id}});
      if (path.includes('/api/')) return route.fulfill({json: {items: [], projects: [], models: []}});
      return route.fulfill({path: directory + path});
    });
    await page.goto(origin + base + '/');
    const useHostDefault=mode==='native'&&tier==='标准';
    if(useHostDefault)assert.equal(await page.locator('#sandbox-label').innerText(),'沿用主机权限');
    if (mode !== 'daemon'&&!useHostDefault) {
      await page.locator('[data-action=permissions]').tap();
      await page.getByRole('button', {name: '完全访问权限', exact: true}).tap();
      await page.getByRole('button', {name: '取消', exact: true}).tap();
      const review = page.getByRole('button', {name: '帮我批准', exact: true});
      assert.equal(await review.isDisabled(), mode === 'legacy');
      if (mode === 'legacy') await page.getByRole('button', {name: '请求批准', exact: true}).tap();
      else await review.tap();
    }
    await page.locator('#model-picker').tap();
    await page.locator('.model-view-toggle').tap();
    await page.getByRole('menuitemradio', {name: 'bravo', exact: true}).tap();
    const slider = page.getByRole('slider', {name: '强度'});
    const box = await slider.boundingBox();
    assert(box);
    await slider.tap({position: {x: box.width - 6, y: box.height / 2}});
    assert.equal(await slider.inputValue(), '2');
    const speed = page.locator('.speed-trigger');
    const choice = page.getByRole('menuitemradio', {name: tier,exact:true});
    if (mode !== 'legacy') {
      await speed.tap();
      const flyout = page.locator(mode==='native'?'dialog.speed-flyout[open]':'.speed-flyout:popover-open');
      await flyout.waitFor();
      const options=flyout.getByRole('menuitemradio');
      assert.deepEqual(await options.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))),['标准','快速','超快']);
      const checked=flyout.getByRole('menuitemradio',{checked:true});
      assert.equal(await checked.count(),1);
      assert((await speed.getAttribute('aria-label'))?.includes((await checked.getAttribute('aria-label'))!));
      await page.setViewportSize({width:780,height:540});
      await page.waitForFunction(() => {
        const panel = document.querySelector('.speed-flyout')!.getBoundingClientRect();
        const parent = document.querySelector('#dialog')!.getBoundingClientRect();
        const rightFits=innerWidth-parent.right>=panel.width+16;
        const leftFits=parent.left>=panel.width+16;
        const onExpectedSide=rightFits?panel.left>=parent.right-1:leftFits?panel.right<=parent.left+1:true;
        return onExpectedSide && panel.width>0 && panel.left>=7 && panel.right<=innerWidth-7 &&
          panel.top>=7 && panel.bottom<=innerHeight-7;
      });
      // Tapping the parent menu dismisses the speed choices without losing the model picker.
      if(mode==='native')await page.touchscreen.tap(2,2);
      else {
        const dialogBounds=await page.locator('#dialog').boundingBox();
        assert(dialogBounds);
        await page.touchscreen.tap(dialogBounds.x+dialogBounds.width/2,dialogBounds.y+dialogBounds.height-4);
      }
      await flyout.waitFor({state:'hidden'});
      assert(await page.locator('#dialog').isVisible());
      await page.locator('.speed-trigger[aria-expanded=false]').waitFor();
      await page.locator('.speed-trigger').tap();
      const handled = await page.evaluate(() => (window as typeof window & {dismissWorkbenchOverlay:()=>boolean}).dismissWorkbenchOverlay());
      assert(handled);
      await flyout.waitFor({state:'hidden'});
      assert(await page.locator('.speed-trigger').evaluate(el=>el===document.activeElement));
      await speed.press('ArrowDown');
      await page.keyboard.press('End');
      assert(await options.last().evaluate(el=>el===document.activeElement));
      await page.keyboard.press('Home');
      assert(await options.first().evaluate(el=>el===document.activeElement));
      await page.keyboard.press('Escape');
      await flyout.waitFor({state:'hidden'});
      assert(await page.locator('#dialog').isVisible());
      assert(await speed.evaluate(el=>el===document.activeElement));
      await page.setViewportSize({width:960,height:720});
      if(mode==='daemon'){
        await speed.hover();
        await flyout.waitFor();
        await options.last().hover();
        await page.mouse.move(2,2);
        await flyout.waitFor({state:'hidden'});
        assert(await page.locator('#dialog').isVisible());
      }
      await speed.press('ArrowRight');
      await page.keyboard.press('Home');
      await page.keyboard.press('Enter');
      await flyout.waitFor({state:'hidden'});
      assert((await speed.getAttribute('aria-label'))?.includes('标准'));
      assert(await speed.evaluate(el=>el===document.activeElement));
      await speed.tap();
      await choice.tap();
      await flyout.waitFor({state:'hidden'});
      assert((await speed.getAttribute('aria-label'))?.includes(tier));
      assert(await speed.evaluate(el=>el===document.activeElement));
    } else {
      assert(await speed.isDisabled());
      assert.equal(await page.locator('.speed-flyout').count(),0);
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
    assert.equal(payload.serviceTier,expectedTier);
    assert.equal(payload.sandbox,mode==='legacy'?'remote-workspace':
      mode==='daemon'||useHostDefault?'host-default':'auto-review');
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
    const markdown='# 说明\n\n- [x] 完成\n\n|文件|大小|\n|---|---|\n|示例|1|\n\n```ts\nconst a = 1;\n```\n\n[查看正文](note.txt#L1)\n\n<b>原文</b>';
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === base + '/') return route.fulfill({contentType:'text/html',body:renderWorkbenchPage(
        await readFile(directory + '/index.html','utf8'), {deviceName:'文件主机',scope,version:'0123456789abcdef',dictationEngine:'browser'})});
      if (path === base + '/api/threads') {
        const {cursor}=route.request().postDataJSON();
        if(cursor==='next')return route.fulfill({json:{items:[],cursor:'last'}});
        if(cursor==='last')return route.fulfill({json:{items:[{thread:'00000000-0000-4000-8000-000000000073',title:'旧会话',cwd:'C:\\dev\\older-project'}]}});
        return route.fulfill({json:{items:[],cursor:'next',projects:[project,{id:'second-project',name:'第二项目',roots:['C:\\dev\\second'] }]}});
      }
      if (path === base + '/api/project-directories') {
        const {relative,workspace} = route.request().postDataJSON();
        assert.equal(workspace,root);
        return route.fulfill({json:{folders:relative ? [] : ['src'],files:relative ? ['note.txt','README.MD','art.png','report.pdf'] : []}});
      }
      if (path === base + '/api/project-file-snapshot') {
        snapshot = route.request().postDataJSON();
        const name=route.request().postDataJSON().path;
        if(name.endsWith('.png')){
          const data=await readFile(directory+'/codex.png');
          return route.fulfill({json:{source:'working-tree',mime:'image/png',bytes:data.length,version:'image-1',data:data.toString('base64')}});
        }
        if(name.endsWith('.pdf'))return route.fulfill({json:{source:'working-tree',mime:'application/pdf',bytes:17,version:'pdf-1'}});
        return route.fulfill({json:{source:'working-tree', text:route.request().postDataJSON().path.endsWith('.MD')?markdown:'今天的工作区内容 <b>文本</b>'}});
      }
      if(path===base+'/api/project-file-download'){
        const request=route.request().postDataJSON();
        assert.equal(request.path,root+'\\src\\report.pdf');
        assert.equal(request.workingTree,true);
        assert.equal(request.version,snapshot?'pdf-1':undefined);
        return route.fulfill({contentType:'application/pdf',body:'%PDF-1.4\n%%EOF'});
      }
      if (path.includes('/api/')) return route.fulfill({json:{native:true, items:[],projects:[],models:[]}});
      return route.fulfill({path:directory + path});
    });
    await page.goto(origin + base + '/');
    await page.getByRole('button',{name:'选择远程项目',exact:true}).tap();
    const projectSearch=page.getByRole('searchbox',{name:'搜索项目'});
    await projectSearch.fill('older-project');
    await page.locator('#dialog').getByRole('button',{name:'older-project',exact:true}).waitFor();
    await projectSearch.fill('missing-project');
    await page.getByText('没有匹配的项目。',{exact:true}).waitFor();
    await projectSearch.fill('');
    await page.locator('#dialog [data-project-option]').first().tap();
    await page.getByRole('button',{name:'切换侧面板',exact:true}).tap();
    await page.locator('#work-tabs').getByRole('button',{name:'文件资源管理器',exact:true}).tap();
    await page.locator('.project-explorer-tree summary').filter({hasText:'src'}).tap();
    const directDownload=page.waitForEvent('download');
    await page.getByRole('button',{name:'下载 report.pdf',exact:true}).tap();
    const directFile=await directDownload;
    assert.equal(directFile.suggestedFilename(),'report.pdf');
    assert.equal(await readFile((await directFile.path())!,'utf8'),'%PDF-1.4\n%%EOF');
    assert.equal(snapshot,undefined);
    await page.evaluate(()=>{
      Object.assign(window,{ReceiverFiles:{save:(name:string,mime:string,payload:string)=>{
        sessionStorage.setItem('savedFile',JSON.stringify({name,...JSON.parse(payload)}));
        Reflect.get(window,'receiverDownloadChanged')({id:'test-download',name,phase:'receiving',message:'50 / 100 B',bytes:50,total:100});
      },openSaved:(id:string)=>sessionStorage.setItem('openedDownload',id)}});
    });
    await page.getByRole('button',{name:'下载 report.pdf',exact:true}).tap();
    const saved=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('savedFile')!));
    assert.deepEqual(saved,{name:'report.pdf',root,path:root+'\\src\\report.pdf',workspace:root,workingTree:true});
    assert.equal(await page.getByRole('progressbar',{name:'下载进度'}).getAttribute('value'),'50');
    await page.evaluate(()=>Reflect.get(window,'receiverDownloadChanged')({id:'test-download',name:'report.pdf',phase:'done',message:'已保存',bytes:0,total:-1}));
    await page.getByRole('button',{name:'打开文件',exact:true}).tap();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('openedDownload')),'test-download');
    await page.getByRole('button',{name:'完成',exact:true}).tap();
    await page.getByRole('button',{name:'note.txt',exact:true}).tap();
    await page.locator('.project-explorer-reader pre').waitFor();
    assert.equal(await page.locator('.project-explorer-reader pre').innerText(),'今天的工作区内容 <b>文本</b>');
    assert.deepEqual(snapshot,{root,path:root + '\\src\\note.txt',workspace:root,workingTree:true});
    await page.reload();
    await page.locator('.project-explorer-reader pre').waitFor();
    await page.getByRole('button',{name:'返回文件列表',exact:true}).tap();
    assert(await page.getByRole('button',{name:'note.txt',exact:true}).isVisible());
    await page.getByRole('button',{name:'art.png',exact:true}).tap();
    await page.waitForFunction(()=> (document.querySelector('.project-image') as HTMLImageElement)?.naturalWidth>0);
    await page.getByRole('button',{name:'返回文件列表',exact:true}).tap();
    await page.getByRole('button',{name:'report.pdf',exact:true}).tap();
    const downloaded=page.waitForEvent('download');
    await page.getByRole('button',{name:'保存文件',exact:true}).tap();
    assert.equal((await downloaded).suggestedFilename(),'report.pdf');
    await page.getByRole('button',{name:'返回文件列表',exact:true}).tap();
    await page.getByRole('button',{name:'README.MD',exact:true}).tap();
    const preview=page.locator('.project-markdown');
    await preview.getByRole('heading',{name:'说明'}).waitFor();
    assert(await preview.getByRole('checkbox').isChecked());
    assert(await preview.getByRole('checkbox').isDisabled());
    assert.equal(await preview.locator('td').first().innerText(),'示例');
    assert.equal(await preview.locator('code').textContent(),'const a = 1;\n');
    assert.equal(await preview.locator('b').count(),0);
    await page.getByRole('button',{name:'查看 Markdown 源码'}).tap();
    assert.equal(await page.locator('pre.snapshot-code:visible').innerText(),markdown);
    await page.getByRole('button',{name:'查看 Markdown 预览'}).tap();
    await preview.getByText('查看正文').tap();
    await page.locator('.snapshot-code mark').waitFor();
    await page.locator('#work-hide').tap();
    await page.locator('#prompt').fill('读取已选文件');
    await page.locator('#attach-menu').tap();
    await page.getByRole('menuitem',{name:'添加远程文件'}).tap();
    await page.getByRole('textbox',{name:'项目内的相对路径'}).fill('src/note.txt');
    await page.getByRole('button',{name:'添加路径'}).tap();
    await page.getByRole('button',{name:'选择远程项目',exact:true}).tap();
    await page.locator('#dialog').getByRole('button',{name:/第二项目/}).tap();
    assert.equal(await page.locator('#prompt').inputValue(),'读取已选文件');
    assert.match(await page.locator('#attachment .chip').getAttribute('title')||'',/C:\\dev\\demo\\src\\note\.txt$/);
    const newProjectChat=page.getByRole('button',{name:'在 第二项目 中新建任务'});
    const projectFolder=newProjectChat.locator('..').locator('.project-row svg');
    assert.equal(await projectFolder.count(),1);
    assert.equal(await projectFolder.evaluate(icon=>getComputedStyle(icon).opacity),'1');
    assert.equal(await newProjectChat.evaluate(button=>getComputedStyle(button).opacity),'1');
    await newProjectChat.tap();
    assert.equal(await page.locator('#attachment .chip').count(),0);
    assert.equal(await page.locator('#prompt').inputValue(),'');
  } finally { await browser.close() }
});

test('fixed tabs open project files and side chat, with search available from the file explorer', async () => {
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
    let allowedPorts:number[]=[];
    const childThread='00000000-0000-4000-8000-000000000012';
    let sideJob='',sideComplete=false,sideSubmissions=0;
    let progressText='侧边处理中\n\n```ts\nlet value = 1;\n```';
    const sideReply='侧边回复\n\n```ts\nconst count = 1;\n```\n\n[查看项目文件](src/note.txt#L2)';
    await page.addInitScript(({scope,root,thread,project,messages})=>{
      const chat={id:thread,thread,cwd:root,projectId:project.id,messages,draft:'保留草稿',files:[],title:'已有聊天',updated:Date.now()};
      localStorage.setItem('receiver:'+scope+':tim-ser-chats-v2',JSON.stringify({active:chat.id,chats:[chat],hostProjects:[project]}));
    },{scope,root,thread,project,messages});
    await page.route(proxy+'/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'QA Web app <input aria-label="备注">'}));
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
        return route.fulfill({json:{source:'working-tree',text:'项目文件内容\n'.repeat(180)}});
      }
      if(path===base+'/api/web-preview/ports')return route.fulfill({json:{ports:allowedPorts}});
      if(path===base+'/api/thread-fork'){
        const request=route.request().postDataJSON();
        assert.equal(request.thread,thread);assert.equal(request.sideChat,true);
        return route.fulfill({json:{source:thread,thread:childThread}});
      }
      if(path===base+'/api/turn'){
        const request=route.request().postDataJSON();
        assert.equal(request.expectedThread,childThread);assert.equal(request.prompt,'侧边草稿');
        sideSubmissions++;
        sideJob=request.id;
        return route.fulfill({json:{id:sideJob}});
      }
      if(sideJob&&path.startsWith(base+'/api/turn/'+sideJob)){
        const snapshot={id:sideJob,status:sideComplete?'done':'running',thread:childThread,turn:'side-turn',
          progress:{message:progressText},answer:sideComplete?sideReply:''};
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
    const tabs=page.locator('#work-tabs .work-tab');
    assert.deepEqual(await tabs.allTextContents(),['文件资源管理器','侧边聊天']);
    const openSearch=async()=>{
      await page.locator('#work-tabs button').filter({hasText:'文件资源管理器'}).first().tap();
      await page.getByRole('button',{name:'搜索文件或输入 URL',exact:true}).tap()
    };
    await openSearch();
    await box.tap();
    const pending=page.waitForRequest(req=>req.url().endsWith('/api/project-directories')&&req.postDataJSON().relative==='slow');
    await box.fill('slow/obsolete');
    const obsolete=await pending;
    const aborted=page.waitForEvent('requestfailed',req=>req===obsolete);
    await box.fill('note');
    await aborted;
    await page.getByRole('option',{name:'src/note.txt'}).tap();
    await page.locator('.project-explorer-reader pre').waitFor();
    assert.equal(readPath,root+'\\src\\note.txt');
    const fileText=page.locator('.project-explorer-reader pre');
    const scroll=await fileText.evaluate(el=>{el.scrollTop=700;return el.scrollTop});
    assert(scroll>0);
    await page.keyboard.press('Control+Alt+s');
    await page.getByRole('button',{name:'关闭 侧边聊天',exact:true}).tap();
    assert.equal(await fileText.evaluate(el=>el.scrollTop),scroll);
    await openSearch();
    await box.fill('localhost:5174');
    await page.getByRole('option',{name:'http://localhost:5174/'}).tap();
    await page.getByText('主机未允许此端口').waitFor();
    await page.getByRole('button',{name:'刷新端口'}).tap();
    await page.getByText(/主机尚未放行预览端口/).waitFor();
    allowedPorts=[5173];
    await page.getByRole('button',{name:'刷新端口'}).tap();
    await page.getByRole('button',{name:'localhost:5173'}).waitFor();
    await page.getByRole('button',{name:'关闭 浏览器',exact:true}).tap();
    await openSearch();
    await box.fill('localhost:5173/demo?q=1#view');
    await page.getByRole('option',{name:'http://localhost:5173/demo?q=1#view'}).tap();
    await page.frameLocator('iframe[title="主机网页预览"]').getByText('QA Web app').waitFor();
    const previewPage=page.frameLocator('iframe[title="主机网页预览"]');
    await previewPage.getByRole('textbox',{name:'备注'}).fill('未提交的修改');
    await page.getByRole('button',{name:'收起工作区',exact:true}).tap();
    await page.getByRole('button',{name:'显示标签页',exact:true}).tap();
    await tabs.filter({hasText:'文件资源管理器'}).tap();
    await page.locator('#work-tabs .work-tab').filter({hasText:'浏览器'}).tap();
    assert.equal(await previewPage.getByRole('textbox',{name:'备注'}).inputValue(),'未提交的修改');
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
    await page.getByRole('button',{name:'新建侧边聊天',exact:true}).tap();
    const sideDraft=page.getByRole('textbox',{name:'在侧边聊天中提问'});
    await page.setViewportSize({width:600,height:900});
    await sideDraft.waitFor();
    assert(await page.locator('#prompt').isHidden(),'fullscreen panel hides the main composer');
    await page.locator('#prompt').evaluate(input=>input.focus());
    assert.equal(await page.locator('#prompt').evaluate(input=>input===document.activeElement),false);
    await page.locator('#work-hide').tap();
    await page.locator('#prompt').waitFor();
    await page.locator('#home-panel-toggle button').tap();
    await sideDraft.waitFor();
    await page.setViewportSize({width:820,height:900});
    await page.locator('#prompt').waitFor();
    for(const command of ['/side','/side 帮我看看']){
      await sideDraft.fill(command);
      await page.locator('.side-chat').getByRole('button',{name:'发送',exact:true}).tap();
      await page.locator('#toast').getByText('侧边聊天中无法使用 /side。请先返回主聊天',{exact:true}).waitFor();
      assert.equal(await sideDraft.inputValue(),command);
      assert.equal(sideSubmissions,0);
    }
    // WebView 83 drops :has() selectors. Shrink the available height as an IME would.
    await page.evaluate(()=>{
      for(const sheet of document.styleSheets)for(const rule of Array.from(sheet.cssRules)){
        if(rule instanceof CSSStyleRule&&rule.selectorText.includes('#work-detail:has('))rule.selectorText=':not(*)';
      }
    });
    await page.setViewportSize({width:820,height:440});
    const sideSend=page.locator('.side-chat button[type=submit]');
    const sendBounds=await sideSend.boundingBox(),panelBounds=await page.locator('#workbench').boundingBox();
    assert(sendBounds&&panelBounds);
    const gap=panelBounds.y+panelBounds.height-sendBounds.y-sendBounds.height;
    assert(gap>=0&&gap<40,'side chat send button stays at the bottom of the resized panel');
    await page.setViewportSize({width:820,height:900});
    await sideDraft.fill('侧边草稿');
    await page.keyboard.press('Alt+l');
    assert(await page.locator('#prompt').evaluate(field=>document.activeElement===field));
    assert.equal(await sideDraft.inputValue(),'侧边草稿');
    const tabCount=await page.locator('#work-tabs .work-tab').count();
    await page.locator('#work-hide').tap();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('button',{name:'聚焦侧边聊天',exact:true}).tap();
    assert.equal(await page.locator('#work-tabs .work-tab').count(),tabCount);
    assert.equal(await sideDraft.inputValue(),'侧边草稿');
    assert(await sideDraft.evaluate(field=>document.activeElement===field));
    await page.keyboard.press('Control+Alt+s');
    assert.equal(await sideDraft.inputValue(),'');
    assert.equal(await tabs.count(),tabCount+1);
    assert(await sideDraft.evaluate(field=>document.activeElement===field));
    await sideDraft.fill('关闭后仍保留的草稿');
    await page.getByRole('button',{name:'关闭 侧边聊天 2',exact:true}).tap();
    assert.equal(await sideDraft.inputValue(),'侧边草稿');
    await page.locator('#header-summary').tap();
    await page.locator('#work-detail').getByRole('button',{name:'侧边聊天 2',exact:true}).tap();
    assert.equal(await sideDraft.inputValue(),'关闭后仍保留的草稿');
    await page.getByRole('button',{name:'关闭 侧边聊天 2',exact:true}).tap();
    assert.equal(await page.locator('#prompt').inputValue(),'保留草稿');
    await page.keyboard.press('Control+k');
    await page.getByRole('textbox',{name:'查找命令'}).fill('侧边聊天');
    const sideCommand=page.getByRole('dialog').getByRole('button',{name:'打开侧边聊天',exact:true});
    assert.equal(await sideCommand.locator('small').innerText(),'Ctrl+Alt+S');
    await sideCommand.tap();
    assert.equal(await sideDraft.inputValue(),'');
    await page.getByRole('button',{name:'关闭 侧边聊天 2',exact:true}).tap();
    await tabs.filter({hasText:/^侧边聊天$/}).tap();
    assert.deepEqual((await tabs.allTextContents()).slice(0,2),['文件资源管理器','侧边聊天']);
    assert.equal(await sideDraft.inputValue(),'侧边草稿');
    await page.locator('.side-chat').getByRole('button',{name:'发送',exact:true}).tap();
    await page.locator('.side-chat-history').getByText('侧边处理中',{exact:true}).waitFor();
    const liveSide=page.locator('.side-chat-history');
    await liveSide.getByRole('button',{name:'换行'}).tap();
    const originalCode=await liveSide.locator('pre code').elementHandle();
    const selectedCode=await originalCode!.evaluate(code=>{
      const range=document.createRange();range.selectNodeContents(code.firstChild!);
      const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);return selection.toString()
    });
    progressText+='\n\n后续段落';
    await liveSide.getByText('后续段落',{exact:true}).waitFor();
    assert(await originalCode!.evaluate(code=>code.isConnected&&code.parentElement?.classList.contains('wrapped')));
    assert.equal(selectedCode.trim(),'let value = 1;');
    assert.equal(await page.evaluate(()=>window.getSelection()?.toString()),selectedCode);
    await page.locator('.work-tab-wrap').filter({has:page.locator('.work-tab[aria-pressed="true"]')}).getByRole('button',{name:/^关闭 /}).tap();
    await page.locator('#work-hide').tap();
    await page.reload();
    sideComplete=true;
    await page.waitForFunction(key=>{
      const owner=JSON.parse(localStorage.getItem(key)||'{}');
      return owner.sideChats?.some((chat:{messages:{text:string}[]})=>chat.messages.some(m=>m.text?.startsWith('侧边回复')));
    },'receiver:'+scope+':tim-ser-chat-record:'+thread,{timeout:5000});
    await page.locator('#header-summary').tap();
    const unreadTab=page.getByRole('button',{name:'侧边草稿，未读回复',exact:true});
    await unreadTab.tap();
    await page.locator('.side-chat-history').getByText('侧边回复',{exact:true}).waitFor();
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
    const sideHistory=page.locator('.side-chat-history');
    await sideHistory.getByRole('button',{name:'复制回复',exact:true}).tap();
    const clipboardText=async()=>(await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n');
    assert.equal(await clipboardText(),sideReply);
    await sideHistory.getByRole('button',{name:'复制代码'}).tap();
    assert.equal(await clipboardText(),'const count = 1;\n');
    await sideHistory.getByRole('button',{name:'换行'}).tap();
    assert(await sideHistory.locator('pre.wrapped').isVisible());
    await sideHistory.getByRole('button',{name:'复制消息',exact:true}).tap();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'侧边草稿');
    assert.equal(await unreadTab.count(),0);
    assert.equal(sideSubmissions,1);
    assert.equal(await page.locator('#messages').getByText('侧边回复',{exact:true}).count(),0);
    assert.equal(await page.locator('#prompt').inputValue(),'保留草稿');
    let publishRename!:()=>void;
    const rename=new Promise<void>(resolve=>{publishRename=resolve});
    await page.route(origin+base+'/api/directory-events',async route=>{
      await rename;
      await route.fulfill({contentType:'text/event-stream',body:'event: thread-name\ndata: '+JSON.stringify({thread:childThread,title:'主机上的新标题'})+'\n\n'})
    });
    await page.route(origin+base+'/api/threads',route=>route.request().postDataJSON().thread?route.fallback():route.fulfill({
      json:{items:[{thread:childThread,cwd:root,threadName:'已保存的侧聊标题',title:'已保存的侧聊标题'}],projects:[project]}
    }));
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('#work-tabs .work-tab[aria-pressed=true]')?.getAttribute('title')==='已保存的侧聊标题');
    await sideDraft.fill('保留侧聊草稿');
    publishRename();
    await page.waitForFunction(()=>document.querySelector('#work-tabs .work-tab[aria-pressed=true]')?.getAttribute('title')==='主机上的新标题');
    assert.equal(await sideDraft.inputValue(),'保留侧聊草稿');
    await sideHistory.getByRole('link',{name:'查看项目文件'}).tap();
    await page.locator('.project-explorer-reader mark').waitFor();
    assert.equal(readPath,root+'\\src\\note.txt');
    await tabs.filter({hasText:/^侧边聊天$/}).tap();
    assert.equal(await sideDraft.inputValue(),'保留侧聊草稿');
  } finally { await browser.close() }
});

for(const narrow of [false,true])test('receiver dispatch card and approvals on '+(narrow?'phone':'wide workbench'),async t=>{
  const root=await mkdtemp(join(tmpdir(),'dispatch-workbench-'));
  const assets=fileURLToPath(new URL('../web/',import.meta.url));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const entry of await readdir(assets,{withFileTypes:true})){
    if(entry.isFile())await copyFile(join(assets,entry.name),join(root,entry.name))
  }
  await copyFile(fileURLToPath(new URL('./fixtures/orchestration-transport.mjs',import.meta.url)),join(root,'transport.mjs'));
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const address=socket.address();assert(address&&typeof address==='object');
  const port=address.port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,CODEX_WEB_PORT:String(port),CODEX_RECEIVER_DEVICE_ID:''},windowsHide:true});
  const closed=once(proc,'close');
  // Close the process and browser before releasing their temporary directory.
  const browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'msedge'});
  try{
    const origin='http://127.0.0.1:'+port,scope=createHash('sha256').update('orchestration-fixture').digest('hex');
    const page=await browser.newPage({viewport:{width:narrow?393:1280,height:840},serviceWorkers:'block'});
    page.setDefaultTimeout(12000);
    await page.addInitScript(scope=>{
      const chat={id:'origin',thread:'10000000-0000-4000-8000-000000000001',cwd:'/project',title:'构建',
        draft:'',files:[],messages:[{role:'assistant',text:'检查构建结果'}]};
      localStorage.setItem('receiver:'+scope+':tim-ser-chats-v2',JSON.stringify({active:chat.id,chats:[chat]}))
    },scope);
    const base=origin+'/devices/'+scope;
    await page.goto(base+'/');
    await page.locator('#messages').getByRole('button',{name:/派给另一助手/}).click();
    await page.getByRole('button',{name:'发起委派'}).click();
    const card=page.locator('#dispatch-cards .dispatch-card');
    await card.getByText('待确认',{exact:true}).waitFor();
    const bar=page.locator('#workspace-switcher');
    assert(await bar.getByRole('button',{name:/待确认/}).isVisible());
    if(narrow){
      await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();
      await page.getByRole('button',{name:'活动视图',exact:true}).click();
      await page.locator('#activity-rows').getByRole('button',{name:/待确认/}).click()
    }
    await card.getByRole('button',{name:'批准执行'}).click();
    await card.getByText('等待审批',{exact:true}).waitFor();
    assert(await bar.getByRole('button',{name:/等待审批/}).isVisible());
    await card.getByRole('button',{name:'在右侧查看'}).click();
    const split=page.locator('#workbench .split-session');
    await split.getByText('正在检查构建',{exact:true}).waitFor();
    if(narrow){
      assert(await page.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.locator('#work-hide').click();
      await card.getByRole('button',{name:'停止整条调度'}).click();
      await card.getByText('已停止',{exact:true}).waitFor()
    }else{
      assert((await split.boundingBox())!.x>(await card.boundingBox())!.x);
      await card.getByRole('button',{name:'批准操作'}).click();
      await card.getByText('已回传',{exact:true}).waitFor();
      await page.locator('#messages').getByText('已收到测试回执',{exact:true}).waitFor()
    }
    await page.reload();
    await card.getByText(narrow?'已停止':'已回传',{exact:true}).waitFor()
    if(!narrow){
      const cli=async(...args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,
        ['orchestrator-cli.mjs',...args,'--scope',scope],{cwd:root,env:{...process.env,CODEX_WEB_PORT:String(port)}})).stdout);
      const list=await cli('list','--cwd','/project');
      assert.deepEqual(list.sessions.map((s:{agent:string})=>s.agent).sort(),['antigravity','codex']);
      const task=await cli('dispatch','--cwd','/project','--from-agent','codex','--from-session',list.records[0].from.sessionId,'--objective','CLI 审核');
      const pending=page.locator('.dispatch-card').filter({hasText:'CLI 审核'});
      await pending.getByText('待确认',{exact:true}).waitFor();
      await pending.getByRole('button',{name:'拒绝'}).click();
      assert.equal((await cli('status',task.id)).status,'rejected');
      await page.locator('#header-options').click();await page.locator('#dialog').getByRole('button',{name:'设置',exact:true}).click();
      const saved=page.waitForResponse(res=>res.url().endsWith('/orchestrator/policy')&&res.request().postDataJSON()?.mode==='auto');
      await page.locator('#dispatch-policy').selectOption('auto');assert.equal((await saved).status(),200);
      await page.locator('#dispatch-max-hops').fill('4');
      const limit=page.waitForResponse(res=>res.url().endsWith('/orchestrator/policy')&&res.request().postDataJSON()?.maxHops===4);
      await page.locator('#dispatch-max-hops').press('Tab');assert.equal((await limit).status(),200);
      assert.equal((await cli('list','--cwd','/project')).policy.maxHops,4);
      await page.close();
      const cold=await cli('dispatch','--cwd','/agy-only','--from-agent','antigravity','--from-session','agy-only-source',
        '--objective','检查新项目','--no-return');
      let status=await cli('status',cold.id);
      for(let i=0;i<30&&!['done','failed'].includes(status.status);i++){
        await new Promise(resolve=>setTimeout(resolve,150));status=await cli('status',cold.id)
      }
      assert.equal(status.status,'done',status.summary);assert.equal(status.to.cwd,'/agy-only');
      assert(status.to.sessionId);assert.notEqual(status.to.sessionId,list.records[0].from.sessionId)
    }
  }finally{await browser.close();proc.kill();await closed}
});
