import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAntigravity} from '../apps/receiver/src/antigravity.mts';
import {randomUUID} from 'node:crypto';
import {createOrchestrator} from '../apps/receiver/src/orchestrator.mts';

const cwd='C:\\Repo',from={agent:'antigravity',cwd,sessionId:'source'};
const request={from,to:{agent:'codex'},objective:'检查测试',prompt:'运行测试'};
const block=agent=>'回复\n```orchestrator-dispatch\n'+JSON.stringify({toAgent:agent,objective:'review',prompt:'review'})+'\n```';
async function fixture(t) {
  const stateDir=await mkdtemp(join(tmpdir(),'orchestrator-')),jobs=new Map(),starts=[],answers=[],events=[];
  let threads=[],busy=false,engine;
  function start(data,agent) {
    assert(!jobs.has(data.id),'job submitted twice');
    if(busy && agent==='codex')throw Object.assign(Error('busy'),{code:'SESSION_BUSY'});
    starts.push({...data,agent});
    const sessionId=data.sessionId||randomUUID();
    if(agent==='codex' && !data.sessionId)threads.push({agent,cwd,sessionId});
    jobs.set(data.id,{id:data.id,status:'running',cwd,session:sessionId});
  }
  function status(id) {
    if(!jobs.has(id))throw Object.assign(Error('missing'),{httpStatus:404});
    return jobs.get(id);
  }
  const config={interval:0,stateDir,onEvent:(type,data)=>events.push({type,data}),
    codexBridge:{
      sessions:()=>threads,startTurn:data=>start(data,'codex'),getTurnStatus:status,
      cancelTurn:id=>{status(id).status='interrupted'},
      answerApproval:(id,token,decision)=>{answers.push({id,token,decision});delete status(id).approval}
    },
    antigravity:async(action,body)=>{
      if(action==='submit'){assert.equal(body.queue,true);return start({...body,sessionId:body.session},'antigravity')}
      if(action==='sessions')return {items:[{conversationId:from.sessionId,cwd}]};
      if(action==='status')return status(body.id);
      if(action==='stop'){status(body.id).status='stopped';return}
      assert.fail(action);
    }};
  engine=await createOrchestrator(config);
  t.after(async()=>{await engine.close();await rm(stateDir,{recursive:true,force:true})});
  return {get e(){return engine},starts,jobs,answers,events,
    record:id=>engine.list().records.find(r=>r.id===id),
    async auto(){await engine.policy({mode:'auto'})},
    async restart(){await engine.close();engine=await createOrchestrator(config)},
    busy:value=>{busy=value},archive:()=>{threads=[]}};
}

test('AGY delegates to Codex and receives a bounded structured result on the original session',async t=>{
  const f=await fixture(t);await f.auto();
  const {id}=await f.e.dispatch(request);await f.e.tick();
  const job=f.jobs.get(f.record(id).targetJobId);
  Object.assign(job,{status:'done',answer:'通过',progress:{items:[{type:'commandExecution',exitCode:0}]}});
  await f.e.tick();assert.equal(f.record(id).status,'returning');await f.e.tick();
  assert.equal(f.starts[1].sessionId,'source');
  const receipt=JSON.parse(f.starts[1].prompt.split('\n')[1]);
  assert.equal(receipt.tools[0].exitCode,0);assert.equal(receipt.answer,'通过');
  f.jobs.get(f.record(id).returnJobId).status='done';await f.e.tick();
  assert.equal(f.record(id).status,'done');
});

test('normalized workspace binding is reused across restart and replaced after archival',async t=>{
  const f=await fixture(t);await f.auto();
  const submit=async cwd=>{
    const {id}=await f.e.dispatch({...request,from:{...from,cwd},autoReturn:false});
    await f.e.tick();const job=f.jobs.get(f.record(id).targetJobId);
    job.status='done';await f.e.tick();return job.session;
  };
  const first=await submit(cwd);await f.restart();
  assert.equal(await submit('c:/repo/./'),first);
  assert.equal(f.e.list().bindings.length,1);
  f.archive();assert.notEqual(await submit(cwd),first);
});

test('confirm, reject and stale approvals never launch extra turns',async t=>{
  const f=await fixture(t);
  const a=await f.e.dispatch(request),b=await f.e.dispatch(request);
  await f.e.tick();assert.equal(f.starts.length,0);
  await f.e.approve({id:b.id,decision:'reject'});await f.e.approve({id:a.id,decision:'approve'});
  await assert.rejects(f.e.approve({id:a.id,decision:'approve'}),{httpStatus:409});
  await f.e.tick();assert.equal(f.starts.length,1);assert.equal(f.record(b.id).status,'rejected');
});

test('both ordinary and managed model completions are intercepted once and inherit the hop budget',async t=>{
  const f=await fixture(t);await f.e.policy({mode:'auto',maxHops:2});
  const root={id:randomUUID(),cwd,status:'done',session:'source',text:block('codex')};
  await f.e.observe('antigravity',root);await f.e.observe('antigravity',root);
  assert.equal(f.e.list().records.length,1);
  await f.e.tick();const first=f.e.list().records[0],job=f.jobs.get(first.targetJobId);
  Object.assign(job,{status:'done',text:block('antigravity')});
  await f.e.observe('codex',job);await f.e.tick();
  const child=f.e.list().records[1];assert.equal(child.hop,2);assert.equal(child.chainId,first.id);
  await assert.rejects(f.e.dispatch({...request,parentDispatchId:child.id,from:child.from,to:{agent:'antigravity'}}),{httpStatus:409});
  await f.e.tick();f.jobs.get(f.record(first.id).returnJobId).status='done';await f.e.tick();await f.e.tick();
  const childJob=f.jobs.get(f.record(child.id).targetJobId);
  Object.assign(childJob,{status:'done',text:block('codex')});await f.e.tick();
  assert.equal(f.e.list().records.length,2);assert.match(f.record(child.id).dispatchNotice,/跳数/);
});

test('same workspace queues until the first writer finishes, including busy Codex sessions',async t=>{
  const f=await fixture(t);await f.auto();f.busy(true);
  const [a,b]=await Promise.all([1,2].map(()=>f.e.dispatch({...request,autoReturn:false})));
  await f.e.tick();assert.equal(f.starts.length,0);f.busy(false);await f.e.tick();
  assert.equal(f.starts.length,1);assert.equal(f.record(b.id).status,'queued');
  f.jobs.get(f.record(a.id).targetJobId).status='done';await f.e.tick();assert.equal(f.starts.length,2);
});

test('runtime approval is forwarded with job and token, including restart while running',async t=>{
  const f=await fixture(t);await f.auto();const {id}=await f.e.dispatch(request);await f.e.tick();
  const job=f.jobs.get(f.record(id).targetJobId);
  job.approval={token:'review',title:'允许修改文件？',detail:'a.ts'};await f.restart();await f.e.tick();
  assert.equal(f.starts.length,1);assert.equal(f.record(id).status,'waiting_approval');
  await assert.rejects(f.e.approve({id,token:'stale',decision:'approve'}),{httpStatus:409});
  await f.e.approve({id,token:'review',decision:'approve'});
  assert.deepEqual(f.answers,[{id:job.id,token:'review',decision:'allow-once'}]);
});

test('chain cancellation survives restart, interrupts target and fences model output and returns',async t=>{
  const f=await fixture(t);await f.auto();const {id}=await f.e.dispatch(request);await f.e.tick();
  const job=f.jobs.get(f.record(id).targetJobId);job.text=block('antigravity');
  await f.e.cancel({id});await f.restart();await f.e.tick();await f.e.tick();
  assert.equal(f.record(id).status,'stopped');assert.equal(job.status,'interrupted');
  assert.equal(f.starts.length,1);assert.equal(f.e.list().records.length,1);
  await assert.rejects(f.e.dispatch({...request,parentDispatchId:id}),{httpStatus:409});
});

test('failure or manual interruption never delivers a receipt',async t=>{
  for(const [status,expected] of [['error','failed'],['interrupted','stopped']]){
    const f=await fixture(t);await f.auto();const {id}=await f.e.dispatch(request);await f.e.tick();
    Object.assign(f.jobs.get(f.record(id).targetJobId),{status,text:block('antigravity')});await f.e.tick();
    assert.equal(f.record(id).status,expected);assert.equal(f.starts.length,1);
  }
});


test('a persisted ACP queue reattaches after restart and respects the predecessor outcome',async t=>{
  for(const outcome of ['done','stopped']){
    const dir=await mkdtemp(join(tmpdir(),'orchestrator-queue-'));
    t.after(()=>rm(dir,{force:true,recursive:true}));
    const folder=join(dir,'antigravity');await mkdir(folder);
    const predecessor=randomUUID(),id=randomUUID(),session='worker',sent=[];
    await writeFile(join(folder,predecessor+'.json'),JSON.stringify({id:predecessor,session,status:outcome}));
    await writeFile(join(folder,id+'.json'),JSON.stringify({id,cwd,session,text:'',prompt:'check',
      orchestrated:true,status:'queued',afterJobId:predecessor}));
    let stream;
    const acp={call:async()=>({}),loadSessionDetails:async()=>({running:false,events:[]}),
      sessionModes:async()=>({currentModeId:'ask',availableModes:[{id:'ask'}]}),
      openStream:async(_,fn)=>{stream=fn;return {close:async()=>{}}},
      prompt:async(_,text)=>{sent.push(text);stream({frame:{method:'session/update',params:{update:{sessionUpdate:'prompt_completed'}}}})}
    };
    const agy=createAntigravity(async()=>({antigravity:acp}),pathToFileURL(dir+sep));
    let job;
    for(let retry=0;retry<100;retry++){
      job=await agy('status',{id});if(['done','paused'].includes(job.status))break;
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(job.status,outcome==='done'?'done':'paused');assert.deepEqual(sent,outcome==='done'?['check']:[])
  }
});

test('rejects invalid policies, cross-project routing and prompts exceeding the byte limit',async t=>{
  const {e}=await fixture(t);
  await assert.rejects(e.policy({maxHops:0}),{httpStatus:400});
  await assert.rejects(e.dispatch({...request,to:{agent:'codex',cwd:'/unrelated'}}),{httpStatus:400});
  await assert.rejects(e.dispatch({...request,prompt:'文'.repeat(5334)}),{httpStatus:400});
  assert.equal(e.list().records.length,0);
});
