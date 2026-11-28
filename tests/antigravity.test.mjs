import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createAntigravity} from '../apps/receiver/src/antigravity.mts';
import {readAntigravityUsage} from '../scripts/host-compat/antigravity-usage.mjs';

async function fixture(t,acp){
  const path=await mkdtemp(join(tmpdir(),'receiver-acp-'));
  t.after(()=>rm(path,{recursive:true,force:true}));
  const antigravity={sessionModes:async()=>({availableModes:[]}),...acp};
  return createAntigravity(async()=>({antigravity}),pathToFileURL(path+sep));
}

async function waitForJob(request,id,condition){
  for(let n=0;n<500;n++){
    const job=await request('status',{id});
    if(condition(job))return job;
    await delay(10);
  }
  assert.fail('Timed out waiting for the Antigravity job');
}

async function queueFixture(t){
  const session='queue-session',prompts=[];
  let stream,ongoing=false,releasing=false;
  function update(update){stream({frame:{method:'session/update',params:{update}}})}
  function finish(stopReason='end_turn'){
    assert(ongoing);
    ongoing=false;releasing=true;
    update({sessionUpdate:'prompt_completed',stopReason});
  }
  const request=await fixture(t,{
    createSession:async()=>({sessionId:session}),
    call:async(method,body)=>{
      assert.equal(method,'session/load');assert.equal(body.sessionId,session);
      if(releasing){releasing=false;throw Object.assign(Error('Host still holds the completed turn'),{code:'PROMPT_IN_PROGRESS'})}
    },
    loadSessionDetails:async()=>({events:[],running:ongoing}),
    openStream:async(id,callback)=>{assert.equal(id,session);stream=callback;return {close:async()=>{}}},
    prompt:async(id,text)=>{
      assert(!ongoing);assert.equal(id,session);ongoing=true;prompts.push(text);
      update({sessionUpdate:'agent_message_chunk',content:{text:'Reply to '+text}});
      return {stopReason:'in_progress'};
    },
    cancel:async id=>{assert.equal(id,session);finish('cancelled')}
  });
  const body=prompt=>({id:crypto.randomUUID(),cwd:'/project',prompt});
  const first=body('first');await request('submit',first);
  await waitForJob(request,first.id,job=>job.text);
  const follow=prompt=>({...body(prompt),queue:true,afterJobId:first.id});
  return {request,first,follow,session,prompts,finish};
}

test('queued prompts wait, inherit the session and advance in order',async t=>{
  const {request,first,follow,session,prompts,finish}=await queueFixture(t);
  const next=follow('second'),last={...follow('third'),session};
  assert.deepEqual(await request('submit',next),{id:next.id,queued:true});
  assert.deepEqual(await request('submit',next),{id:next.id});
  await request('submit',last);
  const waiting=await request('status',{id:next.id});
  assert.equal(waiting.status,'queued');assert.equal(waiting.afterJobId,first.id);
  assert.deepEqual(prompts,['first']);
  finish();
  const running=await waitForJob(request,next.id,j=>j.text);
  assert.equal(running.status,'running');assert.equal(running.session,session);
  assert.equal((await request('status',{id:last.id})).status,'queued');
  finish();
  assert.equal((await waitForJob(request,next.id,j=>j.status==='done')).text,'Reply to second');
  await waitForJob(request,last.id,j=>j.text);finish();
  await waitForJob(request,last.id,j=>j.status==='done');
  const late={...follow('late'),afterJobId:last.id};
  assert.deepEqual(await request('submit',late),{id:late.id});
  assert.equal((await waitForJob(request,late.id,j=>j.text)).session,session);
  finish();await waitForJob(request,late.id,j=>j.status==='done');
  assert.deepEqual(prompts,['first','second','third','late']);
});

test('cancel-queued removes a waiting prompt and rejects cancellation after dispatch',async t=>{
  const {request,follow,prompts,finish}=await queueFixture(t);
  const removed=follow('removed'),next=follow('second');
  await request('submit',removed);await request('submit',next);
  assert.deepEqual(await request('cancel-queued',{id:removed.id}),{ok:true});
  assert.equal((await request('status',{id:removed.id})).status,'cancelled');
  finish();await waitForJob(request,next.id,j=>j.text);
  await assert.rejects(request('cancel-queued',{id:next.id}),{httpStatus:409,message:'该消息已开始发送'});
  assert.deepEqual(prompts,['first','second']);
  finish();await waitForJob(request,next.id,j=>j.status==='done');
});

test('interrupt-next selects the requested prompt and a normal stop pauses the remainder',async t=>{
  const {request,first,follow,session,prompts}=await queueFixture(t);
  const earlier=follow('first in queue'),selected=follow('send now');
  await request('submit',earlier);await request('submit',selected);
  await request('interrupt-next',{id:first.id,nextId:selected.id});
  await waitForJob(request,first.id,j=>j.status==='stopped');
  assert.equal((await waitForJob(request,selected.id,j=>j.text)).session,session);
  await request('stop',{id:selected.id});
  await waitForJob(request,selected.id,j=>j.status==='stopped');
  await waitForJob(request,earlier.id,j=>j.status==='paused');
  assert.deepEqual(prompts,['first','send now']);
});

test('duplicate submissions share one native turn and permission decisions are bound to its job',async t=>{
  let prompts=0,reply,choice,model,mode,parts;
  const acp={
    createSession:async()=>({sessionId:'native-chat'}),
    selectModel:async(_,backend,selection)=>{model=selection.model;assert.equal(backend,'antigravity')},
    setMode:async(_session,_backend,value)=>{mode=value},
    openStream:async(_session,callback)=>{reply=callback;return {close:async()=>{}}},
    prompt:async(_session,_text,_signal,images)=>{
      prompts++;parts=images;
      reply({frame:{method:'session/request_permission',params:{requestHandle:'native-handle',toolName:'Shell'}}});
      return {stopReason:'in_progress'};
    },
    respond:async(handle,value)=>{assert.equal(handle,'native-handle');choice=value},
    cancel:async()=>reply({frame:{method:'session/update',params:{update:{sessionUpdate:'prompt_completed',stopReason:'cancelled'}}}})
  };
  const request=await fixture(t,acp),id=crypto.randomUUID();
  const body={id,cwd:'/project',prompt:'describe',images:['data:image/png;base64,AA=='],model:'selected-model',mode:'selected-mode'};
  await Promise.all([request('submit',body),request('submit',body)]);
  const job=await waitForJob(request,id,j=>j.approval);
  assert.equal(model,body.model);assert.equal(mode,body.mode);
  assert.deepEqual(parts,[{type:'image',mimeType:'image/png',data:'AA=='}]);
  const decision={id,token:job.approval.token,decision:'reject-once'};
  await assert.rejects(request('answer',{...decision,id:crypto.randomUUID()}),/审批已关闭/);
  await request('answer',decision);assert.equal(choice,'reject-once');
  await assert.rejects(request('answer',decision),/审批已关闭/);
  await request('stop',{id});
  await waitForJob(request,id,j=>j.status==='stopped');
  await request('submit',body);assert.equal(prompts,1);
});

test('a lost prompt acknowledgement reconciles the host history without sending again',async t=>{
  let prompts=0;
  let mode='default';
  const acp={
    createSession:async()=>({sessionId:'lost-ack-session'}),
    sessionModes:async()=>({currentModeId:mode,availableModes:[{id:'default'},{id:'auto'}]}),
    setMode:async(_session,_backend,value)=>{mode=value},
    openStream:async()=>({close:async()=>{}}),
    prompt:async()=>{assert.equal(mode,'auto');prompts++;throw Object.assign(Error('peer disconnected'),{code:'PEER_DISCONNECTED'})},
    loadSessionDetails:async()=>({running:false,events:[
      {event:{type:'user/message',data:{content:[{type:'text',text:'check'}]}}},
      {event:{type:'assistant/message',data:{content:[{type:'text',text:'confirmed'}]}}}
    ]})
  };
  const request=await fixture(t,acp),id=crypto.randomUUID();
  await request('submit',{id,cwd:'/project',prompt:'check'});
  const result=await waitForJob(request,id,j=>j.status==='done');
  assert.equal(result.text,'confirmed');assert.equal(prompts,1);
});

test('active merges host sessions with live jobs and tracks approval and completion',async t=>{
  let receive,offline=false;
  const paths=[];
  const acp={
    createSession:async()=>({sessionId:'local-session'}),
    openStream:async(_session,callback)=>{receive=callback;return {close:async()=>{}}},
    prompt:async()=>({stopReason:'in_progress'}),
    call:async(method,{path,backend,prewarm})=>{
      assert.equal(method,'dsh/sessionList');assert.equal(backend,'antigravity');assert.equal(prewarm,false);
      paths.push(path);
      if(offline)throw Error('Host disconnected');
      return {items:[
        {conversationId:'local-session',title:'Host duplicate',running:true},
        {conversationId:'host-session',title:'Host task',cwd:'/project',running:true},
        {conversationId:'idle-session',title:'Idle',running:false}
      ]};
    }
  };
  const request=await fixture(t,acp),id=crypto.randomUUID();
  await request('submit',{id,cwd:'/project',prompt:'   Local task   '});
  await waitForJob(request,id,job=>job.status==='running'&&receive);
  const status=()=>request('active',{paths:['/project','/project']});
  assert.deepEqual((await status()).items,[
    {id,session:'local-session',cwd:'/project',title:'Local task',running:true,waitingOnApproval:false,activity:''},
    {session:'host-session',cwd:'/project',title:'Host task',running:true,waitingOnApproval:false,activity:''}
  ]);
  assert.deepEqual(paths,['/project']);
  receive({frame:{method:'session/request_permission',params:{requestHandle:'handle'}}});
  offline=true;
  const {items}=await status();
  assert.equal(items.length,1);assert.equal(items[0].id,id);assert.equal(items[0].waitingOnApproval,true);
  receive({frame:{method:'session/update',params:{update:{sessionUpdate:'prompt_completed',stopReason:'end_turn'}}}});
  await waitForJob(request,id,job=>job.status==='done');
  assert.deepEqual(await status(),{items:[]});
  offline=false;
  assert.deepEqual((await request('active')).items.map(({session,id})=>[session,id]),
    [['local-session',undefined],['host-session',undefined]]);
  assert.equal(paths.at(-1),'');
});
test('Antigravity preserves ordered reply blocks, thought chunks, plan revisions and partial tool updates',async t=>{
  let update;
  const acp={
    createSession:async()=>({sessionId:'ordered'}),
    openStream:async(_,onFrame)=>{update=u=>onFrame({frame:{method:'session/update',params:{update:u}}});return {close:async()=>{}}},
    prompt:async()=>{
      const chunk=(kind,text)=>update({sessionUpdate:kind,content:{type:'text',text}});
      chunk('agent_thought_chunk','Inspect ');chunk('agent_thought_chunk','files');
      chunk('agent_message_chunk','I will check.');
      update({sessionUpdate:'plan',entries:[{content:'Check output',status:'in_progress'}]});
      update({sessionUpdate:'tool_call',toolCallId:'abc',kind:'execute',title:'echo 42',rawInput:{CommandLine:'echo 42'},status:'in_progress'});
      update({sessionUpdate:'usage_update',used:120,size:2000});
      return {stopReason:'in_progress'}
    }
  };
  const request=await fixture(t,acp),id=crypto.randomUUID();
  await request('submit',{id,cwd:'/project',prompt:'Check'});
  const job=await waitForJob(request,id,j=>j.rows?.length===4);
  assert.equal(job.rows[0].items[0].output,'Inspect files');
  assert.deepEqual(job.usage,{total:120,contextWindow:2000});
  assert.equal(job.rows[3].items[0].status,'inProgress');
  update({sessionUpdate:'tool_call_update',toolCallId:'abc',status:'completed',rawOutput:{output:'42',exit_code:0}});
  update({sessionUpdate:'plan',entries:[{content:'Check output',status:'completed'}]});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done.'}});
  update({sessionUpdate:'prompt_completed'});
  const result=await waitForJob(request,id,j=>j.status==='done');
  assert.deepEqual(result.rows.map(r=>r.role),['activity','assistant','steps','activity','assistant']);
  const tool=result.rows[3].items[0];
  assert.equal(tool.title,'echo 42');assert.equal(tool.exitCode,0);assert.equal(tool.output,'42');
  assert.equal(result.rows[2].steps[0].status,'completed');
});
test('native history restores tools to their original position without treating results as user turns',async t=>{
  const events=[
    {type:'user/message',data:{content:[{type:'text',text:'Check'}]}},
    {type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'Checking'},{type:'text',text:'First'}]}}},
    {type:'tool/call',data:{callId:'one',name:'Read a.txt',arguments:'{"path":"a.txt"}'}},
    {type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:'one',isError:true,content:[{type:'text',text:'missing'}]}]}}},
    {type:'assistant/message',data:{message:{content:[{type:'text',text:'Finished'}]}}}
  ].map(event=>({event}));
  const request=await fixture(t,{loadSessionDetails:async()=>({events,running:false})});
  const {messages}=await request('history',{session:'history'});
  assert.deepEqual(messages.map(r=>r.role),['user','activity','assistant','activity','assistant']);
  assert.equal(messages[1].items[0].output,'Checking');
  assert.equal(messages[3].items[0].status,'failed');
  assert.equal(messages[3].items[0].output,'missing');
});
test('quota reads keep independent Antigravity windows and preserve zero remaining', async () => {
  const calls = [];
  const groups = await readAntigravityUsage(async (binary, args, options) => {
    calls.push(args);
    assert.equal(binary, 'agy');
    assert.equal(options.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    if (args[0] === '--version') return {stdout: '1.5.18\n'};
    return {stdout: JSON.stringify({command: {name: 'usage', data: {groups: [
      {name: 'Gemini Models', buckets: [
        {window: '5h', remaining_fraction: 0.5, reset_time: '2026-11-28T16:00:00Z'},
        {window: 'weekly', remaining_fraction: 0},
      ]},
      {name: 'Claude and GPT models', buckets: [
        {window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z'},
        {window: '5h', remaining_fraction: null},
      ]},
    ]}}})};
  }, 'agy', '/project');
  assert.deepEqual(calls, [['--version'], ['--print', '/usage', '--output-format', 'json']]);
  assert.deepEqual(groups.map(group => group.windows.map(window => window.usedPercent)), [[50, 100], [0]]);
  assert.equal(groups[0].windows[0].resetsAt, Date.parse('2026-11-28T16:00:00Z') / 1000);
  assert.equal(groups[1].windows[0].resetsAt, undefined);
  await assert.rejects(readAntigravityUsage(async (_, args) => {
    assert.deepEqual(args, ['--version']);
    return {stdout: '1.1.10'};
  }, 'agy'), /structured quota output/);
});
