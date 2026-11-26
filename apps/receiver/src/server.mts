import { createDeviceDirectory, deviceNameEvent } from './device-directory.mjs';
import {win32,posix} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const moduleUrl=new URL(import.meta.url);
const deviceId=moduleUrl.searchParams.get('device')||process.env.CODEX_RECEIVER_DEVICE_ID;
const transportUrl=new URL('./transport.mjs',import.meta.url);
if(deviceId)transportUrl.searchParams.set('device',deviceId);
const {openRemote,getLastDisconnect,remoteLines,requireReceiverIdentity,listReceiverDevices,bindReceiverDevice}=await import(transportUrl.href);


import {createHash,randomUUID} from 'node:crypto';
import {access, readFile, writeFile, rename, mkdir, link, unlink, stat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {gzipSync,gunzipSync} from 'node:zlib';

const port=Number(process.env.CODEX_WEB_PORT||47831);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('端口无效');
const origin='http://127.0.0.1:'+port;

const deviceContexts=new Map();
const hostDirectory=createDeviceDirectory(listReceiverDevices);
const deviceScope=deviceId?createHash('sha256').update(deviceId).digest('hex'):'';
if(deviceId)bindReceiverDevice(deviceId);
const stateRoot=new URL('./state/',import.meta.url);
const stateDir=deviceScope?new URL('devices/'+deviceScope+'/',stateRoot):stateRoot;
await mkdir(stateDir,{recursive:true});
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const busy=new Set();
const liveJobs=new Map();
const subscribers=new Map();
const directoryListeners=new Set();
let directoryRevision=randomUUID();
function directoryChanged(rename){
  directoryFlight=null;
  directoryRevision=randomUUID();
  for(const res of directoryListeners){
    if(res.writableNeedDrain){res.end();continue}
    if(rename)res.write('event: thread-name\ndata: '+JSON.stringify(rename)+'\n\n');
    res.write('id: '+directoryRevision+'\ndata: changed\n\n')
  }
}
const directoryWaitFlags=new Map();
function notify(job){
  for(const send of subscribers.get(job.id)||[])send(job);
  if(!job.thread)return;
  const requests=job.status==='waiting'?Object.values(job.inputRequests||{}).flat():[];
  const flag=requests.length?(requests.some(q=>q.commandReview||q.fileReview)?'waitingOnApproval':'waitingOnUserInput'):null;
  if((directoryWaitFlags.get(job.thread)||null)===flag)return;
  if(flag)directoryWaitFlags.set(job.thread,flag);
  else directoryWaitFlags.delete(job.thread);
  directoryChanged()
}
function streamJob(res,job){
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
  let latest=job,timer,dirty=true,sentFirstText=false,lastWrite=Date.now();
  const flush=()=>{
    clearTimeout(timer);timer=null;
    if(!dirty||res.destroyed||res.writableEnded||res.writableNeedDrain)return;
    dirty=false;
    if(latest.observedTextAt!=null)sentFirstText=true;
    lastWrite=Date.now();
    res.write('data: '+JSON.stringify(latest)+'\n\n');
    if(!['preparing','waiting'].includes(latest.status))res.end()
  };
  const send=next=>{
    latest=next;dirty=true;
    if(res.writableNeedDrain)return;
    if((!sentFirstText&&next.observedTextAt!=null)||!['preparing','waiting'].includes(next.status))flush();
    else if(!timer)timer=setTimeout(flush,25)
  };
  const listeners=subscribers.get(job.id)||new Set();
  listeners.add(send);subscribers.set(job.id,listeners);
  const heartbeat=setInterval(()=>{
    if(Date.now()-lastWrite>=15000&&!res.writableNeedDrain&&!res.writableEnded&&!res.destroyed){
      res.write('event: heartbeat\ndata: 1\n\n');lastWrite=Date.now()
    }
  },15000);
  res.on('drain',flush);
  res.once('close',()=>{clearInterval(heartbeat);clearTimeout(timer);listeners.delete(send);if(!listeners.size)subscribers.delete(job.id)});
  flush()
}
const freshInputs=new Map();
const stateFile=id=>new URL(id+'.json',stateDir);
async function readStoredJob(id){
  const job=JSON.parse(await readFile(stateFile(id)));
  if(job?.id!==id)throw Error('本轮提交记录标识不匹配');
  return job
}
async function save(job){
  const tmp=new URL(job.id+'-'+randomUUID()+'.tmp',stateDir);
  await writeFile(tmp,JSON.stringify(job),{mode:0o600});
  await rename(tmp,stateFile(job.id));
  if(busy.has(job.id))liveJobs.set(job.id,job);
  notify(job)
}
const androidSubmissions=new Map();
async function persistSubmission(job,input,previous){
  if(process.platform!=='android')return writeSubmission(job,input,previous);
  // The embedded server is the sole writer in this app's private directory.
  const pending=androidSubmissions.get(job.id);
  if(pending){await pending;return false}
  const write=writeSubmission(job,input,previous);
  androidSubmissions.set(job.id,write);
  try{return await write}finally{androidSubmissions.delete(job.id)}
}
async function writeSubmission(job,input,previous){
  const tmp=new URL(job.id+'-'+randomUUID()+'.tmp',stateDir);
  try{
    if(process.platform==='android'){
      try{await access(stateFile(job.id));return false}
      catch(error){if(error.code!=='ENOENT')throw error}
    }
    await writeFile(tmp,JSON.stringify({...job,submission:{input,previous}}),{mode:0o600,flag:'wx'});
    if(process.platform==='android'){await rename(tmp,stateFile(job.id));return true}
    try{await link(tmp,stateFile(job.id));return true}
    catch(error){if(error.code==='EEXIST')return false;throw error}
  }finally{await unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error})}
}
let closingCommands=0;
function command(code,relay=false,onComplete,onLine){
  const lines=[];
  const output=()=>lines.join('\n').trim();
  let finished,closing=false;
  const acknowledged=new Promise(resolve=>{finished=resolve});
  const drain=(async()=>{
    try{
      for await(const line of remoteLines(code,false,relay,(...args)=>{
        onComplete?.(...args);
        if(closingCommands<4){
          closing=true;closingCommands++;finished(output())
        }
      })){
        lines.push(line);onLine?.(line)
      }
      return output()
    }finally{if(closing)closingCommands--}
  })();
  return Promise.race([acknowledged,drain])
}
async function readRemote(code,onComplete,onLine){
  for(let attempt=1;;attempt++){
    try{
      return await command(code,attempt>=3,onComplete,onLine)
    }catch(e){if(attempt===4||['REMOTE_NOT_PAIRED','REMOTE_HOST_ABSENT','REMOTE_HOST_OFFLINE'].includes(e.code))throw e;await delay(1000)}
  }
}
function directory(id){return '/tmp/dsh-local-chat-'+id}
async function uploadSteerInput(dir,request,digest,bytes){
  const partNames=[];
  for(let offset=0;offset<bytes.length;offset+=1350)partNames.push(String(offset).padStart(5,'0'));
  // Existing turn helpers join these filenames in lexical order, including six-digit offsets.
  partNames.sort();
  const prefix=dir+'/steer-'+request+'-'+digest+'-part-';
  for(let first=0;first<partNames.length;first+=4){
    const staging=dir+'/.chunk-'+randomUUID();
    const commands=partNames.slice(first,first+4).map((name,index)=>{
      const offset=(first+index)*1350;
      const part=bytes.subarray(offset,offset+1350).toString('base64');
      return 'printf %s '+part+' | base64 -d >'+staging+' && mv '+staging+' '+prefix+name
    });
    const saved=await readRemote(commands.join(' && '+String.fromCharCode(92,10))+' && echo READY');
    if(saved!=='READY')return false
  }
  return true
}
// Each browser keeps the same random session ID across signalling retries.
const voiceCalls=new Map();
async function launchVoiceCall(id,thread,sdp,setup){
  const path=await runtimeDriver(),dir='/tmp/dsh-voice-'+id;
  const prepared=await readRemote('umask 077; (mkdir '+dir+' || (test -O '+dir+' && test ! -L '+dir+' && test "$(stat -c %a '+dir+')" = 700)) && echo READY');
  if(prepared!=='READY')throw Error('无法创建语音会话目录');
  const encoded=Buffer.from(JSON.stringify({sdp,setup})).toString('base64');
  const parts=encoded.match(/.{1,2600}/g);
  const files=[];
  for(const [i,part] of parts.entries()){
    const file=dir+'/offer-'+i;
    if(await readRemote('printf %s '+part+' > '+file+' && echo READY')!=='READY')throw Error('未能传输语音提议');
    files.push(file)
  }
  const run='umask 077; mkdir accepted || exit 0; cat '+files.join(' ')+' | base64 -d | python3 -u '+path+' --voice '+(thread||'-')+' '+dir+' >events; touch done; sleep 120; rm -f events done stop heartbeat '+files.join(' ')+'; rmdir accepted; cd /tmp; rmdir '+dir;
  const launch='systemd-run --user --collect --unit=dsh-voice-'+id+' --working-directory='+dir+" /bin/sh -c '"+run+"'";
  const result=await readRemote('if test -d '+dir+'/accepted || systemctl --user is-active --quiet dsh-voice-'+id+'; then echo ACK; else '+launch+' && echo ACK; fi');
  if(!result.endsWith('ACK'))throw Error('主机未确认语音会话启动')
}
async function voiceRequest(req,json){
  if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
  const chunks=[];let size=0;
  for await(const chunk of req){
    size+=chunk.length;if(size>90000)return json(413,{error:'语音提议过长'});
    chunks.push(chunk)
  }
  const {id,thread=null,sdp,setup=null}=JSON.parse(Buffer.concat(chunks));
  if(typeof id!=='string'||!uuid.test(id))return json(400,{error:'无效语音会话'});
  const action=req.url.slice('/api/voice/'.length);
  const now=Date.now();
  for(const [key,entry] of voiceCalls)if(now-entry.lastSeen>600000)voiceCalls.delete(key);
  let session=voiceCalls.get(id);
  if(session)session.lastSeen=now;
  if(action==='start'){
    if(thread!==null&&(typeof thread!=='string'||!uuid.test(thread))||typeof sdp!=='string'||!sdp.startsWith('v=0')||sdp.length>65536)return json(400,{error:'无效语音提议'});
    if(thread===null){
      if(!setup||!['read-only','workspace-write','danger-full-access'].includes(setup.sandbox)||!['never','untrusted'].includes(setup.approvalPolicy))return json(400,{error:'无效语音任务权限'});
      if(setup.cwd&&!allowedProjects.has(setup.cwd)||setup.projectId&&!knownProjectIds.has(setup.projectId))return json(400,{error:'请重新从主机加载项目'});
      if(setup.model||setup.effort||setup.serviceTier){
        const model=(await models(setup.cwd||'')).models.find(m=>m.id===setup.model);
        if(!model||(setup.effort&&!model.efforts.includes(setup.effort))||(setup.serviceTier&&setup.serviceTier!=='default'&&!model.serviceTiers?.some(t=>t.id===setup.serviceTier)))return json(400,{error:'无效语音聊天模型配置'})
      }
    }
    const digest=createHash('sha256').update(JSON.stringify([sdp,setup])).digest('hex');
    if(session&&(session.thread!==thread||session.digest!==digest))return json(409,{error:'语音会话配置冲突'});
    if(!session){
      session={thread,digest,lastSeen:now};
      voiceCalls.set(id,session);
      session.launch=launchVoiceCall(id,thread,sdp,setup);
      session.launch.catch(()=>voiceCalls.delete(id))
    }
    await session.launch;
    return json(202,{id})
  }
  if(!session)return json(404,{error:'语音会话不存在或已结束'});
  await session.launch;
  const dir='/tmp/dsh-voice-'+id;
  if(action==='heartbeat'||action==='stop'){
    const file=action==='stop'?'stop':'heartbeat';
    const receipt=await readRemote('test -d '+dir+' && touch '+dir+'/'+file+' && echo ACK');
    if(receipt!=='ACK')return json(410,{error:'主机语音会话已结束'});
    return json(200,{id})
  }
  const output=await readRemote('if test -f '+dir+'/events; then cat '+dir+'/events; elif test -d '+dir+'; then echo WAIT; else echo GONE; fi');
  if(output==='GONE'){voiceCalls.delete(id);return json(410,{error:'主机语音会话已结束'})}
  const events=[];
  for(const line of output.split('\n')){
    if(!line.startsWith('{'))continue;
    try{events.push(JSON.parse(line))}catch{} // A concurrent writer can leave the last line incomplete.
  }
  const threadId=events.find(e=>e.type==='voice.thread')?.thread;
  const last=events.at(-1);
  if(last?.type==='voice.closed')return json(200,{state:'closed',reason:last.reason});
  if(last?.type==='turn.failed')return json(200,{state:'failed',error:last.error?.message||'主机语音启动失败'});
  const answer=events.find(e=>e.type==='voice.answer');
  return json(200,answer?{state:'ready',thread:threadId,sdp:answer.sdp}:{state:'starting',thread:threadId})
}
const reader=gzipSync(await readFile(new URL('./thread-api.py',import.meta.url))).toString('base64');
const driver=gzipSync(await readFile(new URL('./daemon-turn.py',import.meta.url))).toString('base64');
const follower=gzipSync(await readFile(new URL('./follow-events.py',import.meta.url))).toString('base64');
async function uploadScript(dir,name,payload){
  const parts=payload.match(/.{1,2800}/g);
  for(const [i,part] of parts.entries()){
    const result=await readRemote('printf %s '+part+' >'+dir+'/'+name+'-'+i+' && echo STORED');
    if(result!=='STORED')throw Error('未能向主机传输 Codex 协议客户端')
  }
  const result=await readRemote('cat '+parts.map((_,i)=>dir+'/'+name+'-'+i).join(' ')+' | base64 -d | gzip -dc >'+dir+'/'+name+'.py && echo READY');
  if(result!=='READY')throw Error('主机未确认 Codex 协议客户端已就绪')
}
// Keep verified host helpers across bridge restarts. A new build gets a separate cache entry.
const scriptDigest=payload=>createHash('sha256').update(gunzipSync(Buffer.from(payload,'base64'))).digest('hex');
const turnDigest=scriptDigest(driver),readerDigest=scriptDigest(reader),followDigest=scriptDigest(follower);
const helperBuild=createHash('sha256').update([turnDigest,readerDigest,followDigest].join(':')).digest('hex');
const helperCache=new URL('tim-SER-helpers-'+helperBuild+'.txt',stateDir);
let runtimeDir;
let runtimeReady;
async function runtimeDriver(firstCatalog){
  if(deviceId&&(await openRemote()).nativeCall)throw Error('此主机接口尚未适配该功能');
  if(runtimeReady)return runtimeReady;
  let verified;
  const verifiedPath=new Promise(resolve=>{verified=resolve});
  const initialization=(async()=>{
    let cached;
    try{cached=(await readFile(helperCache,'utf8')).trim()}catch(e){if(e.code!=='ENOENT')throw e}
    if(cached&&uuid.test(cached)){
      const dir=directory(cached);
      const check='test -d '+dir+' && test ! -L '+dir+' && test -O '+dir+
        ' && test "$(stat -c %a '+dir+')" = 700 && cd '+dir+
        ' && test ! -L turn.py && test ! -L reader.py && test ! -L follow.py && printf "%s  %s\\n" '+turnDigest+
        ' turn.py '+readerDigest+' reader.py '+followDigest+' follow.py | sha256sum -c --status';
      const path=dir+'/turn.py';
      const query=firstCatalog?' && '+firstCatalog.command(path):'';
      const result=await readRemote('if ( '+check+' ); then echo READY'+query+'; else echo INVALID; fi',undefined,line=>{
        if(line==='READY'){runtimeDir=dir;verified(path)}
      });
      if(result==='READY'||result.startsWith('READY\n')){
        runtimeDir=dir;
        if(firstCatalog)firstCatalog.output=result.slice(5).trim();
        return path
      }
    }
    const id=randomUUID(),dir=directory(id);
    const ready=await readRemote('umask 077; mkdir -m 700 '+dir+' && echo CREATED');
    if(ready!=='CREATED')throw Error('未能创建主机运行目录');
    await Promise.all([uploadScript(dir,'turn',driver),uploadScript(dir,'reader',reader),uploadScript(dir,'follow',follower)]);
    runtimeDir=dir;
    const temporary=new URL(id+'.helpers.tmp',stateDir);
    await writeFile(temporary,id);await rename(temporary,helperCache);
    return dir+'/turn.py'
  })();
  // Only the initiating catalog lookup needs the output after the READY line.
  runtimeReady=Promise.race([verifiedPath,initialization]);
  runtimeReady.catch(()=>{runtimeReady=null});
  return initialization
}
const catalogs=new Map();
let pluginCatalog;
const pluginPages=new Map();
async function nativeModels(call){
  const models=[];
  let cursor;
  do{
    const page=await call('model/list',{limit:100,...(cursor?{cursor}:{})});
    for(const m of page.data){
      models.push({id:m.model,name:m.displayName,isDefault:m.isDefault,description:m.description||'',
        retirementAt:m.upgradeInfo?.retirementAt,serviceTiers:m.serviceTiers||[],defaultEffort:m.defaultReasoningEffort,
        efforts:(m.supportedReasoningEfforts||[]).map(option=>option.reasoningEffort)})
    }
    cursor=page.nextCursor
  }while(cursor);
  const selected=models.find(m=>m.isDefault);
  return {models,defaults:{model:selected?.id,effort:selected?.defaultEffort},recentConfigurations:[]}
}
async function models(cwd=''){
  const cached=catalogs.get(cwd);
  const age=cached?Date.now()-cached.created:Infinity;
  if(cached?.data&&age<300000&&(age<240000||Date.now()<cached.retryAfter))return cached.data;
  if(cached?.flight)return age<300000&&cached.data?cached.data:cached.flight;
  const entry=cached||{created:0};
  const flight=(async()=>{
      const native=deviceId&&(await openRemote()).nativeCall;
      if(native){
        const data=await nativeModels(native);
        if(!data.models.length)throw Error('主机没有返回模型目录');
        entry.data=data;entry.created=Date.now();entry.retryAfter=0;return data
      }
      const arg=cwd?' '+Buffer.from(cwd).toString('base64'):'';
      const query={command:path=>'timeout 35 python3 '+path+' --models'+arg};
      const path=await runtimeDriver(query);
      const data=JSON.parse(query.output??await readRemote(query.command(path)));
      if(!Array.isArray(data.models)||!data.models.length)throw Error('主机没有返回模型目录');
      entry.data=data;entry.created=Date.now();entry.retryAfter=0;
      return data
  })().finally(()=>{delete entry.flight;if(!entry.data)catalogs.delete(cwd)});
  entry.flight=flight;catalogs.set(cwd,entry);
  if(entry.data&&age<300000){
    flight.catch(()=>{entry.retryAfter=Date.now()+15000});return entry.data
  }
  return flight
}
const allowedProjects=new Set(), knownProjectIds=new Set();
let fileSearchRoots=new Set();
const nativeRoots=new Map();
function nativeActivity(item){
  if(!['commandExecution','fileChange','webSearch','mcpToolCall','dynamicToolCall'].includes(item.type))return null;
  const record={id:item.id,type:item.type,status:item.status,durationMs:item.durationMs,
    title:item.command||item.tool||item.query||item.type};
  let output='';
  if(item.type==='commandExecution'){
    record.exitCode=item.exitCode;output=item.aggregatedOutput||''
  }else if(item.type==='fileChange'){
    record.changes=item.changes||[];output=record.changes.map(change=>change.path).join('\n')
  }else if(item.type==='mcpToolCall'||item.type==='dynamicToolCall'){
    const dynamic=item.type==='dynamicToolCall',content=dynamic?item.contentItems:item.result?.content;
    record.source=dynamic?item.namespace:item.server;
    const chunks=(content||[]).filter(block=>block?.type===(dynamic?'inputText':'text')&&
      (!block.annotations?.audience||block.annotations.audience.includes('user'))).map(block=>block.text);
    if(item.error?.message)chunks.push(item.error.message);
    output=chunks.filter(Boolean).join('\n\n')
  }
  record.output=output.slice(-16384);record.truncated=output.length>record.output.length;
  return record
}
function projectDirectoryKey(path){
  if(typeof path!=='string'||!path)return null;
  const windows=/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(path);
  const canonical=windows?path.replaceAll('\\','/').toLowerCase():path;
  return canonical.replace(/\/+$/,'')||'/'
}
function nativeProjectId(thread){
  if(thread.projectId)return thread.projectId;
  const cwd=projectDirectoryKey(thread.cwd);
  if(cwd===null)return null;
  let match;
  for(const [id,roots] of nativeRoots){
    if(!roots.some(root=>projectDirectoryKey(root)===cwd))continue;
    if(match)return null;
    match=id
  }
  return match||null
}
async function nativeArchiveIds(call,ids){
  const wanted=new Set(ids),found=new Set();
  let cursor;
  do{
    const page=await call('thread/list',{archived:true,limit:100,...(cursor?{cursor}:{})});
    for(const thread of page.data)if(wanted.has(thread.id))found.add(thread.id);
    cursor=page.nextCursor
  }while(cursor&&found.size<wanted.size);
  return ids.filter(id=>found.has(id))
}
function nativeUsageFile(thread,turn){
  return new URL('usage-'+thread+'-'+turn+'.json',stateDir)
}
async function readNativeUsage(thread,turn){
  if(!uuid.test(thread)||!uuid.test(turn))return null;
  try{return JSON.parse(await readFile(nativeUsageFile(thread,turn),'utf8'))}
  catch(error){if(error.code==='ENOENT')return null;throw error}
}
async function nativeProjectList(call){
  const projects=[],seen=new Set();
  let cursor;
  do{
    const page=await call('project/list',{limit:100,...(cursor?{cursor}:{})});
    for(const p of page.data){
      const roots=p.roots.map(root=>typeof root==='string'?root:root.path);
      projects.push({id:p.id,name:p.name,roots})
    }
    cursor=page.nextCursor;
    if(cursor&&seen.has(cursor))throw Error('主机返回了重复的项目游标');
    seen.add(cursor)
  }while(cursor);
  return projects
}
async function nativeDirectory(call,mode,target){
  if(mode==='read'||mode==='shared-read'){
    const {thread}=await call('thread/read',{threadId:target,includeTurns:true});
    const messages=[];
    for(const turn of thread.turns||[]){
      for(const item of turn.items||[]){
        const record=nativeActivity(item);
        if(record){
          const last=messages.at(-1);
          if(last?.role==='activity'&&last.turn===turn.id)last.items.push(record);
          else messages.push({role:'activity',turn:turn.id,items:[record]})
        }
        if(['agentMessage','plan'].includes(item.type)&&item.text)messages.push({role:item.type==='plan'?'plan':'assistant',turn:turn.id,id:item.id,text:item.text});
        if(item.type==='userMessage'){
          const text=item.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
          const images=item.content.filter(c=>c.type==='image'&&typeof c.url==='string'&&
            /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(c.url)).map(c=>c.url);
          messages.push({role:'user',turn:turn.id,text,...(images.length?{images}:{})})
        }
      }
      if(turn.status==='failed'||turn.status==='interrupted')messages.push({role:'status',turn:turn.id,status:turn.status,text:turn.error?.message||''});
      const last=messages.at(-1);
      if(last?.turn===turn.id&&['assistant','status'].includes(last.role)&&Number.isSafeInteger(turn.durationMs)&&turn.durationMs>=0)last.turnDurationMs=turn.durationMs
    }
    const usage=await readNativeUsage(thread.id,thread.turns?.at(-1)?.id);
    return {usage,projectId:nativeProjectId(thread),thread:thread.id,name:thread.name||thread.preview,cwd:thread.cwd,messages,
      ...(thread.model?{threadConfig:{model:thread.model,effort:thread.reasoningEffort}}:{}),activeTurn:thread.turns?.find(t=>t.status==='inProgress')?.id}
  }
  if(mode==='archive-check'||mode==='archive-set'){
    const {ids,archived}=JSON.parse(target);
    let found=await nativeArchiveIds(call,ids);
    if(mode==='archive-set'&&found.includes(ids[0])!==archived){
      const threadId=ids[0];
      if(archived){
        const {thread}=await call('thread/read',{threadId,includeTurns:false});
        if(thread.status?.type==='active')throw Error('请等待当前任务结束后再归档')
      }
      await call(archived?'thread/archive':'thread/unarchive',{threadId});
      found=await nativeArchiveIds(call,ids);
      if(found.includes(threadId)!==archived)throw Error('主机尚未确认归档状态')
    }
    return {ids:found}
  }
  if(!['list','search','project-page','archived'].includes(mode))throw Error('此主机接口尚未适配该功能');
  const query=mode==='search'||mode==='project-page'?JSON.parse(target):{};
  const params={limit:40};
  if(query.term)params.searchTerm=query.term;
  if(mode==='archived')params.archived=true;
  if(mode==='project-page'){
    const roots=query.projectId?nativeRoots.get(query.projectId):[query.projectCwd];
    if(!roots?.length)return {items:[],cursor:null,...query};
    params.cwd=roots
  }
  const cursor=query.cursor||(['list','archived'].includes(mode)&&target!=='-'?target:null);
  if(cursor)params.cursor=cursor;
  const [page,projects]=await Promise.all([
    call('thread/list',params),
    mode==='list'&&!cursor?nativeProjectList(call):null
  ]);
  const result={...query,cursor:page.nextCursor};
  if(projects){
    result.projects=projects;nativeRoots.clear();
    for(const project of projects){
      knownProjectIds.add(project.id);
      for(const root of project.roots)allowedProjects.add(root);
      nativeRoots.set(project.id,project.roots)
    }
  }
  result.items=page.data.map(t=>({thread:t.id,title:t.name||t.preview||'新聊天',cwd:t.cwd,updated:t.updatedAt,activeFlags:t.status?.type==='active'?t.status.activeFlags:undefined,projectId:nativeProjectId(t)}));
  if(query.projectId)result.items=result.items.filter(item=>item.projectId===query.projectId);
  if(query.projectCwd)result.items=result.items.filter(item=>!item.projectId&&projectDirectoryKey(item.cwd)===projectDirectoryKey(query.projectCwd));
  return result
}
async function remoteThreads(mode,target){
  const native=deviceId&&(await openRemote()).nativeCall;
  if(native)return nativeDirectory(native,mode,target);
  const path=directory(randomUUID());
  const argument=Buffer.from(target).toString('base64');
  const driverPath=await runtimeDriver();
  const driverArg=['read','shared-read','archive-set','list','read-state-update'].includes(mode)?' '+driverPath:'';
  const cleanup='rm -f '+path+'/reply '+path+'/zip && rmdir '+path;
  const cmd='umask 077; mkdir -p '+path+' && timeout 25 python3 '+runtimeDir+'/reader.py '+mode+' "$(echo '+argument+' | base64 -d)"'+driverArg+' >'+path+'/reply && gzip -c '+path+'/reply >'+path+'/zip && size=$(wc -c <'+path+'/zip) && if test "$size" -le 16000; then base64 -w0 '+path+'/zip && echo && '+cleanup+' && echo CLEAN; else echo "$size" && head -c 16000 '+path+'/zip | base64 -w0 && echo; fi';
  let cleaned=false;
  try{
    const reply=await readRemote(cmd);
    cleaned=reply.endsWith('\nCLEAN');
    const split=reply.indexOf('\n');
    const first=Buffer.from(cleaned?reply.slice(0,-6):reply.slice(split+1),'base64');
    const bytes=cleaned?first.length:Number(reply.slice(0,split));
    if(!Number.isSafeInteger(bytes)||bytes<1||bytes>4*1024*1024)throw Error('会话读取未完成或超过大小限制');
    if(!cleaned&&(split<1||bytes<=16000||first.length!==16000))throw Error('主机返回的历史首段不完整');
    const chunks=[first];
    async function readChunk(skip){
      const data=await readRemote('dd if='+path+'/zip bs=16000 skip='+skip+' count=1 status=none | base64 -w0; echo');
      const chunk=Buffer.from(data,'base64');
      if(chunk.length!==Math.min(16000,bytes-skip*16000))throw Error('主机返回的历史分段不完整');
      return chunk
    }
    const count=Math.ceil(bytes/16000);
    for(let start=1;start<count;start+=3){
      const reads=Array.from({length:Math.min(3,count-start)},(_,index)=>readChunk(start+index));
      // Let sibling reads finish before the finally block removes their source.
      for(const result of await Promise.allSettled(reads)){
        if(result.status==='rejected')throw result.reason;
        chunks.push(result.value)
      }
    }
    const result=JSON.parse(gunzipSync(Buffer.concat(chunks)));
    if(result.error)throw Error(result.error);
    for(const item of result.items||[])if(item.cwd?.startsWith('/'))allowedProjects.add(item.cwd);
    for(const project of result.projects||[])if(project.id)knownProjectIds.add(project.id);
    for(const project of result.projects||[])for(const path of project.roots)if(path.startsWith('/'))allowedProjects.add(path);
    if(Array.isArray(result.projects))fileSearchRoots=new Set(result.projects.flatMap(p=>p.roots));
    return result
  }finally{if(!cleaned)await command(cleanup).catch(()=>{})}
}
const openingHistories=new Map();
const historyParents=new Map();
function historyParent(thread,cwd){
  const previous=historyParents.get(thread);
  if(previous&&previous.cwd===cwd)return previous.saved;
  const record={id:randomUUID(),status:'done',thread,cwd,created:Date.now()};
  const entry={cwd,saved:save(record).then(()=>record.id)};
  historyParents.set(thread,entry);
  if(historyParents.size>512)historyParents.delete(historyParents.keys().next().value);
  entry.saved.catch(()=>{if(historyParents.get(thread)===entry)historyParents.delete(thread)});
  return entry.saved
}
async function openHistory(mode,thread){
  const key=mode+':'+thread;
  let flight=openingHistories.get(key);
  if(!flight){
    flight=remoteThreads(mode,thread).finally(()=>openingHistories.delete(key));
    openingHistories.set(key,flight)
  }
  // Each HTTP response attaches its own live-turn or continuation fields.
  return {...await flight}
}
let directoryFlight;
async function firstDirectoryPage(){
  if(!directoryFlight){
    const flight=remoteThreads('list','-').finally(()=>{if(directoryFlight===flight)directoryFlight=null});
    directoryFlight=flight
  }
  const page=await directoryFlight;
  // Each HTTP response adds locally running threads to its own list.
  return {...page,items:[...page.items]}
}
function validImages(images){
  if(!Array.isArray(images))return false;
  const supported=/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  if(!images.every(url=>typeof url==='string'&&supported.test(url)))return false;
  const total=images.reduce((sum,url)=>sum+Buffer.from(url.split(',')[1],'base64').length,0);
  return total<=262144
}
function turnInput(text,images){
  return images.length?JSON.stringify([...(text?[{type:'text',text}]:[]),...images.map(url=>({type:'image',url}))]):text
}
function nativeInput(prompt,structured){
  if(!structured)return [{type:'text',text:prompt}];
  return JSON.parse(prompt).map(item=>{
    if(item.type!=='image')return item;
    const comma=item.url.indexOf(',');
    return {type:'image',mediaType:item.url.slice(5,item.url.indexOf(';')),data:item.url.slice(comma+1)}
  })
}
async function nativeSteer(call,thread,turn,request,text,images){
  const input=nativeInput(turnInput(text,images),images.length>0);
  if(input.length>16)throw Error('单次输入最多支持 16 项');
  const hash=createHash('sha256').update(JSON.stringify([thread,turn,input])).digest('hex');
  const receipt=new URL('steer-'+request+'.json',stateDir);
  try{await writeFile(receipt,JSON.stringify({hash}),{flag:'wx',mode:0o600})}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    const existing=JSON.parse(await readFile(receipt,'utf8'));
    if(existing.hash!==hash)throw Error('补充要求与原提交不一致');
    if(!existing.accepted)throw Error('主机尚未确认此前的补充要求，请核对聊天记录');
    return
  }
  try{await call('turn/steer',{threadId:thread,expectedTurnId:turn,input})}
  catch(error){
    if(error.code==='CODEX_THREAD_NOT_ALLOWED')await unlink(receipt);
    throw error
  }
  const temp=new URL('steer-'+randomUUID()+'.tmp',stateDir);
  await writeFile(temp,JSON.stringify({hash,accepted:true}),{mode:0o600});await rename(temp,receipt)
}
async function prepareLaunch(job,prompt,previous){
  const dir=directory(job.id);
  const bytes=Buffer.from(prompt);
  const chunkSize=1350;
  const zipped=bytes.length>chunkSize?gzipSync(bytes):null;
  const compressed=zipped&&Math.ceil(zipped.length/chunkSize)<Math.ceil(bytes.length/chunkSize);
  const payload=compressed?zipped:bytes;
  const prefix=compressed?'packed-batch-':'plain-batch-';
  const parts=[];
  for(let i=0;i<payload.length;i+=chunkSize)parts.push(payload.subarray(i,i+chunkSize).toString('base64'));
  const prepareDir='(mkdir -m 700 '+dir+' || (test -O '+dir+' && test ! -L '+dir+')) && ';
  const path=await runtimeDriver();
  job.runtimeReadyAt=Date.now();
  // Share an acknowledgement across four PTY lines. Full chunks end on a base64 triple boundary.
  for(let n=0;parts.length>1&&n<parts.length;n+=4){
    const part=parts.slice(n,n+4).join('\\\n');
    const name=String(n).padStart(4,'0');
    const prep=n===0?prepareDir:'';
    const staging=dir+'/.chunk-'+randomUUID();
    const result=await readRemote(prep+'printf %s '+part+' | base64 -d > '+staging+' && mv '+staging+' '+dir+'/'+prefix+name+' && echo STORED');
    if(!result.endsWith('STORED'))throw Error('远端没有确认保存输入');
  }
  const staging=dir+'/.input-'+randomUUID();
  const write=parts.length===1?'printf %s '+parts[0]+' | base64 -d':'cat '+dir+'/'+prefix+'*';
  const digest=createHash('sha256').update(bytes).digest('hex');
  const input=(parts.length===1?prepareDir:'')+write+(compressed?' | gzip -dc':'')+' >'+staging+
    ' && printf "%s  %s\n" '+digest+' '+staging+' | sha256sum -c --status && mv '+staging+' '+dir+'/input && ';
  const shell='mkdir "$1/accepted" || exit 0; python3 -u "$1/turn.py" "$2" "$3" <"$1/input" >"$1/events" 2>"$1/errors"; echo $? >"$1/rc"';
  // Stable unit name plus a start marker on the host make a lost acknowledgement safe to retry.
  const cwd=job.cwd?'"$(printf %s '+Buffer.from(job.cwd).toString('base64')+' | base64 -d)"':'"$PWD"';
  const selection=Buffer.from(JSON.stringify(job.selection||{})).toString('base64');
  const launch='systemd-run --user --collect --unit=dsh-chat-'+job.id+' --working-directory='+cwd+' --setenv=PATH="$PATH" /bin/sh -c '+ "'"+shell+"'"+' sh '+dir+' '+(previous||'-')+' '+selection;
  return 'if test -d '+dir+'/accepted || systemctl --user is-active --quiet dsh-chat-'+job.id+
    '; then echo ACK; else '+input+'cp '+path+' '+dir+'/turn.py && '+launch+' && echo ACK; fi';
}
const projection=Buffer.from([
'import json,os,sys,base64',
'd=sys.argv[1]; offset=int(sys.argv[2]); rc=os.path.join(d,"rc")',
'if not os.path.exists(d+"/events"): print("WAIT");sys.exit()',
'rows=[]',
'for line in open(d+"/events",encoding="utf8"):',
' try: rows.append(json.loads(line))',
' except ValueError: continue',
'tid=next((e.get("thread_id") for e in rows if e.get("type")=="thread.started"),None)',
'msgs=[e["item"]["text"] for e in rows if e.get("item",{}).get("type")=="agent_message"]',
'if not os.path.exists(rc):',
' latest=next((e["item"] for e in reversed(rows) if isinstance(e.get("item"),dict)),{})',
' state=dict(message=(msgs[-1] if msgs else "")[:1800],item=latest.get("type",""),started=any(e.get("type")=="turn.started" for e in rows))',
' print("LIVE",base64.b64encode(json.dumps(state,ensure_ascii=False).encode()).decode());sys.exit()',
'ok=open(rc).read().strip()=="0" and any(e.get("type")=="turn.completed" for e in rows)',
'errors=[e.get("error",{}).get("message") or e.get("message") for e in rows if e.get("type") in ("turn.failed","error")]',
'body=json.dumps(dict(ok=ok,thread=tid,text="\\n\\n".join(msgs),error=next((x for x in reversed(errors) if x),"远端 Codex 未完成本轮")),ensure_ascii=False).encode()',
'print("DATA",len(body),base64.b64encode(body[offset:offset+12000]).decode())'].join('\n')).toString('base64');
async function reconcile(job){
  const chunks=[];let size=0;
  for(let i=0;i<150;i++){
    const result=await readRemote('echo '+projection+' | base64 -d | python3 - '+directory(job.id)+' '+size);
    if(result==='WAIT'){await delay(2000);continue}
    if(result.startsWith('LIVE ')){
      const next=JSON.parse(Buffer.from(result.slice(5),'base64').toString('utf8'));
      if(JSON.stringify(job.progress)!==JSON.stringify(next)){job.progress=next;await save(job)}
      await delay(1200);continue
    }
    const m=result.match(/^DATA (\d+) ([A-Za-z0-9+/=]+)$/);
    if(!m)throw Error('读取结果失败');
    const chunk=Buffer.from(m[2],'base64');chunks.push(chunk);size+=chunk.length;
    if(size<Number(m[1]))continue;
    const data=JSON.parse(Buffer.concat(chunks).toString());
    if(!data.ok||!uuid.test(data.thread))throw Error(data.error);
    Object.assign(job,{status:'done',answer:data.text,thread:data.thread});await save(job);return;
  }
  throw Error('等待远端确认超时');
}
async function watchTurn(job,launch=null,freshSubmission=false){
  const progress=job.progress??={message:'',started:false,items:[]};
  if(!job.offset)job.order??=[];
  function record(kind,id){
    if(!job.order||!id)return;
    let entry=job.order.find(item=>item.kind===kind&&item.id===id);
    if(!entry){entry={kind,id};job.order.push(entry)}
    return entry
  }
  liveJobs.set(job.id,job);
  let launchAttempts=0,consecutiveFailures=0;
  while(launch||job.status==='waiting'){
    const attemptStartedAt=Date.now();
    job.followAttempts=(job.followAttempts||0)+1;
    if(launch)launchAttempts++;
    let exit=0,hostOffline=false;
    try{
    await runtimeDriver();
    const follow='python3 -u '+runtimeDir+'/follow.py '+directory(job.id)+' '+(job.offset||0);
    const code=launch?launch+' && '+String.fromCharCode(92,10)+follow:follow;
    let currentMode;
    for await(const line of remoteLines(code,true,consecutiveFailures>=2,null,null,(mode,clock,readMode)=>{
      currentMode=readMode;
      if(job.reconnecting){
        const failure=job.lastFollowFailure;
        if(failure?.attempt===job.followAttempts-1&&failure.at<=attemptStartedAt){
          job.lastFollowRecovery={attempt:job.followAttempts,waitMs:attemptStartedAt-failure.at,
            openMs:Math.max(0,Date.now()-attemptStartedAt)}
        }
        delete job.reconnecting;notify(job)
      }
      if(launch){job.launchMode=mode;if(clock)job.hostClock=clock}
    })){
      if(launch){
        if(line!=='ACK')continue;
        job.launchAcknowledgedAt=Date.now();job.status='waiting';await save(job);
        launch=null;continue
      }
      const fields=/^CX (\d+) ([a-z0-9+/=]+)(?: (\d{13})(?: (\d{13}) (\d+))?)?$/i.exec(line);
      if(!fields||Number(fields[1])!==(job.offset||0)+1)continue;
      const event=JSON.parse(Buffer.from(fields[2],'base64'));
      if(event.type==='thread.started'){
        job.thread=event.thread_id;job.effective={model:event.model,effort:event.effort};
        if(Object.hasOwn(event,'threadServiceTier'))job.threadServiceTier=event.threadServiceTier
      }
      if(event.type==='turn.started'){job.turn=event.turn_id;progress.started=true;job.observedStartAt??=Date.now()}
      if(event.type==='turn.started')directoryChanged();
      if(event.type==='turn.started'&&event.hostSetupMs)job.hostSetupMs=event.hostSetupMs;
      if(event.type==='turn.started'&&event.requestedPolicy)job.permissions={turn:job.turn,requested:event.requestedPolicy,
        threadSandbox:event.threadSandbox,threadApproval:event.threadApproval};
      if(event.type==='usage.updated')job.usage={input:event.input,output:event.output,total:event.total,contextWindow:event.contextWindow};
      if(event.type==='goal.changed')job.goal=event.goal;
      if(event.type==='input.requested'&&uuid.test(event.token)){
        (job.inputRequests??={})[event.token]=event.questions
      }
      if(event.type==='input.resolved'&&job.inputRequests)delete job.inputRequests[event.token];
      if(event.type==='steps.updated'){
        record('steps',job.turn);
        job.stepPlan={explanation:event.explanation,steps:event.steps}
      }
      if(event.type==='plan.delta'||event.type==='plan.snapshot'){
        record('plan',event.item_id);
        const plans=job.proposedPlans??={};
        plans[event.item_id]=event.type==='plan.snapshot'?event.text:(plans[event.item_id]||'')+event.delta
      }
      if(event.type==='user.message'&&event.clientId){
        record('user',event.clientId);
        const messages=job.supplements??=[];
        let message=messages.find(m=>m.clientId===event.clientId);
        if(!message){message={clientId:event.clientId,turn:job.turn,text:event.text};messages.push(message)}
        else if(typeof event.text==='string')message.text=event.text;
        if(event.images?.length&&validImages(event.images))message.images=event.images
      }
      if(event.type==='text.delta'){
        record('assistant',event.item_id);
        if(event.delta)job.observedTextAt??=Date.now();
        if(Number.isSafeInteger(event.hostElapsedMs))job.hostFirstTextMs??=event.hostElapsedMs;
        if(Number.isSafeInteger(event.hostFirstTextAt)){
          job.hostFirstTextAt??=event.hostFirstTextAt;
          if(fields[3])job.hostFirstTextForwardedAt??=Number(fields[3])
          if(fields[4])job.firstTextReader??={attempt:job.followAttempts,mode:currentMode?.(),openedAt:Number(fields[4]),maxPriorWriteMs:Number(fields[5])}
        }
        if(progress.activeItem!==event.item_id){progress.activeItem=event.item_id;progress.message=''}
        progress.message+=event.delta
      }
      if(event.type==='command.output'){
        record('activity',event.item_id);
        const items=progress.items??=[];
        let record=items.find(item=>item.id===event.item_id);
        if(!record){record={id:event.item_id,type:'commandExecution',status:'inProgress'};items.push(record)}
        const output=(record.output||'')+event.delta;
        record.output=output.slice(-16384);
        record.truncated=record.truncated||event.truncated||output.length>16384
      }
      if(event.item?.type==='agent_message'){
        const entry=record('assistant',event.item.id);
        if(entry)entry.part=job.parts?.length||0;
        (job.parts??=[]).push(event.item.text);progress.message=event.item.text;
        progress.completedItem=progress.activeItem=event.item.id
      }else if(event.item){
        record('activity',event.item.id);
        const items=progress.items??=[];const idx=items.findIndex(i=>i.id===event.item.id);
        if(idx<0)items.push(event.item);else items[idx]={...items[idx],...event.item}
      }
      if(['turn.completed','turn.interrupted'].includes(event.type)&&Number.isSafeInteger(event.durationMs)&&event.durationMs>=0)job.turnDurationMs=event.durationMs;
      if(event.type==='turn.completed'){
        const text=job.proposedPlans&&job.order?job.order.map(entry=>{
          if(entry.kind==='plan')return job.proposedPlans[entry.id];
          if(entry.kind==='assistant')return job.parts?.[entry.part]
        }).filter(Boolean):job.parts||[];
        job.answer=text.join('\n\n');job.status='done'
      }
      if(event.type==='turn.interrupted'){
        const tail=progress.activeItem!==progress.completedItem&&progress.message?[progress.message]:[];
        job.answer=[...(job.parts||[]),...tail].join('\n\n')||progress.message||'';
        job.status='interrupted'
      }
      if(event.type==='turn.failed'){job.status='error';job.error=event.error?.message||'远端任务失败'}
      job.offset=Number(fields[1]);
      consecutiveFailures=0;
      if(event.type==='text.delta'||event.type==='plan.delta'||event.type==='command.output')notify(job);else await save(job)
    }

    }catch(error){
      hostOffline=error.code==='REMOTE_HOST_OFFLINE'&&job.status==='waiting'&&!launch;
      if(freshSubmission&&launch&&launchAttempts===1&&error.code==='REMOTE_HOST_OFFLINE')job.notSubmitted=true;
      if(!hostOffline&&['REMOTE_NOT_PAIRED','REMOTE_HOST_ABSENT','REMOTE_HOST_OFFLINE'].includes(error.code))throw error;
      job.lastFollowFailure={attempt:job.followAttempts,at:Date.now(),code:String(error.code||error.name||'unknown').slice(0,80)};
      if(error.remoteClose)job.lastFollowFailure.remoteClose=error.remoteClose;
      if(['preparing','waiting'].includes(job.status)){job.reconnecting=true;notify(job)}
      exit=1;consecutiveFailures++
    }
    if(launch){
      if(launchAttempts>=4)throw Error('主机没有确认任务启动');
      if(!exit||consecutiveFailures>1)await delay(1000);
      continue
    }
    if(job.status==='waiting'){await save(job);
      if(hostOffline){await delay(Math.min(30000,2000*consecutiveFailures));continue}
      if(exit!==0&&consecutiveFailures>1)await delay(1200);
      if(!job.turn&&Date.now()-job.created>150000)throw Error('主机尚未确认启动本轮任务')}
  }
}
const nativeApprovals=new Map();
const nativeDecisions=new Map([['仅允许本次','accept'],['拒绝','decline'],['取消本轮','cancel']]);
async function nativeTurn(job,prompt,previous,call){
  let controller,reconcileText=!!job.turn,nextSubscribeAt=0,textChanged=false;
  let stream,ended=false,wake,buffer=[],transportMode;
  function observeText(text){
    if(!text||job.observedTextAt!=null)return;
    job.observedTextAt=Date.now();
    const mode=transportMode?.();
    if(mode)job.firstTextReader={mode}
  }
  const texts=new Map();
  function frame({method,params}){
    if(!params||params.threadId!==job.thread)return;
    if(!job.turn){buffer.push({method,params});return}
    if(method==='serverRequest/resolved'&&nativeApprovals.get(params.requestHandle)?.job===job){
      nativeApprovals.delete(params.requestHandle);delete job.inputRequests[params.requestHandle];notify(job);return
    }
    if((params.turnId||params.turn?.id)!==job.turn)return;
    if(method==='thread/tokenUsage/updated'){
      const usage=params.tokenUsage,last=usage?.last;
      if(!last||!Number.isSafeInteger(last.totalTokens)||last.totalTokens<0)return;
      job.usage={input:last.inputTokens,output:last.outputTokens,total:last.totalTokens,contextWindow:usage.modelContextWindow};
      notify(job);return
    }
    if(method==='item/commandExecution/requestApproval'||method==='item/fileChange/requestApproval'){
      const handle=params.requestHandle;
      if(!uuid.test(handle)||nativeApprovals.has(handle))return;
      const command=method==='item/commandExecution/requestApproval';
      const review=command?{command:Array.isArray(params.command)?params.command.join(' '):params.command,cwd:params.cwd,reason:params.reason}:{grantRoot:params.grantRoot,reason:params.reason};
      const question={id:'decision',question:command?'是否允许执行此命令？':'是否允许此次文件修改？',options:Array.from(nativeDecisions.keys(),label=>({label})),[command?'commandReview':'fileReview']:review};
      nativeApprovals.set(handle,{job,turn:job.turn});
      (job.inputRequests??={})[handle]=[question];notify(job);return
    }
    if(method==='item/started'||method==='item/completed'){
      const record=params.item&&nativeActivity(params.item);
      if(record){
        const items=(job.progress??={started:true}).items??=[];
        const index=items.findIndex(item=>item.id===record.id);
        if(index<0)items.push(record);else items[index]=record;
        notify(job);return
      }
    }
    if(method==='item/commandExecution/outputDelta'&&!reconcileText){
      const record=job.progress?.items?.find(item=>item.id===params.itemId);
      if(record&&typeof params.delta==='string'){
        const output=record.output+params.delta;
        record.truncated||=output.length>16384;record.output=output.slice(-16384);notify(job)
      }
      return
    }
    if(method==='turn/completed'){ended=true;wake?.();return}
    if(reconcileText&&(method==='item/agentMessage/delta'||method==='item/completed')){
      textChanged=true;wake?.();return
    }
    if(method==='item/agentMessage/delta'&&typeof params.delta==='string'){
      texts.set(params.itemId,(texts.get(params.itemId)||'')+params.delta);
      observeText(params.delta)
    }else if(method==='item/completed'&&params.item?.type==='agentMessage'){
      texts.set(params.item.id,params.item.text);observeText(params.item.text)
    }else return;
    job.parts=Array.from(texts.values());notify(job)
  }
  async function subscribe(){
    controller=new AbortController();
    nextSubscribeAt=Date.now()+5000;
    const timeout=setTimeout(()=>controller.abort(),8000);
    try{
      const remote=await openRemote();
      const client=remote.nativeStream;transportMode=remote.transportMode;
      stream=await client.subscribe(job.thread,frame,controller.signal,()=>{stream=null;reconcileText=true;wake?.()})
    }catch{stream=null}finally{clearTimeout(timeout)}
  }
  try{
    const pick=job.selection;
    if(!job.turn){
      if(job.nativeSubmitting)throw Error('主机可能已收到消息，请在主机会话中核对后再发送');
      if(pick.sandbox!=='remote-workspace'&&!(pick.sandbox==='danger-full-access'&&pick.approvalPolicy==='never'))
        throw Error('该主机支持工作区写入（按需审批）和完全访问，请在任务权限中选择');
      if(pick.collaborationMode==='plan'||pick.serviceTier&&pick.serviceTier!=='default')throw Error('该主机接口尚不支持所选计划模式或速度档位');
      const permissionPreset=pick.sandbox==='remote-workspace'?'workspace-write':pick.sandbox;
      const options={permissionPreset,...(pick.model?{model:pick.model}:{})};
      if(!previous&&!job.cwd){
        const list=await call('project/list',{limit:100});
        const root=list.data?.find(p=>p.roots?.length)?.roots[0];
        job.cwd=typeof root==='string'?root:root?.path;
        if(!job.cwd)throw Error('请先在主机 Codex 中打开一个项目');
      }
      // Remote interprets resume with permissionPreset as a settings update.
      // Apply the requested preset on turn/start after the existing thread is loaded.
      // Hold a subscription while resuming so the host retains the loaded thread.
      if(previous){job.thread=previous;await subscribe()}
      const started=previous?await call('thread/resume',{threadId:previous,...(pick.model?{model:pick.model}:{})}):
        await call('thread/start',{cwd:job.cwd,...options});
      job.thread=started.thread.id;
      job.nativeSubmitting=true;await save(job);
      if(!previous)await subscribe();
      const input=nativeInput(prompt,pick.structuredInput);
      const result=await call('turn/start',{threadId:job.thread,input,...options,...(pick.effort?{effort:pick.effort}:{})});
      job.turn=result.turn.id;
      job.observedStartAt=Date.now();
      job.progress={started:true};
      job.status='waiting';
      for(const event of buffer)frame(event);
      buffer=[];await save(job)
    }else{job.inputRequests={};liveJobs.set(job.id,job)}
    let failures=0;
    for(;;){
      if(!stream&&Date.now()>=nextSubscribeAt){reconcileText=true;await subscribe()}
      textChanged=false;
      let thread;
      try{
        if(!call)call=(await openRemote()).nativeCall;
        if(!call)throw Error('所选设备没有提供原生 Codex 接口');
        ({thread}=await call('thread/read',{threadId:job.thread,includeTurns:true}));
        failures=0;
        if(job.reconnecting){delete job.reconnecting;notify(job)}
      }catch(error){
        const code=String(error.code||error.name);
        const transient=error.retryable||/OFFLINE|TRANSPORT|CONNECT|TIMEOUT|TIMEDOUT|TimeoutError/i.test(code);
        if(['REMOTE_NOT_PAIRED','REMOTE_HOST_ABSENT'].includes(code)||(++failures>=5&&!transient))throw error;
        job.reconnecting=true;job.lastFollowFailure={at:Date.now(),code};notify(job);
        call=null;await delay(Math.min(15000,1000*failures));continue
      }
      const turn=thread.turns.find(t=>t.id===job.turn);
      if(turn){
        const parts=turn.items.filter(item=>item.type==='agentMessage').map(item=>item.text);
        // Without a stream cursor a snapshot prefix cannot safely be joined to subsequent deltas.
        if(!texts.size&&parts.some(Boolean))reconcileText=true;
        const useSnapshot=reconcileText||!stream||!texts.size;
        const changed=useSnapshot&&JSON.stringify(parts)!==JSON.stringify(job.parts);
        if(useSnapshot){job.parts=parts;observeText(parts.find(Boolean))}
        if(reconcileText&&job.progress){
          job.progress.items=turn.items.map(nativeActivity).filter(Boolean);
        }
        if(turn.status==='completed'||turn.status==='interrupted'){
          if(thread.model)job.effective={model:thread.model,effort:thread.reasoningEffort};
          if(job.usage&&uuid.test(job.thread)&&uuid.test(job.turn)){
            const tmp=new URL('usage-'+randomUUID()+'.tmp',stateDir);
            await writeFile(tmp,JSON.stringify(job.usage),{mode:0o600});
            await rename(tmp,nativeUsageFile(job.thread,job.turn))
          }
          observeText(parts.find(Boolean));job.parts=parts;job.status=turn.status==='completed'?'done':'interrupted';job.answer=parts.join('\n\n');await save(job);return
        }
        if(turn.status==='failed')throw Error(turn.error?.message||'主机执行失败');
        if(changed)await save(job)
      }
      if(reconcileText&&textChanged){await delay(200);continue}
      await new Promise(resolve=>{
        const timer=setTimeout(()=>wake(),stream&&!ended?12000:1000);
        wake=()=>{clearTimeout(timer);wake=null;resolve()}
      })
    }
  }finally{
    for(const [handle,approval] of nativeApprovals)if(approval.job===job)nativeApprovals.delete(handle);
    await stream?.close().catch(()=>{});controller?.abort()
  }
}
async function work(job,prompt,previous,freshSubmission=false){
  let prepared=false;
  try{
    if(job.backend==='native'&&job.turn){await nativeTurn(job,null,null,null);return}
    const native=deviceId&&(await openRemote()).nativeCall;
    if(native){job.backend='native';await nativeTurn(job,prompt,previous,native);return}
    if(job.selection?.sandbox==='remote-workspace')throw Error('此设备没有原生 Codex 接口');
    const launch=prompt!==null?await prepareLaunch(job,prompt,previous):null;
    prepared=true;
    if(job.backend==='daemon')await watchTurn(job,launch,freshSubmission);
    else{
      if(launch){
        const ack=await readRemote(launch);
        if(!ack.endsWith('ACK'))throw Error('主机没有确认任务启动');
        job.status='waiting';await save(job)
      }
      await reconcile(job)
    }
  }
  catch(e){
    const pendingReceipt=job.backend==='native'&&job.nativeSubmitting&&!job.turn;
    if(freshSubmission&&!prepared&&!pendingReceipt&&e.code==='REMOTE_HOST_OFFLINE')job.notSubmitted=true;
    const lostReceipt=pendingReceipt&&(e.retryable||/OFFLINE|TRANSPORT|CONNECT|TIMEOUT|TIMEDOUT|ABORT/i.test(String(e.code||e.name)));
    if(lostReceipt)job.receiptUnknown=true;
    job.status='error';job.error=lostReceipt?'未收到启动回执，主机可能已接受消息。请先查看此聊天的主机记录，再决定是否重发。':e.message.startsWith('Command failed')?'Remote 连接中断，请检查主机连接':e.message.slice(0,500);
    await save(job)
  }
  finally{busy.delete(job.id);liveJobs.delete(job.id);freshInputs.delete(job.id)}
}
let dictating=false;
const assets=new Map([
  ['/app.webmanifest',['app.webmanifest','application/manifest+json']], ['/receiver-worker.js',['receiver-worker.js','application/javascript']],
  ['/launcher-192.png',['launcher-192.png','image/png']], ['/launcher-512.png',['launcher-512.png','image/png']],
  ['/voice-chat.js',['voice-chat.js','application/javascript']], ['/dictation.js',['dictation.js','application/javascript']], ['/voice-capture.js',['voice-capture.js','application/javascript']],
  ['/',['index.html','text/html']], ['/chat.css',['chat.css','text/css']],
  ['/chat.js',['chat.js','application/javascript']], ['/markdown.js',['markdown.js','application/javascript']],
  ['/icons.svg',['icons.svg','image/svg+xml']], ['/codex.png',['codex.png','image/png']]
]);
// Keep the running receiver's identity when a new package is unpacked over its files.
const receiverHash=createHash('sha256');
for(const name of ['server.mjs','transport.mjs','thread-api.py','daemon-turn.py','follow-events.py']){
  const bytes=await readFile(new URL(name,import.meta.url));
  receiverHash.update(createHash('sha256').update(bytes).digest())
}
const receiverVersion=receiverHash.digest('hex').slice(0,16);
const assetDigests=new Map();
async function clientVersion(indexBytes){
  const hash=createHash('sha256');
  const digests=await Promise.all([...assets.values()].map(async([name])=>{
    if(name==='index.html'&&indexBytes)return createHash('sha256').update(indexBytes).digest();
    const file=new URL(name,import.meta.url);
    const info=await stat(file,{bigint:true});
    const stamp=[info.ino,info.size,info.mtimeNs,info.ctimeNs].join('/');
    const cached=assetDigests.get(name);
    if(cached?.stamp===stamp)return cached.digest;
    const digest=createHash('sha256').update(await readFile(file)).digest();
    assetDigests.set(name,{stamp,digest});return digest
  }));
  for(const digest of digests)hash.update(digest);
  return hash.digest('hex').slice(0,16)
}
export async function handleRequest(req,res,deviceName='所选设备'){
  const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
  try{
    if(req.headers.host!=='127.0.0.1:'+port)return json(403,{error:'无效主机'});
    if(!deviceId){
      const route=req.url.match(/^\/devices\/([0-9a-f]{64})(\/[^#]*)$/);
      if(route){
        const [,scope,path]=route;
        if(path==='/'||hostDirectory.stale()){
          try{await hostDirectory.list()}catch(error){
            if(req.method!=='GET'||path!=='/')throw error;
            res.writeHead(303,{Location:'/devices#directory-unavailable','Cache-Control':'no-store'});return res.end()
          }
        }
        const device=hostDirectory.devices.get(scope);
        if(path==='/'&&(!device||device.online===false)){
          res.writeHead(303,{Location:'/devices','Cache-Control':'no-store'});return res.end()
        }
        if(!device){res.setHeader('X-Receiver-Device-Access','revoked');return json(403,{error:'当前账号无法访问此设备'})}
        const url=new URL(import.meta.url);url.searchParams.set('device',device.deviceId);
        let context=deviceContexts.get(scope);
        if(!context){context=import(url.href);deviceContexts.set(scope,context)}
        req.url=path;
        const handler=await context;
        if(!hostDirectory.devices.has(scope)){res.setHeader('X-Receiver-Device-Access','revoked');return json(403,{error:'当前账号无法访问此设备'})}
        if(req.method==='GET'&&(path==='/api/directory-events'||path.startsWith('/api/thread-events/')||/^\/api\/turn\/[^/]+\/events$/.test(path)))
          hostDirectory.watch(scope,res,path==='/api/directory-events');
        return await handler.handleRequest(req,res,hostDirectory.devices.get(scope).name||'所选设备')
      }
      if(req.url.startsWith('/api/')&&!['/api/devices','/api/client-version'].includes(req.url))return json(409,{error:'请先选择设备'});
      if(req.method==='GET'&&(req.url==='/'||req.url==='/devices')){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
        return res.end(await readFile(new URL('devices.html',import.meta.url)))
      }
    }
    if(req.method==='POST'&&req.url==='/api/devices'){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      return json(200,{devices:await hostDirectory.list()})
    }
    if(req.method==='GET'&&req.url==='/api/directory-events'){
      if(req.headers['sec-fetch-site']!=='same-origin')return json(403,{error:'无效订阅'});
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
      if(deviceId)res.write(deviceNameEvent(deviceName));
      const missed=req.headers['last-event-id']&&req.headers['last-event-id']!==directoryRevision;
      res.write('retry: 3000\nid: '+directoryRevision+'\ndata: '+(missed?'changed':'ready')+'\n\n');
      directoryListeners.add(res);res.once('close',()=>directoryListeners.delete(res));return
    }
    if(req.method==='GET'&&req.url.startsWith('/api/thread-events/')){
      const thread=req.url.slice('/api/thread-events/'.length);
      if(req.headers['sec-fetch-site']!=='same-origin'||!uuid.test(thread))return json(403,{error:'无效订阅'});
      const stop=new AbortController();
      res.on('close',()=>stop.abort());
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
      res.write('retry: 5000\n\n');
      try{
        const client=deviceId&&(await openRemote()).nativeStream;
        if(client){
          if(stop.signal.aborted)return;
          const stream=await client.subscribe(thread,({method,params})=>{
            if(stop.signal.aborted||params?.threadId!==thread)return;
            if(res.writableNeedDrain){stop.abort();return}
            const {turnId,itemId,item}=params;
            if(method==='item/agentMessage/delta'&&typeof params.delta==='string')
              res.write('event: text\ndata: '+JSON.stringify([turnId,itemId,params.delta])+'\n\n');
            else if(method==='item/started'&&item?.type==='agentMessage')
              res.write('event: text\ndata: '+JSON.stringify([turnId,item.id,null])+'\n\n');
            else if(['turn/started','turn/completed','thread/name/updated','item/completed'].includes(method))
              res.write('data: CHANGED\n\n')
          },stop.signal,()=>stop.abort());
          try{
            if(!stop.signal.aborted){
              res.write('data: READY\n\n');
              await new Promise(resolve=>stop.signal.addEventListener('abort',resolve,{once:true}))
            }
          }finally{await stream.close()}
          return
        }
        const path=await runtimeDriver();
        for await(const line of remoteLines('timeout 300 python3 -u '+path+' --observe '+thread,true,false,null,stop.signal)){
          if(line==='READY'||line==='CHANGED')res.write('data: '+line+'\n\n')
          else if(line.startsWith('TEXT '))res.write('event: text\ndata: '+line.slice(5)+'\n\n')
        }
      }catch{/* EventSource reconnects and reconciles with the current host state. */}
      finally{res.end()}
      return
    }
    if(req.method==='GET'&&req.url==='/api/client-version')return json(200,{version:await clientVersion(),receiverVersion});
    if(req.method==='GET' && assets.has(req.url)){
      const [name,type]=assets.get(req.url);
      const bytes=await readFile(new URL(name,import.meta.url));
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff'});
      const htmlDeviceName=deviceName.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
      return res.end(name==='index.html'?bytes.toString().replaceAll('tim-SER',()=>htmlDeviceName).replace('<head>',()=>'<head><meta name="receiver-name" content="'+htmlDeviceName+'"><meta name="receiver-scope" content="'+deviceScope+'">').replace('__DICTATION_ENGINE__',process.platform==='win32'?'windows':'browser').replace('content="__CLIENT_VERSION__"','content="'+await clientVersion(bytes)+'"'):bytes)
    }
    if(req.method==='POST'&&['/api/voice/start','/api/voice/status','/api/voice/heartbeat','/api/voice/stop'].includes(req.url))return await voiceRequest(req,json);
    if(req.method==='POST'&&req.url==='/api/dictation'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='audio/wav')return json(403,{error:'无效请求来源'});
      if(process.platform!=='win32')return json(501,{error:'此版本的离线听写需要 Windows 中文语音识别器'});
      if(dictating)return json(429,{error:'本机正在转写另一段听写'});
      dictating=true;
      try{
        const chunks=[];let size=0;
        for await(const c of req){size+=c.length;if(size>1920044)return json(413,{error:'录音超过一分钟'});chunks.push(c)}
        const w=Buffer.concat(chunks);
        if(w.length<=44||(w.length%2)||w.toString('ascii',0,4)!=='RIFF'||w.toString('ascii',8,16)!=='WAVEfmt '||
           w.readUInt32LE(16)!==16||w.readUInt16LE(20)!==1||w.readUInt16LE(22)!==1||w.readUInt32LE(24)!==16000||
           w.readUInt16LE(34)!==16||w.toString('ascii',36,40)!=='data'||w.readUInt32LE(40)!==w.length-44)
          return json(400,{error:'录音格式无效'});
        const text=await new Promise((resolve,reject)=>{
          const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./dictation.ps1',import.meta.url))],
            {windowsHide:true,timeout:90000,maxBuffer:65536,encoding:'utf8'},(err,out)=>err?reject(err):resolve(out.trim()));
          child.stdin.on('error',()=>{});child.stdin.end(w)
        });
        return json(200,{text})
      }catch(e){return json(503,{error:e.code===2?'请安装 Windows 简体中文语音识别器':'本机语音识别未完成'})}
      finally{dictating=false}
    }
    if(req.method==='POST'&&req.url==='/api/scheduled-local/runs'){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)return json(413,{error:'请求过长'})}
      const {id,cursor}=JSON.parse(body);
      if(typeof id!=='string'||!id||id.length>255||cursor!=null&&(!Array.isArray(cursor)||cursor.length!==2||
        !Number.isSafeInteger(cursor[0])||typeof cursor[1]!=='string'||cursor[1].length>255))return json(400,{error:'无效的任务或游标'});
      return json(200,await remoteThreads('scheduled-local',JSON.stringify({id,cursor})))
    }
    if(req.method==='POST'&&req.url==='/api/scheduled-local'){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      return json(200,await remoteThreads('scheduled-local','-'))
    }
    if(req.method==='POST'&&req.url==='/api/account-usage'){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      const path=await runtimeDriver();
      const data=JSON.parse(await readRemote('timeout 35 python3 '+path+' --usage'));
      if(!Array.isArray(data.groups))return json(503,{error:'主机暂时无法读取账号用量'});
      return json(200,data)
    }
    if(req.method==='POST'&&req.url==='/api/read-state'){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)return json(413,{error:'请求过长'})}
      const {thread,revision,operation}=JSON.parse(body);
      if(!uuid.test(thread)||typeof revision!=='string'||!revision||revision.length>1024||!['read','unread'].includes(operation))return json(400,{error:'无效已读状态请求'});
      const result=await remoteThreads('read-state-update',JSON.stringify({thread,revision,operation}));
      if(!result.conflict)directoryChanged();
      return json(result.conflict?409:200,result)
    }
    if(req.method==='POST'&&req.url==='/api/active-threads'){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      const path=await runtimeDriver();
      const result=JSON.parse(await readRemote('timeout 35 python3 '+path+' --active-threads'));
      if(!Array.isArray(result.items))return json(503,{error:'主机没有返回活动会话目录'});
      return json(200,result)
    }
    if(req.method==='POST'&&req.url?.startsWith('/api/thread-activity/')){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      const thread=req.url.slice('/api/thread-activity/'.length);
      if(!uuid.test(thread))return json(400,{error:'无效会话'});
      const native=deviceId&&(await openRemote()).nativeCall;
      if(native){
        const record=(await native('thread/read',{threadId:thread,includeTurns:true})).thread;
        if(record.id!==thread)return json(409,{error:'主机返回的会话与请求不一致'});
        const latest=record.turns?.at(-1);
        return json(200,{thread,turn:latest?.id,turnStatus:latest?.status,state:record.status?.type,activeFlags:record.status?.activeFlags||[]})
      }
      const path=await runtimeDriver();
      const snapshot=JSON.parse(await readRemote('timeout 20 python3 '+path+' --activity '+thread));
      if(snapshot.thread!==thread)return json(409,{error:'共享 App Server 暂未返回该会话状态'});
      return json(200,snapshot)
    }
    if(req.method==='GET'&&req.url==='/api/native-capability')return json(200,{native:!!(deviceId&&(await openRemote()).nativeCall)});
    if(req.method==='GET'&&req.url==='/api/capabilities')return json(200,{planMode:!(deviceId&&(await openRemote()).nativeCall),projectFiles:true,commandApproval:true,fullAccess:true,voiceChat:true});
    if(req.method==='POST'&&['/api/plugins/page','/api/plugins/detail'].includes(req.url)){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>2048)return json(413,{error:'查询过长'});chunks.push(chunk)}
      const request=JSON.parse(Buffer.concat(chunks));
      if(req.url==='/api/plugins/detail'){
        const {market,catalogName}=request;
        if(![market,catalogName].every(v=>typeof v==='string'&&v.length>0&&v.length<=256))return json(400,{error:'无效插件标识'});
        return json(200,await remoteThreads('plugin-detail',JSON.stringify({market,catalogName})))
      }
      const {query='',group=null,offset=0}=request;
      if(typeof query!=='string'||query.length>180||![null,true,false].includes(group)||!Number.isSafeInteger(offset)||offset<0)
        return json(400,{error:'无效插件查询'});
      const key=JSON.stringify({query:query.trim(),group,offset});
      let page=pluginPages.get(key);
      if(!page||Date.now()-page.created>=300000){
        if(pluginPages.size>=64)pluginPages.delete(pluginPages.keys().next().value);
        const flight=remoteThreads('plugin-page',key).catch(error=>{if(pluginPages.get(key)?.flight===flight)pluginPages.delete(key);throw error});
        page={created:Date.now(),flight};pluginPages.set(key,page)
      }
      return json(200,await page.flight)
    }
    if(req.method==='POST'&&req.url==='/api/plugins'){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      if(!pluginCatalog||Date.now()-pluginCatalog.created>=300000){
        const flight=remoteThreads('plugins','').catch(error=>{if(pluginCatalog?.flight===flight)pluginCatalog=null;throw error});
        pluginCatalog={created:Date.now(),flight}
      }
      return json(200,await pluginCatalog.flight)
    }
    if(req.method==='POST'&&req.url==='/api/project-file-snapshot'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const parts=[];let size=0;
      for await(const part of req){size+=part.length;if(size>16384)return json(413,{error:'路径过长'});parts.push(part)}
      const {root,path,thread}=JSON.parse(Buffer.concat(parts));
      if(typeof root!=='string'||typeof path!=='string')return json(400,{error:'路径无效'});
      if([...nativeRoots.values()].some(roots=>roots.includes(root))){
        const paths=/^[a-z]:[\\/]/i.test(root)?win32:posix;
        const relative=paths.relative(root,path);
        const within=name=>name&&name!=='..'&&!name.startsWith('..'+paths.sep)&&!paths.isAbsolute(name);
        if(!uuid.test(thread)||!paths.isAbsolute(path)||!within(relative)||relative.split(paths.sep).some(part=>/[:\x00-\x1f]/.test(part)||(paths===win32&&/[. ]$/.test(part))))
          return json(400,{error:'请选择当前聊天项目内的文件'});
        const ctx=await openRemote();
        if(!ctx.readWorkspaceFile)return json(400,{error:'当前主机未提供文件预览'});
        const info=(await ctx.nativeCall('thread/read',{threadId:thread,includeTurns:false})).thread;
        if(info?.id!==thread||!paths.isAbsolute(info.cwd||''))return json(403,{error:'聊天目录不可用'});
        const scope=paths.relative(root,info.cwd),file=paths.relative(info.cwd,path);
        if((scope&&!within(scope))||!within(file))return json(403,{error:'文件不在当前聊天目录内'});
        const result=await ctx.readWorkspaceFile(thread,file.split(paths.sep).join('/'));
        if(!paths.isAbsolute(result.absolutePath||'')||paths.relative(path,result.absolutePath)!=='')return json(409,{error:'主机返回的路径不一致'});
        if(result.eof!==true||typeof result.text!=='string'||result.text.includes('\0')||Buffer.byteLength(result.text)>512*1024)return json(422,{error:'仅支持预览较短的文本文件'});
        return json(200,{text:result.text,source:'working-tree'})
      }
      if(!fileSearchRoots.has(root)||typeof path!=='string'||!path.startsWith(root+'/')||path.includes('\0'))return json(400,{error:'请选择主机项目内的文件'});
      return json(200,await remoteThreads('project-file-snapshot',JSON.stringify({root,path})))
    }
    if(req.method==='POST'&&req.url==='/api/project-directories'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>16384)return json(413,{error:'路径过长'});chunks.push(chunk)}
      const {root,relative,thread}=JSON.parse(Buffer.concat(chunks));
      if(![...nativeRoots.values()].some(roots=>roots.includes(root)))return json(400,{error:'请先加载当前主机的项目目录'});
      const paths=/^(?:[a-z]:|\\\\)/i.test(root)?win32:posix;
      const valid=name=>typeof name==='string'&&name&&name!=='.'&&name!=='..'&&!/[\\/:\x00-\x1f]/.test(name)&&
        (paths!==win32||!/[. ]$/.test(name));
      if(typeof relative!=='string'||(relative&&!relative.split('/').every(valid)))return json(400,{error:'请选择项目内的目录'});
      const requested=paths.join(root,relative);
      const ctx=deviceId&&await openRemote(),call=ctx?.nativeCall;
      if(!call)return json(400,{error:'当前连接未提供目录浏览'});
      if(thread!=null&&!uuid.test(thread))return json(400,{error:'无效的聊天标识'});
      if(ctx.listWorkspaceFiles){
        // The file API is scoped to a host thread, even when the composer is new.
        const candidates=thread?[(await call('thread/read',{threadId:thread,includeTurns:false})).thread]:
          (await call('thread/list',{cwd:[root],limit:1})).data;
        const match=candidates.find(t=>uuid.test(t?.id)&&paths.isAbsolute(t.cwd||'')&&paths.relative(root,t.cwd)==='');
        if(match){
          try{
            const listing=await ctx.listWorkspaceFiles(match.id,relative||'.');
            const names=type=>listing.entries.filter(e=>e.type===type&&valid(e.name)).map(e=>e.name);
            return json(200,{folders:names('directory'),files:names('file'),truncated:listing.truncated===true})
          }catch(error){if(!['FEATURE_NOT_SUPPORTED','METHOD_NOT_FOUND'].includes(error.code))throw error}
        }
      }
      const result=await call('dsh/directoryList',{path:requested});
      if(paths.relative(requested,result.path)!=='')return json(409,{error:'主机返回的目录与请求不一致'});
      return json(200,{folders:result.entries.filter(e=>valid(e.name)&&paths.relative(requested,e.path)===e.name).map(e=>e.name),truncated:result.truncated===true})
    }
    if(req.method==='POST'&&req.url==='/api/project-files'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>2048)return json(413,{error:'查询过长'});parts.push(part)}
      const {root,query}=JSON.parse(Buffer.concat(parts));
      if(!fileSearchRoots.has(root))return json(400,{error:'请先加载主机项目目录'});
      if(typeof query!=='string'||!query.trim()||query.length>180)return json(400,{error:'请输入文件名'});
      return json(200,await remoteThreads('project-files',JSON.stringify({root,query:query.trim()})))
    }
    if(req.method==='POST'&&req.url==='/api/connection'){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      const ctx=deviceId&&await openRemote();
      if(ctx?.nativeCall)return json(200,{host:deviceName,checkedAt:Date.now(),mode:ctx.transportMode(),lastDisconnect:ctx.lastDisconnect?.(),nativeCodex:true,appServerReady:true});
      const path=await runtimeDriver();
      let mode,nativeCodex;
      const probe='if result=$(timeout 20 python3 '+path+' --health 2>/dev/null); then printf "%s\\n" "$result"; else echo \'{"ready":false}\'; fi';
      const result=JSON.parse(await readRemote(probe,(route,native)=>{
        mode=route;nativeCodex=native
      }));
      return json(200,{host:deviceId?deviceName:'tim-SER',checkedAt:Date.now(),mode,nativeCodex,lastDisconnect:ctx?.lastDisconnect?.(),appServerReady:result.ready===true})
    }
    if(req.method==='POST' && req.url?.split('?')[0]==='/api/models'){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      const cwd=new URL(req.url,origin).searchParams.get('cwd')||'';
      if(cwd&&!allowedProjects.has(cwd))return json(400,{error:'未知主机项目'});
      return json(200,await models(cwd))
    }
    if(req.method==='POST'&&req.url==='/api/thread-goal'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>131072)return json(413,{error:'目标过长'});chunks.push(chunk)}
      const {thread,expected,objective,status,clear}=JSON.parse(Buffer.concat(chunks));
      if(!uuid.test(thread)||typeof expected?.objective!=='string'||typeof expected.status!=='string'||!Number.isFinite(expected.createdAt))return json(400,{error:'缺少目标版本'});
      const update={};
      if(clear!==undefined){if(clear!==true||status!==undefined||objective!==undefined)return json(400,{error:'无效清除请求'});update.clear=true}
      else if(typeof objective==='string'&&objective.trim()&&status===undefined)update.objective=objective.trim();
      else if(objective===undefined&&((status==='paused'&&expected.status==='active')||(status==='active'&&expected.status==='paused')))update.status=status;
      else return json(400,{error:'无效的目标修改'});
      const before={objective:expected.objective,status:expected.status,createdAt:expected.createdAt};
      const payload=Buffer.from(JSON.stringify({expected:before,update})),dir=directory(randomUUID()),driver=await runtimeDriver();
      try{
        for(let i=0;i<payload.length;i+=1350){
          const prefix=i===0?'umask 077; mkdir -m 700 '+dir+' && ':'';
          const file=dir+'/part-'+String(i).padStart(6,'0');
          const ok=await command(prefix+'printf %s '+payload.subarray(i,i+1350).toString('base64')+' | base64 -d >'+file+' && echo READY');
          if(ok!=='READY')throw Error('目标内容未送达')
        }
        const reply=JSON.parse(await command('cat '+dir+'/part-* >'+dir+'/input && python3 '+driver+' --edit-goal '+thread+' '+dir+'/input'));
        if(reply.conflict)return json(409,{error:'主机目标已更新，请重新打开目标卡',goal:reply.goal});
        if(update.clear&&reply.cleared===true)return json(200,{goal:null});
        if(!reply.goal)return json(502,{error:'主机未确认目标修改'});
        return json(200,{goal:reply.goal})
      }finally{await command('rm -f '+dir+'/part-* '+dir+'/input; rmdir '+dir).catch(()=>{})}
    }
    if(req.method==='POST'&&req.url==='/api/archives'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const parts=[];let size=0;for await(const c of req){size+=c.length;if(size>4096)return json(413,{error:'请求过长'});parts.push(c)}
      const {ids,archived,cursor}=JSON.parse(Buffer.concat(parts));
      if(ids===undefined&&archived===undefined){
        if(cursor!==undefined&&(typeof cursor!=='string'||cursor.length>2048))return json(400,{error:'无效页码'});
        return json(200,await remoteThreads('archived',cursor||'-'))
      }
      if(!Array.isArray(ids)||!ids.length||ids.length>30||!ids.every(id=>typeof id==='string'&&uuid.test(id)))return json(400,{error:'无效会话'});
      if(archived!==undefined&&(ids.length!==1||typeof archived!=='boolean'))return json(400,{error:'无效归档操作'});
      const result=await remoteThreads(archived===undefined?'archive-check':'archive-set',JSON.stringify({ids,archived}));
      if(archived!==undefined)directoryChanged();
      return json(200,result)
    }
    if(req.method==='POST'&&req.url==='/api/thread-pin'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>512)return json(413,{error:'请求过长'});parts.push(part)}
      const {thread,pinned,expected}=JSON.parse(Buffer.concat(parts));
      if(!uuid.test(thread)||typeof pinned!=='boolean'||(expected!==null&&!uuid.test(expected)))return json(400,{error:'无效分组'});
      const result=await remoteThreads('pin',JSON.stringify({thread,pinned,expected}));
      if(!result.conflict)directoryChanged();
      return json(200,result)
    }
    if(req.method==='POST'&&req.url==='/api/thread-fork'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>4096)return json(413,{error:'请求过长'});chunks.push(c)}
      const {thread,request,lastTurn}=JSON.parse(Buffer.concat(chunks));
      if(!uuid.test(thread)||!uuid.test(request)||(lastTurn!==undefined&&!uuid.test(lastTurn)))return json(400,{error:'无效会话、轮次或请求'});
      const native=deviceId&&(await openRemote()).nativeCall;
      if(native){
        const receipt=new URL('fork-'+request+'.json',stateDir);
        const key=JSON.stringify([thread,lastTurn||null]);
        try{await writeFile(receipt,JSON.stringify({key}),{flag:'wx',mode:0o600})}
        catch(error){
          if(error.code!=='EEXIST')throw error;
          const saved=JSON.parse(await readFile(receipt,'utf8'));
          if(saved.key!==key)return json(409,{error:'分支请求对应的原会话或轮次不一致'});
          if(!uuid.test(saved.thread))return json(409,{error:'尚未收到分支结果，请核对主机会话目录'});
          return json(200,{source:thread,thread:saved.thread})
        }
        const result=await native('thread/fork',{threadId:thread,...(lastTurn?{lastTurnId:lastTurn}:{})});
        const fork=result.thread?.id;
        if(!uuid.test(fork)||fork===thread)return json(409,{error:'主机尚未确认分支'});
        const temp=new URL('fork-'+randomUUID()+'.tmp',stateDir);
        await writeFile(temp,JSON.stringify({key,thread:fork}),{mode:0o600});await rename(temp,receipt);
        directoryChanged();return json(200,{source:thread,thread:fork})
      }
      const path=await runtimeDriver();
      const fork=JSON.parse(await readRemote('timeout 45 python3 '+path+' --fork '+thread+' '+request+(lastTurn?' '+lastTurn:'')));
      if(fork.source!==thread||!uuid.test(fork.thread)||fork.thread===thread)return json(409,{error:fork.error?.message||'主机尚未确认分支'});
      directoryChanged();return json(200,fork)
    }
    if(req.method==='POST' && req.url==='/api/thread-name'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>4096)return json(413,{error:'请求过长'});chunks.push(c)}
      const {thread,name}=JSON.parse(Buffer.concat(chunks));
      if(!uuid.test(thread)||typeof name!=='string'||!name.trim()||name.trim().length>120)return json(400,{error:'无效会话或标题'});
      const native=deviceId&&(await openRemote()).nativeCall;
      if(native){
        const title=name.trim();
        await native('thread/name/set',{threadId:thread,name:title});
        const confirmed=await native('thread/read',{threadId:thread,includeTurns:false});
        if(confirmed.thread?.id!==thread||confirmed.thread.name!==title)return json(409,{error:'主机尚未确认新标题，请刷新后重试'});
        directoryChanged({thread,title});return json(200,{thread,name:title})
      }
      const next=name.trim(),path=await runtimeDriver(),encoded=Buffer.from(next).toString('base64');
      const lookup=async()=>JSON.parse(await readRemote('python3 '+path+' --get-name '+thread));
      let actual=await lookup();const previous=actual.name;
      for(let attempt=0;attempt<3&&actual.name!==next;attempt++){
        if(actual.thread!==thread||actual.name!==previous)break;
        try{actual=JSON.parse(await command('python3 '+path+' --name '+thread+' '+encoded,attempt>0))}
        catch{actual=await lookup()}
      }
      if(actual.thread!==thread||actual.name!==next)return json(409,{error:'主机尚未确认新标题，请刷新后重试'});
      if(previous!==next)directoryChanged({thread,title:actual.name});
      return json(200,actual)
    }
    if(req.method==='POST' && req.url==='/api/threads'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>4096)return json(413,{error:'请求过长'});chunks.push(c)}
      const {thread,cursor,term,shared,projectId,projectCwd,opening}=JSON.parse(Buffer.concat(chunks));
      if(term!==undefined&&(thread||typeof term!=='string'||!term.trim()||term.length>180))return json(400,{error:'无效搜索词'});
      if(thread&&!uuid.test(thread)||cursor&&(typeof cursor!=='string'||cursor.length>2048))return json(400,{error:'无效会话'});
      if(projectId!==undefined||projectCwd!==undefined){
        const validScope=projectId===undefined?allowedProjects.has(projectCwd):
          projectCwd===undefined&&typeof projectId==='string'&&(knownProjectIds.has(projectId)||uuid.test(projectId));
        if(thread||term!==undefined||!validScope)return json(400,{error:'无效项目'});
        return json(200,await remoteThreads('project-page',JSON.stringify({projectId,projectCwd,cursor})))
      }
      const activeTurn=()=>Array.from(liveJobs.values()).find(job=>job.thread===thread&&job.turn&&job.status==='waiting');
      const before=thread&&activeTurn();
      let data;
      if(before&&freshInputs.has(before.id)){
        data={thread,name:before.title,cwd:before.cwd,messages:[{role:'user',turn:before.turn,...freshInputs.get(before.id)}]}
      }else if(term)data=await remoteThreads('search',JSON.stringify({term,cursor}));
      else if(!thread&&!cursor)data=await firstDirectoryPage();
      else if(thread&&opening===true)data=await openHistory(shared===true?'shared-read':'read',thread);
      else data=await remoteThreads(thread?(shared===true?'shared-read':'read'):'list',thread||cursor||'-');
      if(!thread&&!cursor){
        const present=new Set(data.items.map(item=>item.thread));
        for(const job of liveJobs.values()){
          if(!job.thread||!job.turn||job.status!=='waiting'||present.has(job.thread))continue;
          const title=job.title||'执行中的任务';
          if(term&&!title.toLowerCase().includes(term.toLowerCase()))continue;
          data.items.unshift({thread:job.thread,title,cwd:job.cwd||'',updated:Math.floor(job.created/1000)});
          present.add(job.thread)
        }
      }
      if(!thread&&directoryWaitFlags.size){
        const withWait=item=>directoryWaitFlags.has(item.thread)?{...item,activeFlags:[directoryWaitFlags.get(item.thread)]}:item;
        data={...data,items:data.items.map(withWait),...(data.pinned?{pinned:data.pinned.map(withWait)}:{})}
      }
      if(thread){
        if(data.thread!==thread||!Array.isArray(data.messages))return json(502,{error:'主机返回的聊天记录与请求不匹配，请重新读取'});
        const live=activeTurn()||before;
        if(live){
          data.pending=live.id;data.turn=live.turn;
          data.messages=data.messages.filter(m=>m.turn!==live.turn||m.role==='user')
        }else if(!data.activeTurn){
          data.parent=await historyParent(thread,data.cwd)
        }
      }
      return json(200,data)
    }
    if(req.method==='POST'&&req.url?.startsWith('/api/answer/')){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const id=req.url.slice('/api/answer/'.length);
      if(!uuid.test(id))return json(400,{error:'无效任务'});
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16000)return json(413,{error:'回答超过 16 KB'});chunks.push(chunk)}
      const {turn,token,answers}=JSON.parse(Buffer.concat(chunks)),job=liveJobs.get(id);
      const questions=uuid.test(token)&&job?.inputRequests?.[token];
      if(job?.status!=='waiting'||job.turn!==turn||!questions)return json(409,{error:'此问题已关闭'});
      if(!answers||typeof answers!=='object'||Object.keys(answers).length!==questions.length||
        !questions.every(q=>{
          const values=answers[q.id]?.answers;
          return Object.hasOwn(answers,q.id)&&Array.isArray(values)&&values.length===1&&
            typeof values[0]==='string'&&values[0].trim()&&
            (!q.options?.length||q.isOther||q.options.some(o=>o.label===values[0]))
        }))return json(400,{error:'请回答每个问题'});
      if(job.backend==='native'){
        const approval=nativeApprovals.get(token),decision=nativeDecisions.get(answers.decision?.answers?.[0]);
        if(approval?.job!==job||approval.turn!==turn||approval.sending||!decision)return json(409,{error:'审批请求已关闭或正在提交'});
        approval.sending=true;
        try{
          const client=(await openRemote()).nativeStream;
          await client.respond(token,decision,AbortSignal.timeout(10000))
        }catch(error){
          if(error.code!=='CODEX_APPROVAL_NOT_FOUND'){approval.sending=false;throw error}
          delete job.inputRequests[token];nativeApprovals.delete(token);notify(job);
          return json(409,{error:'主机上的审批请求已关闭'})
        }
        delete job.inputRequests[token];nativeApprovals.delete(token);notify(job);
        return json(202,{token})
      }
      const base=directory(id),tmp=base+'/input-'+randomUUID(),dest=base+'/answer-'+token;
      const parts=Buffer.from(JSON.stringify(answers)).toString('base64').match(/.{1,2000}/g);
      try{
        for(const [i,part] of parts.entries()){
          const ok=await readRemote('umask 077; printf %s '+part+' | base64 -d >'+tmp+'-'+i+' && echo OK');
          if(ok!=='OK')throw Error('主机未确认收到回答')
        }
        if(!job.inputRequests?.[token])return json(409,{error:'此问题已关闭'});
        const files=parts.map((_,i)=>tmp+'-'+i).join(' ');
        const result=await command('umask 077; if cat '+files+' >'+tmp+'; then '+
          'if ln '+tmp+' '+dest+' 2>/dev/null; then echo OK; '+
          'elif test -f '+dest+'; then cmp -s '+tmp+' '+dest+
          '; case $? in 0) echo OK;; 1) echo CONFLICT;; esac; fi; fi');
        if(result==='CONFLICT')return json(409,{error:'主机已有其他回答'});
        if(result!=='OK')return json(503,{error:'主机未确认保存回答，请重试'});
        // The host has reserved the token. Other viewers can dismiss this form
        // immediately, even while the host response event is still in transit.
        if(job.inputRequests?.[token]){
          delete job.inputRequests[token];
          notify(job)
        }
        return json(202,{token})
      }finally{void command('rm -f '+[tmp,...parts.map((_,i)=>tmp+'-'+i)].join(' ')).catch(()=>{})}
    }
    if(req.method==='POST'&&(req.url?.startsWith('/api/steer/')||req.url?.startsWith('/api/thread-steer/'))){
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const shared=req.url.startsWith('/api/thread-steer/'),id=req.url.split('/').at(-1);
      if(!uuid.test(id))return json(400,{error:'无效任务'});
      const job=shared?null:liveJobs.get(id);
      const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>450000)return json(413,{error:'输入过长'});chunks.push(c)}
      const {text,images=[],request,turn}=JSON.parse(Buffer.concat(chunks));
      if(!uuid.test(request)||!uuid.test(turn)||!validImages(images)||typeof text!=='string'||(!text.trim()&&!images.length)||Buffer.byteLength(text)>16000)return json(400,{error:'无效补充要求'});
      if(!shared&&(!job||job.status!=='waiting'||job.turn!==turn))return json(409,{error:'这轮任务已经结束'});
      if(images.length&&job&&!job.imageSteer)return json(409,{error:'此任务由旧版客户端启动，图片可随下一轮发送'});
      const native=deviceId&&(await openRemote()).nativeCall;
      if(native){
        try{await nativeSteer(native,shared?id:job.thread,turn,request,text,images)}
        catch(error){
          if(error.code==='CODEX_THREAD_NOT_ALLOWED')return json(403,{error:'主机当前未允许访问此聊天，补充要求仍保留在输入框中'});
          if(error.code==='CODEX_THREAD_BUSY')return json(409,{error:'其他连接正在操作本轮，请核对主机状态'});
          if(!error.code)return json(409,{error:error.message});
          throw error
        }
        if(job){
          const messages=job.supplements??=[];
          if(!messages.some(m=>m.clientId===request))messages.push({clientId:request,turn,text,images});
          notify(job)
        }
        return json(200,{turn})
      }
      const dir=shared?directory(turn)+'-steer':directory(id);
      const driver=shared?await runtimeDriver():dir+'/turn.py';
      if(shared)await readRemote('umask 077; (mkdir -m 700 '+dir+' || (test -O '+dir+' && test -d '+dir+' && test ! -L '+dir+')) && echo READY').then(reply=>{if(!reply.endsWith('READY'))throw Error('主机未确认补充要求目录')});
      const bytes=Buffer.from(turnInput(text,images)),digest=createHash('sha256').update(bytes).digest('hex');
      if(!await uploadSteerInput(dir,request,digest,bytes))return json(503,{error:'主机未确认收到补充要求'});
      const reply=JSON.parse(await readRemote('timeout 35 python3 '+driver+' --steer '+(shared?id:job.thread)+' '+turn+' '+request+' '+digest+(shared?' '+(images.length?'images':'text')+' '+dir:images.length?' images':'')));
      if(reply.turn!==turn)return json(409,{error:reply.error?.message||'主机未确认补充要求'});
      if(shared)return json(200,{turn});
      const messages=job.supplements??=[];
      const existing=messages.find(m=>m.clientId===request);
      if(!existing)messages.push({clientId:request,turn,text,images});
      else if(!existing.images?.length)existing.images=images;
      notify(job);
      return json(200,{turn})
    }
    if(req.method==='POST' && req.url?.startsWith('/api/thread-interrupt/')){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      const [thread,turn,...extra]=req.url.slice('/api/thread-interrupt/'.length).split('/');
      if(extra.length||!uuid.test(thread)||!uuid.test(turn))return json(400,{error:'无效会话或轮次'});
      const native=deviceId&&(await openRemote()).nativeCall;
      if(native){
        const record=(await native('thread/read',{threadId:thread,includeTurns:true})).thread;
        const latest=record.turns?.at(-1);
        if(record.id!==thread||latest?.id!==turn||latest.status!=='inProgress')return json(409,{error:'所选轮次当前没有运行'});
        try{await native('turn/interrupt',{threadId:thread,turnId:turn})}
        catch(error){
          if(error.code==='CODEX_TURN_OWNED')return json(403,{error:'请在发起此轮的 Remote 设备上停止任务'});
          throw error
        }
        return json(202,{thread,turn})
      }
      const driver=await runtimeDriver();
      const result=await readRemote('python3 '+driver+' --interrupt-shared '+thread+' '+turn);
      if(result!=='INTERRUPT_ACCEPTED')return json(409,{error:'该轮次已结束或主机尚未确认停止'});
      return json(202,{thread,turn})
    }
    if(req.method==='POST' && req.url?.startsWith('/api/interrupt/')){
      if(req.headers.origin!==origin)return json(403,{error:'无效请求来源'});
      const id=req.url.slice('/api/interrupt/'.length);
      if(!uuid.test(id))return json(400,{error:'无效任务'});
      const job=liveJobs.get(id)||await readStoredJob(id);
      if(job.backend==='native'&&uuid.test(job.thread)&&uuid.test(job.turn)&&job.status==='waiting'){
        await (await openRemote()).nativeCall('turn/interrupt',{threadId:job.thread,turnId:job.turn});return json(202,{id})
      }
      if(job.backend!=='daemon'||!uuid.test(job.thread)||!uuid.test(job.turn)||job.status!=='waiting')
        return json(409,{error:'当前任务尚不可停止或已经结束'});
      const result=await readRemote('python3 '+directory(id)+'/turn.py --interrupt '+job.thread+' '+job.turn);
      if(result!=='INTERRUPT_ACCEPTED')return json(409,{error:'主机未确认停止请求'});
      return json(202,{id})
    }
    if(req.method==='POST' && req.url==='/api/turn'){
      if(req.headers.origin!==origin || req.headers['content-type']!=='application/json')return json(403,{error:'无效请求来源'});
      const chunks=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>450000)return json(413,{error:'消息过长'});chunks.push(chunk)}
      const {id,prompt,parent,expectedThread,cwd,projectId,model,effort,serviceTier,collaborationMode,approvalPolicy="never",sandbox="read-only",images=[]}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!['never','untrusted'].includes(approvalPolicy))return json(400,{error:'无效审批策略'});
      if(collaborationMode!=null&&!['plan','default'].includes(collaborationMode))return json(400,{error:'无效的协作模式'});
      if(!['read-only','workspace-write','danger-full-access','remote-workspace'].includes(sandbox))return json(400,{error:'无效的沙箱模式'});
      if(!validImages(images))return json(400,{error:'仅支持总计 256 KiB 以内的 PNG、JPEG 和 WebP 图片'});
      if(!uuid.test(id)||typeof prompt!=='string'||(!prompt.trim()&&!images.length)||Buffer.byteLength(prompt)>16000)return json(400,{error:'请输入不超过 16 KB 的消息'});
      await requireReceiverIdentity();
      if((collaborationMode==='plan'||serviceTier!=null)&&deviceId&&(await openRemote()).nativeCall)
        return json(400,{error:'当前主机连接仅支持普通聊天，并沿用主机速度'});
      let previous=null,project=cwd;
      if(expectedThread!=null&&!uuid.test(expectedThread)||parent&&!uuid.test(parent))return json(400,{error:'无效会话'});
      if(parent||expectedThread){
        let prior;
        if(parent){
          try{prior=await readStoredJob(parent)}
          catch(error){if(error.code!=='ENOENT'||!expectedThread)throw error}
        }
        if(expectedThread&&prior?.thread!==expectedThread){
          const target=await remoteThreads('shared-read',expectedThread);
          if(target.thread!==expectedThread)return json(409,{error:'无法确认续聊目标，请重新打开会话'});
          if(target.activeTurn)return json(409,{error:'此会话正在运行，请打开当前任务后补充要求'});
          previous=target.thread;project=target.cwd
        }else{
          if(!['done','interrupted'].includes(prior.status)||!uuid.test(prior.thread))return json(409,{error:'上一轮尚未完成'});
          previous=prior.thread;project=prior.cwd
        }
      }else{
        if(project&&!allowedProjects.has(project))return json(400,{error:'请重新从主机加载项目'});
        if(projectId&&!knownProjectIds.has(projectId))return json(400,{error:'请重新从主机加载项目'})
      }
      if(model||effort||serviceTier!=null){
        const selected=(await models(project||'')).models.find(m=>m.id===model);
        if(!selected||effort&&!selected.efforts.includes(effort))return json(400,{error:'所选模型或推理强度不在主机目录中'})
        if(serviceTier!=null&&serviceTier!=='default'&&!selected.serviceTiers?.some(t=>t.id===serviceTier))return json(400,{error:'该模型不支持所选服务档位'})
      }
      const job={id,status:'preparing',backend:'daemon',imageSteer:true,created:Date.now(),title:prompt.trim().split('\n')[0].slice(0,85),cwd:project||null,selection:{model,effort,serviceTier,sandbox,approvalPolicy,collaborationMode,projectId:previous?null:projectId,structuredInput:images.length>0}};
      const input=turnInput(prompt,images);
      if(!await persistSubmission(job,input,previous))return json(200,{id});
      if(!previous)freshInputs.set(id,{text:prompt,images});
      if(!busy.has(id)){busy.add(id);void work(job,input,previous,true)}
      return json(202,{id})
    }
    const id=req.url?.split('/')[3];
    const stream=req.url==='/api/turn/'+id+'/events';
    if(req.method==='GET' && (stream||req.url==='/api/turn/'+id) && uuid.test(id)){
      let stored=liveJobs.get(id);
      if(!stored){
        try{stored=await readStoredJob(id)}
        catch(error){
          if(error.code==='ENOENT')return json(404,{error:'无法找到这轮对话'});
          return json(500,{error:'暂时无法读取本轮提交记录'})
        }
      }
      const {submission,...job}=stored;
      if(!busy.has(id)){
        if(job.status==='waiting'){busy.add(id);void work(job,null,null)}
        else if(job.status==='preparing'){
          if(submission){busy.add(id);void work(job,submission.input,submission.previous)}
          else{job.status='error';job.error='旧版本服务在提交之前中断'}
        }
      }
      if(stream)return streamJob(res,liveJobs.get(id)||job);
      return json(200,job)
    }
    json(404,{error:'未找到'})
  }catch(e){
    const diagnostic=deviceId&&req.method==='POST'&&req.url==='/api/connection'?getLastDisconnect?.():null;
    if(['REMOTE_NOT_PAIRED','REMOTE_HOST_ABSENT','REMOTE_HOST_OFFLINE'].includes(e.code))return json(503,{code:e.code,error:e.message,...(diagnostic&&e.code==='REMOTE_HOST_OFFLINE'?{lastDisconnect:diagnostic}:{})});
    if(/TRANSPORT|CONNECT|TIMEOUT|fetch failed|Control socket|timed out/i.test([e.code,e.message,e.cause?.code].join(' ')))
      return json(503,{error:'ds-harness-remote 连接未就绪，请重试',...(diagnostic?{lastDisconnect:diagnostic}:{})});
    json(400,{error:e.code==='ENOENT'?'无法找到这轮对话':'请求处理失败'})
  }
}
const app=createServer(handleRequest);
function openWorkbench(){
  if(!process.argv.includes('--open'))return;
  const onError=error=>{if(error)console.error('请在浏览器打开 '+origin+'/')};
  if(process.platform==='win32'){
    execFile('rundll32.exe',['url.dll,FileProtocolHandler',origin+'/'],{windowsHide:true},onError)
  }else if(process.platform==='android'||process.env.TERMUX_VERSION){
    execFile('termux-open-url',[origin+'/'],onError)
  }else if(process.platform==='linux'&&(process.env.DISPLAY||process.env.WAYLAND_DISPLAY)){
    execFile('xdg-open',[origin+'/'],onError)
  }
}
app.once('error',async error=>{
  if(error.code==='EADDRINUSE'){
    try{
      const response=await fetch(origin+'/app.webmanifest',{redirect:'error',signal:AbortSignal.timeout(2500)});
      if(response.ok&&response.headers.get('content-type')?.includes('manifest')){
        const manifest=await response.json();
        if(['Codex 远程工作台','Codex · tim-SER'].includes(manifest.name)&&manifest.start_url==='/'){
          const check=await fetch(origin+'/api/client-version',{redirect:'error',signal:AbortSignal.timeout(2500)});
          const running=check.ok?await check.json().catch(()=>null):null;
          if(running?.version!==await clientVersion()||running.receiverVersion!==receiverVersion){
            console.error('端口 '+port+' 上的工作台与当前接收端版本不一致。请在当前任务结束后关闭原接收服务，再运行此目录的启动脚本。');
            process.exitCode=1;return
          }
          console.log('复用已运行的 Codex 远程工作台 '+origin+'/');openWorkbench();return
        }
      }
    }catch{/* The existing listener did not identify itself as this workbench. */}
    console.error('本地端口 '+port+' 已被其他服务占用。')
  }else console.error('本地工作台启动失败：'+error.message);
  process.exitCode=1
});
if(!moduleUrl.searchParams.has('device'))app.listen(port,'127.0.0.1',()=>{
  console.log('Codex 远程工作台已在 '+origin+' 启动，请在网页选择设备。');
  openWorkbench();
  if(deviceId)models().then(
    ()=>console.log('所选设备已就绪。'),
    ()=>console.log('所选设备模型目录尚未就绪，下一次模型请求会重试。')
  )
});
