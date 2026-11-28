import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const backend='antigravity';
const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const sessionKey=/^[a-zA-Z0-9_-]{1,256}$/;
const active=job=>job.status==='preparing'||job.status==='running';
function requireValue(condition,message,status=400){
  if(!condition)throw Object.assign(new Error(message),{httpStatus:status});
}
// ACP sends partial updates for the same tool call. Keep its position while
// updating its arguments, result and state, even when other calls interleave.
function toolText(parts){
  if(!Array.isArray(parts))return '';
  return parts.map(part=>{
    if(part.type==='diff')return [part.path,part.oldText&&'- '+part.oldText,part.newText&&'+ '+part.newText].filter(Boolean).join('\n');
    const block=part.content||part;
    return block.type==='text'?block.text:'';
  }).filter(Boolean).join('\n');
}
function acceptUpdate(job,u){
  const kind=u.sessionUpdate,rows=job.rows??=[],last=rows.at(-1);
  const text=typeof u.content==='string'?u.content:u.content?.text||u.text||'';
  if(['agent_message_chunk','agent_message'].includes(kind)){
    if(!text)return;
    job.text+=text;job.activity='正在回复…';
    if(last?.role==='assistant')last.text+=text;
    else rows.push({role:'assistant',id:'reply-'+rows.length,text});
  }else if(['agent_thought_chunk','agent_thought'].includes(kind)){
    if(!text)return;
    let item=last?.items?.[0];
    if(item?.type!=='agyThought'){
      const id='thought-'+rows.length;
      item={id,type:'agyThought',title:'思考过程',source:backend,output:''};
      rows.push({role:'activity',id,items:[item]});
    }
    const combined=item.output+text;
    item.truncated ||= combined.length>16384;item.output=combined.slice(-16384);
    job.activity='正在思考…';
  }else if(kind==='plan'&&Array.isArray(u.entries)){
    const steps=u.entries.map(e=>({step:e.content,status:e.status==='in_progress'?'inProgress':e.status}));
    let plan=rows.find(r=>r.role==='steps');
    if(!plan){plan={id:'plan',role:'steps'};rows.push(plan)}
    plan.steps=steps;job.activity=steps.find(e=>e.status==='inProgress')?.step||'正在更新计划…';
  }else if(kind==='usage_update'&&Number.isFinite(u.used)&&u.size>0){
    job.usage={total:u.used,contextWindow:u.size};
  }else if(['tool_call','tool_call_update'].includes(kind)&&typeof u.toolCallId==='string'){
    const id=u.toolCallId;
    let item=rows.find(r=>r.role==='activity'&&r.items[0].id===id)?.items[0];
    if(!item){
      item={id,source:backend,type:'dynamicToolCall',status:'inProgress',title:'工具调用'};
      rows.push({role:'activity',id,items:[item]});
    }
    const args=u.rawInput??u.args;
    if(args!==undefined){
      const raw=typeof args==='string'?args:JSON.stringify(args);
      item.input=raw.slice(0,4096);
      if(args?.CommandLine)item.type='commandExecution';
    }
    if(u.kind==='execute')item.type='commandExecution';
    if(u.title||u.name)item.title=String(u.title||u.name).slice(0,512);
    if(u.locations?.length)item.locations=u.locations.map(l=>l.path).filter(Boolean).slice(0,12);
    if(u.status)item.status=({pending:'pending',in_progress:'inProgress',completed:'completed',failed:'failed'})[u.status]||u.status;
    const raw=u.rawOutput;
    const result=toolText(u.content)||raw?.output||(typeof raw==='string'?raw:raw?JSON.stringify(raw,null,2):'');
    if(typeof result==='string'&&result){item.output=result.slice(-16384);item.truncated=result.length>16384}
    if(Number.isInteger(u.rawOutput?.exit_code))item.exitCode=u.rawOutput.exit_code;
    job.activity=item.title;
  }
}
function messages(events){
  const rows=[];
  let turn=0,job;
  function finish(){
    if(job)rows.push(...job.rows.map(row=>({...row,turn:String(turn)})));
    job=null;
  }
  for(const {event} of events){
    const data=event?.data||{},message=data.message||data,content=message.content||[];
    if(event?.type==='user/message'){
      finish();turn++;
      rows.push({role:'user',text:content.filter(p=>p.type==='text').map(p=>p.text).join(''),
        images:content.filter(p=>p.type==='image'&&p.data&&p.mimeType).map(p=>'data:'+p.mimeType+';base64,'+p.data)});
      continue;
    }
    job??={rows:[],text:''};
    if(event?.type==='assistant/message'){
      for(const p of content)if(p.type==='text'||p.type==='reasoning')
        acceptUpdate(job,{sessionUpdate:p.type==='text'?'agent_message_chunk':'agent_thought_chunk',content:p});
    }else if(event?.type==='tool/call'){
      let args=data.arguments;try{args=JSON.parse(args)}catch{}
      acceptUpdate(job,{sessionUpdate:'tool_call',toolCallId:data.callId,title:data.name,args});
    }else if(event?.type==='tool/result'){
      for(const p of content)if(p.type==='tool-result')acceptUpdate(job,{sessionUpdate:'tool_call_update',
        toolCallId:p.toolCallId||message.source?.callId,status:p.isError?'failed':'completed',content:p.content});
    }
  }
  finish();return rows;
}

export function createAntigravity(openRemote,stateDir,onCompleted=()=>{}){
  const live=new Map(),queued=new Map(),submissions=new Map(),answers=new Map();
  // The host allows only a bounded number of concurrent history transfers.
  const histories=new Map();
  let historyQueue=Promise.resolve();
  const folder=new URL('antigravity/',stateDir);
  const file=id=>new URL(id+'.json',folder);
  async function store(job){
    const temp=new URL(randomUUID()+'.tmp',folder);
    await writeFile(temp,JSON.stringify(job),{mode:0o600});
    await rename(temp,file(job.id));
  }
  async function client(){return (await openRemote()).antigravity}
  function history(acp,session){
    if(histories.has(session))return histories.get(session);
    const pending=historyQueue.then(async()=>{
      for(let attempt=0;;attempt++){
        try{return await acp.loadSessionDetails('acp:'+session,backend)}
        catch(error){
          if(attempt>=3||!(error.code==='RATE_LIMITED'||/too many .*transfers/i.test(error.message)))throw error;
          await delay(250*(attempt+1));
        }
      }
    }).finally(()=>histories.delete(session));
    historyQueue=pending.catch(()=>{});
    histories.set(session,pending);return pending;
  }
  async function read(id){
    requireValue(uuid.test(id),'无效任务');
    if(live.has(id))return live.get(id);
    if(queued.has(id))return queued.get(id).job;
    let job;
    try{job=JSON.parse(await readFile(file(id),'utf8'))}
    catch(error){if(error.code==='ENOENT')return null;throw error}
    if(live.has(id))return live.get(id);
    if(queued.has(id))return queued.get(id).job;
    if(job.status==='running'&&job.session){
      job.approval=null;live.set(id,job);
      void run(job,null).catch(error=>console.error('Antigravity recovery failed',error.message));
    }else if(job.status==='queued'&&job.orchestrated){
      // The queued prompt has not been submitted to ACP. Reattach its predecessor
      // first so a stopped/failed predecessor cannot silently release this turn.
      const entry={job,parts:[],stored:Promise.resolve()};
      queued.set(id,entry);
      let prior;
      try{prior=await read(job.afterJobId)}catch(error){queued.delete(id);throw error}
      if(queued.get(id)===entry&&!active(prior||{})){
        await advanceQueue(prior||{id:job.afterJobId},prior?.status==='done'?'done':'error');
        if(!live.has(id))return read(id)
      }
    }else if(active(job)){
      job.status='disconnected';job.approval=null;
      job.error='接收服务已重启，请重新打开主机会话核对执行结果。';
    }else if(job.status==='queued')job.status='paused';
    return job;
  }
  function clearApprovals(job){
    for(const [key,value] of answers)if(value.job===job)answers.delete(key);
    job.approval=null;
  }
  const matchesQueue=(entry,job)=>entry.job.afterJobId===job.id||!!job.session&&entry.job.session===job.session;
  function launch(job,parts,model,mode){
    void run(job,parts,model,mode).catch(error=>console.error('Antigravity task persistence failed',error.message));
  }
  async function advanceQueue(job,finalStatus){
    const entries=[...queued.values()].filter(entry=>matchesQueue(entry,job));
    const preferred=entries.find(entry=>entry.job.id===job.promoteNextId);
    const next=finalStatus==='done'?(preferred||entries[0]):
      finalStatus==='stopped'&&job.promoteNext&&(job.promoteNextId?preferred:entries[0]);
    if(next){
      const turn=next.job;
      queued.delete(turn.id);
      turn.session ||= job.session;
      turn.status='preparing';
      live.set(turn.id,turn);
      for(const entry of entries){
        if(entry===next)continue;
        entry.job.session ||= turn.session;
        entry.job.afterJobId=turn.id;
      }
      try{await next.stored;await store(turn)}catch(error){
        live.delete(turn.id);
        await advanceQueue(turn,'error');
        throw error;
      }
      launch(turn,next.parts,next.model,next.mode);
    }else if(finalStatus==='stopped'||finalStatus==='error'){
      await Promise.all(entries.map(async entry=>{
        queued.delete(entry.job.id);
        await entry.stored;
        await store({...entry.job,status:'paused'});
      }));
    }
  }
  async function run(job,images,model,mode){
    let submitted=images===null,finalStatus;
    try{
      if(!submitted){
        const acp=await client();
        if(job.session){
          for(let attempt=0;;attempt++){
            try{await acp.call('session/load',{backend,sessionId:job.session});break}
            catch(error){
              // The host publishes prompt_completed before releasing the session lock.
              if(!job.afterJobId||error.code!=='PROMPT_IN_PROGRESS'||attempt>=4)throw error;
              await delay(100*(attempt+1));
            }
          }
          const before=await history(acp,job.session);
          requireValue(!before.running,'主机会话已有任务',409);
          job.priorUsers=messages(before.events).filter(m=>m.role==='user').length;
        }else{
          job.session=(await acp.createSession(job.cwd,undefined,backend)).sessionId;
          job.priorUsers=0;
        }
        if(model)await acp.selectModel(job.session,backend,{provider:backend,model});
        if(mode){
          await acp.setMode(job.session,backend,mode);
        }else{
          const modes=await acp.sessionModes(job.session,backend);
          if(modes.currentModeId==='default'&&modes.availableModes.some(item=>item.id==='auto')){
            await acp.setMode(job.session,backend,'auto');
          }
        }
        job.status='running';await store(job);
      }
      for(;;){
        let stream;
        try{
          const acp=await client();
          let resolve;const terminal=new Promise(r=>{resolve=r});
          let ready=submitted;
          stream=await acp.openStream(job.session,({frame})=>{
            if(!ready)return;
            const params=frame.params||{},update=params.update||params;
            if(frame.method==='session/request_permission'&&params.requestHandle){
              const token=randomUUID();
              const approval={token,title:params.toolCall?.title||params.toolName||'操作审批',
                detail:params.reason||JSON.stringify(params.toolCall?.rawInput||{})};
              answers.set(token,{acp,handle:params.requestHandle,job,approval});job.approval??=approval;
            }
            if(frame.method!=='session/update')return;
            if(update.sessionUpdate==='prompt_completed'&&!job.rows?.length&&Array.isArray(update.catchUp)){
              for(const buffered of update.catchUp)if(buffered.method==='session/update'&&buffered.params?.update)acceptUpdate(job,buffered.params.update);
            }
            acceptUpdate(job,update);
            if(update.sessionUpdate==='prompt_completed')resolve(update.stopReason||'end_turn');
            if(update.sessionUpdate==='prompt_failed')resolve({error:update.code||'主机任务失败'});
          },()=>resolve('disconnected'));
          if(!submitted){
            ready=true;submitted=true;
            const result=await acp.prompt(job.session,job.prompt,undefined,images,backend);
            if(result?.stopReason==='cancelled')resolve('cancelled');
          }else{
            const detail=await history(acp,job.session);
            if(detail.running===false){
              const rows=messages(detail.events),index=rows.findLastIndex(row=>row.role==='user');
              const newTurn=job.priorUsers===undefined||rows.filter(row=>row.role==='user').length>job.priorUsers;
              if(newTurn&&index>=0&&rows[index].text===job.prompt&&rows.slice(index+1).some(row=>row.role==='assistant')){
                job.rows=rows.slice(index+1);job.text=job.rows.filter(r=>r.role==='assistant').map(row=>row.text).join('\n');resolve('end_turn');
              }else resolve({error:'主机没有返回本轮完成记录，请查看会话历史。'});
            }
          }
          const outcome=await terminal;
          if(outcome!=='disconnected'){
            if(outcome?.error)throw Error(outcome.error);
            finalStatus=outcome==='cancelled'?'stopped':'done';break;
          }
        }catch(error){
          if(!submitted||!(/DISCONNECT|CONNECTION_CLOSED|RPC_CLOSED|TIMEOUT|TIME[D_ ]OUT|PEER_UNAVAILABLE|SESSION_OWNED|OFFLINE/i.test([error.code,error.message].join(' '))))throw error;
        }finally{
          clearApprovals(job);
          await stream?.close().catch(()=>{});
        }
        job.activity='正在重新连接主机…';
        await delay(2000);
      }
    }catch(error){finalStatus='error';job.error=error.message}
    finally{
      try{
        await store({...job,status:finalStatus});
        live.delete(job.id);
      }catch(error){
        job.status='error';job.error='未能保存主机任务结果：'+error.message;
        throw error;
      }
      if(finalStatus==='done')await onCompleted({...job,status:finalStatus});
      await advanceQueue(job,finalStatus);
    }
  }
  async function submit(body){
    const {id,cwd,prompt,session=null,images=[],model,mode,afterJobId}=body;
    requireValue(typeof id==='string'&&uuid.test(id)&&typeof cwd==='string'&&cwd.trim()&&cwd.length<=4096,'请选择主机上的项目目录');
    requireValue(!session||sessionKey.test(session),'无效会话');
    requireValue(typeof prompt==='string'&&Buffer.byteLength(prompt)<=16000&&Array.isArray(images)&&images.length<=4&&
      images.every(i=>typeof i==='string'&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(i))&&(prompt.trim()||images.length),'消息或图片无效');
    if(submissions.has(id)){await submissions.get(id);return {id}}
    const reservation=(async()=>{
      await mkdir(folder,{recursive:true});
      const existing=await read(id);
      if(existing)return {id};
      const inheritedSession=session||(!session&&body.queue===true&&uuid.test(afterJobId)?(await read(afterJobId))?.session:null)||null;
      const activeJob=[...live.values()].find(j=>active(j)&&((inheritedSession&&j.session===inheritedSession)||(afterJobId&&j.id===afterJobId)));
      if(body.orchestrated&&inheritedSession&&!activeJob){
        const detail=await history(await client(),inheritedSession);
        if(detail.running)throw Object.assign(Error('主机会话正忙'),{code:'SESSION_BUSY',httpStatus:409});
      }
      const job={id,cwd,session:inheritedSession,prompt,text:'',status:'preparing',created:Date.now(),approval:null};
      if(body.orchestrated===true)job.orchestrated=true;
      if(body.queue===true&&afterJobId)job.afterJobId=afterJobId;
      const parts=images.map(url=>({type:'image',mimeType:url.slice(5,url.indexOf(';')),data:url.slice(url.indexOf(',')+1)}));
      if(activeJob&&body.queue===true){
        Object.assign(job,{status:'queued',afterJobId:activeJob.id,session:inheritedSession||activeJob.session||null});
        const stored=store(job);
        queued.set(id,{job,parts,model,mode,stored});
        try{await stored}catch(error){queued.delete(id);throw error}
        return {id,queued:true};
      }
      requireValue(!activeJob,'此会话已有任务',409);
      live.set(id,job);
      try{await store(job)}catch(error){live.delete(id);throw error}
      launch(job,parts,model,mode);
      return {id};
    })();
    submissions.set(id,reservation);
    try{return await reservation}finally{submissions.delete(id)}
  }
  async function activeSessions(paths){
    const host=new Map();
    const signal=AbortSignal.timeout(10000);
    async function collectHostSessions(){
      const acp=await client();
      if(!acp||signal.aborted)return;
      const directories=Array.isArray(paths)?[...new Set(paths.filter(path=>typeof path==='string'&&path.trim()&&path.length<=4096))].slice(0,20):[];
      if(!directories.length)directories.push('');
      await Promise.allSettled(directories.map(async path=>{
        const {items}=await acp.call('dsh/sessionList',{backend,path,limit:100,prewarm:false},signal);
        for(const item of items||[]){
          if(!(item.running===true||item.active===true||item.status==='running'||item.waitingOnApproval===true))continue;
          const session=item.conversationId||item.session;
          if(typeof session!=='string'||!sessionKey.test(session))continue;
          const existing=host.get(session);
          if(existing&&(!item.waitingOnApproval||existing.waitingOnApproval))continue;
          host.set(session,{session,cwd:item.cwd||item.path||path||existing?.cwd||'',title:item.title||'Antigravity 任务',
            running:true,waitingOnApproval:item.waitingOnApproval===true,activity:item.activity||''});
        }
      }));
    }
    try{
      await Promise.race([collectHostSessions(),new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
    }catch{/* Local jobs remain available when the host is disconnected. */}
    const items=[];
    for(const job of live.values()){
      if(!active(job))continue;
      host.delete(job.session);
      items.push({id:job.id,session:job.session||null,cwd:job.cwd,title:(job.prompt||'').trim().slice(0,60)||'Antigravity 任务',
        running:true,waitingOnApproval:!!job.approval,activity:job.activity||''});
    }
    return {items:items.concat([...host.values()])};
  }
  return async function request(action,body={}){
    if(action==='usage'){
      const acp=await client();
      requireValue(acp,'当前主机未提供 Antigravity 用量',503);
      try{return await acp.call('dsh/antigravityUsage',{},AbortSignal.timeout(18000))}
      catch{throw Object.assign(Error('无法读取主机 Antigravity CLI 用量，可稍后刷新'),{httpStatus:503})}
    }
    if(action==='active')return activeSessions(body?.paths);
    const {session,cwd,id}=body;
    if(action==='submit')return submit(body);
    if(action==='status'){const job=await read(id);requireValue(job,'找不到任务',404);return job}
    if(action==='cancel-queued'){
      const entry=queued.get(id);
      requireValue(entry,'该消息已开始发送',409);
      queued.delete(id);
      await entry.stored;
      await store({...entry.job,status:'cancelled'});
      return {ok:true};
    }
    if(action==='availability'){
      const description=await (await openRemote()).probe();
      return {available:description.workspaceTypes?.find(type=>type.id===backend)?.available??
        description.capabilities?.includes('agent.acp.antigravity.v1')??false};
    }
    if(action==='answer'){
      const entry=answers.get(body.token);
      requireValue(entry&&entry.job.id===id&&!entry.sending&&entry.job.approval?.token===body.token,'审批已关闭',409);
      requireValue(['allow-once','reject-once'].includes(body.decision),'无效决定');
      entry.sending=true;
      try{await entry.acp.respond(entry.handle,body.decision);answers.delete(body.token);
        entry.job.approval=[...answers.values()].find(next=>next.job===entry.job)?.approval||null}
      finally{entry.sending=false}
      return {ok:true};
    }
    const acp=await client();
    if(action==='stop'||action==='interrupt-next'){
      const job=live.get(id);requireValue(job?.session&&job.status==='running','任务当前无法停止',409);
      if(action==='interrupt-next'){
        job.promoteNext=true;
        job.promoteNextId=body.nextId;
      }
      await acp.cancel(job.session);return {ok:true};
    }
    if(action==='workspaces')return acp.call('dsh/workspaceList',{backend});
    if(action==='workspace'){
      requireValue(typeof cwd==='string'&&cwd.length>0&&cwd.length<=4096,'请输入项目目录');
      return acp.createWorkspace(cwd,backend);
    }
    if(action==='session'){
      requireValue(typeof cwd==='string'&&cwd.trim()&&cwd.length<=4096,'请选择项目目录');
      return acp.createSession(cwd,undefined,backend);
    }
    if(action==='sessions'){
      requireValue(typeof cwd==='string'&&cwd.length<=4096,'目录无效');
      return acp.call('dsh/sessionList',{backend,path:cwd,limit:100,prewarm:false});
    }
    requireValue(typeof session==='string'&&sessionKey.test(session),'会话无效');
    if(action==='history'){
      const detail=await history(acp,session);
      return {messages:messages(detail.events),running:detail.running};
    }
    if(action==='options'){
      await acp.call('session/load',{backend,sessionId:session});
      const [models,modes]=await Promise.all([acp.sessionModels(session,backend),acp.sessionModes(session,backend)]);
      return {models,modes};
    }
    throw Object.assign(Error('未知操作'),{httpStatus:404});
  };
}
