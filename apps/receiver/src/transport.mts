import {withEmbeddedCredentialLock} from './receiver-runtime.mjs';
import {CodexRemoteClient,ClientModeRuntime,resolveConfig,IdentityStore,serverStorageDirectory,ClientServerApi,ServerCredentialStore} from './vendor/remote.mjs';
import {access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
const url='https://dsh.r2049.cn';
const directory=serverStorageDirectory(new IdentityStore().directory,url,'client');
export {directory as receiverIdentityDirectory};
let connection;
let boundDeviceId;
let lastDisconnect=null;
export function getLastDisconnect(){return lastDisconnect}
export function bindReceiverDevice(deviceId){
  if(typeof deviceId!=='string'||!deviceId)throw Error('缺少 Remote 设备 ID');
  if(boundDeviceId===deviceId)return;
  if(connection||boundDeviceId)throw Error('此接收连接已绑定设备');
  boundDeviceId=deviceId
}
const activeTerminals=new Set();
// Discovery may display an unknown status. A real connection uses the strict SDK client.
class DirectoryServerApi extends ClientServerApi{
  async presenceFor(deviceId,signal){
    try{return await super.presenceFor(deviceId,signal)}
    catch{
      signal?.throwIfAborted();
      return {online:null}
    }
  }
}
function createClient(relay,ServerApi=ClientServerApi){
  const config=resolveConfig({serverUrl:url,forceRelay:relay});
  const ids=new IdentityStore({directory,role:'client'});
  const store=new ServerCredentialStore(directory);
  if(process.env.CODEX_RECEIVER_UI==='android'&&process.platform==='android')
    store.withRefreshLock=withEmbeddedCredentialLock;
  const server=new ServerApi(url,store,fetch,config.httpServerAllowlist);
  const runtime=new ClientModeRuntime(config,ids,server,{async invoke(){throw Error('Local dispatch not used')}},{info(){},warn(){},error(){},debug(){}});
  return {runtime,server}
}
export async function authorizeReceiver({provider,onScanUrl,signal}={}){
  signal?.throwIfAborted();
  const {runtime,server}=createClient(false);
  let stage='identity';
  try{
    if(provider!=='list'){
      try{await access(join(directory,'server-credentials.json'));return {status:'existing'}}
      catch(error){if(error.code!=='ENOENT')throw error}
    }
    stage='providers';
    const providers=(await server.oauthProviders()).filter(item=>item.qrStartUrl);
    if(provider==='list')return {status:'providers',providers:providers.map(({id,displayName})=>({id,displayName}))};
    const selected=provider?providers.find(item=>item.id===provider):providers.find(item=>item.id==='zhihu')||providers[0];
    if(!selected)throw Error('授权方式不可用。');
    stage='session';
    await runtime.start();
    signal?.throwIfAborted();
    const session=await runtime.startClientOAuthQrLogin(selected.id);
    const deadline=Date.now()+session.expiresIn*1000;
    if(!URL.canParse(session.scanUrl)||new URL(session.scanUrl).protocol!=='https:')throw Error('Remote 返回的授权链接无效。');
    signal?.throwIfAborted();
    await onScanUrl(session.scanUrl,deadline);
    stage='confirmation';
    while(Date.now()<deadline){
      signal?.throwIfAborted();
      try{
        const result=await runtime.pollClientOAuthQrLogin(session.qrId);
        if(result.status==='complete')return {status:'complete'};
        if(result.status==='expired')break
      }catch(error){if(!error.retryable)throw error}
      await wait(Math.min(2000,Math.max(0,deadline-Date.now())),undefined,{signal})
    }
    throw Object.assign(Error('此次授权已过期，请重新发起授权。'),{code:'REMOTE_AUTH_EXPIRED'})
  }catch(error){
    if(error instanceof Error)error.authorizationStage=stage;
    throw error
  }finally{await runtime.close()}
}
async function authorizeFromTerminal(provider,openBrowser){
  const result=await authorizeReceiver({provider,onScanUrl(link,deadline){
    const expires=new Date(deadline).toLocaleTimeString('zh-CN',{hour12:false});
    console.log('请在 '+expires+' 前用浏览器打开以下一次性链接，授权此设备连接 Remote：\n'+link);
    const opener=process.platform==='win32'?'rundll32.exe':process.platform==='android'||process.env.TERMUX_VERSION?'termux-open-url':
      process.platform==='linux'&&(process.env.DISPLAY||process.env.WAYLAND_DISPLAY)?'xdg-open':null;
    if(openBrowser&&opener){
      const args=process.platform==='win32'?['url.dll,FileProtocolHandler',link]:[link];
      execFile(opener,args,{windowsHide:true},error=>{
        if(error)console.log('请手动在浏览器中打开上方授权链接。')
      })
    }
  }});
  if(result.status==='providers')console.log(result.providers.map(item=>item.id+' · '+item.displayName).join('\n')||'服务器未提供扫码授权方式。');
  else console.log(result.status==='existing'?'此设备已有 Remote 客户端授权。':'Remote 客户端授权完成。运行 node server.mjs 启动网页。')
}
export async function requireReceiverIdentity(){
try{await access(join(directory,'server-credentials.json'))}catch(e){
  if(e.code==='ENOENT')throw Object.assign(Error('此电脑尚未登记 Remote 客户端。请在客户端目录运行 node transport.mjs --authorize 完成 Remote 设备授权。'),{code:'REMOTE_NOT_PAIRED'});
  throw e
}
}
export async function listReceiverDevices(cancel){
  await requireReceiverIdentity();
  const timeout=AbortSignal.timeout(20000);
  const signal=cancel?AbortSignal.any([cancel,timeout]):timeout;
  const {runtime}=createClient(false,DirectoryServerApi);
  try{
    await runtime.start();
    const devices=await runtime.devices(signal);
    return devices.map(({deviceId,name,online})=>({deviceId,name,online:online??null}))
  }finally{await runtime.close()}
}
async function reconcileTerminalLeases(fs,leases,sid,call){
 let existingIds;
 for(const name of await fs.readdir(leases)){
   const match=/^(\d+)-([a-f0-9-]{36})$/.exec(name);if(!match)continue;
   if(Number(match[1])===process.pid){
     if(activeTerminals.has(match[2]))continue
   }else{
     try{process.kill(Number(match[1]),0);continue}catch(err){if(err.code!=='ESRCH')continue}
   }
   const lease=new URL(name,leases);
   try{const owner=await fs.readFile(lease,'utf8');if(owner!==sid)continue;
     existingIds??=new Set((await call('terminal/list',{sessionId:sid},AbortSignal.timeout(6000))).map(t=>t.id));
     if(existingIds.has(match[2]))await call('terminal/close',{agentId:sid,id:match[2]},AbortSignal.timeout(6000));
     await fs.unlink(lease)
   }catch{/* Reconcile on a later authenticated connection. */}
 }
}
// Each preview belongs to the SDK runtime for this device. Its listeners are
// closed by the SDK on disconnect, and the Host checks its port list on use.
export function webPreviewAccess(runtime,client){
  return {
    listPreviewPorts:()=>client.rpc('loopback.call',{op:'describe'},AbortSignal.timeout(15000)),
    async openPreviewPort(port){
      const result=await runtime.handleControl('preview.open',{port},AbortSignal.timeout(15000));
      if(!result.ok)throw Object.assign(Error('主机网页预览不可用'),{code:result.error?.details?.remoteCode});
      return result.value
    }
  }
}
async function connect(relay){
await requireReceiverIdentity();
const {runtime}=createClient(relay);
const setup=new AbortController();
const deadline=setTimeout(()=>setup.abort(),45000);
try {
 await runtime.start();
 const signal=setup.signal;
 if(!boundDeviceId)throw Object.assign(Error('请先选择 Remote 设备'),{code:'REMOTE_HOST_ABSENT'});
 // The SDK checks account membership, peer identity and presence for the selected ID.
 const remote=await runtime.ensureConnected(boundDeviceId,signal).catch(error=>{
   if(error.code==='MEMBERSHIP_REQUIRED')throw Object.assign(Error('当前账号已无法访问所选设备，请重新选择。'),{code:'REMOTE_HOST_ABSENT',cause:error});
   if(error.code==='HOST_OFFLINE')throw Object.assign(Error('所选设备当前离线。'),{code:'REMOTE_HOST_OFFLINE',cause:error});
   throw error
 });
 const target=remote.target;
 let closeDetail=null;
 remote.client.onClose(error=>{
   if(closeDetail&&error?.code==='CLIENT_CLOSED')return;
   const message=error?.message||'';
   const known=['Active WebRTC channel closed','Relay data socket closed','Relay peer detached','Control authorization lease expired','Adaptive connection was aborted','Adaptive transport closed'];
   const control=message.startsWith('Adaptive control channel closed:');
   closeDetail={at:Date.now(),code:/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code)?error.code:null,
     reason:known.includes(message)?message:control?'control channel closed':'unclassified',
     wsCode:control?Number(message.match(/(?:WebSocket(?: closed with code)? )(\d{4})/)?.[1])||null:null};
   if(error?.code!=='CLIENT_CLOSED')lastDisconnect=closeDetail
 });

 const codex=remote.features.codex===true?new CodexRemoteClient(remote.client):null;
 const context={runtime,connectionId:randomUUID(),deviceId:target.deviceId,deviceName:target.name,
   probe:(timeout=6000)=>remote.client.rpc('harness.transport.describe',{},AbortSignal.timeout(timeout)),
   nativeStream:codex,
   ...webPreviewAccess(runtime,remote.client),
   nativeCall:codex?(method,params)=>codex.request(method,params,AbortSignal.timeout(30000)):null,
   lastDisconnect:()=>lastDisconnect,closeDetail:()=>closeDetail,connected:()=>!closeDetail&&remote.client.getStats().connected,transportMode:()=>remote.transport.getStats().mode,nativeCodex:remote.features.codex===true};
 if(codex){
   if(remote.features.remoteGateway){
     const {RemoteTypertGateway}=await import('./vendor/remote.mjs');
     const gateway=new RemoteTypertGateway(remote.client);
     context.listWorkspaceFiles=(thread,path)=>gateway.invoke({namespace:'workspaceFiles',method:'list',
       args:{workspaceFileScopeId:'codex:'+thread,path},signal:AbortSignal.timeout(15000)})
     context.workspaceFileStat=(thread,path)=>gateway.invoke({namespace:'workspaceFiles',method:'stat',
       args:{workspaceFileScopeId:'codex:'+thread,path},signal:AbortSignal.timeout(15000)})
     context.workspaceFileRange=(thread,path,offset,length)=>gateway.invoke({namespace:'workspaceFiles',method:'readBytes',
       args:{workspaceFileScopeId:'codex:'+thread,path,options:{range:{offset,length}}},signal:AbortSignal.timeout(30000)})
   }
   return context
 }
 const {RemoteTypertGateway}=await import('./vendor/remote.mjs');
 const g=new RemoteTypertGateway(remote.client);
 const call=(endpoint,args,requestSignal=signal)=>g.invoke({namespace:endpoint.split('/')[0],method:endpoint.split('/')[1],args,signal:requestSignal});
 const fs=await import('node:fs/promises');
 let sid;
 const base=new URL('./state/',import.meta.url);
 const state=boundDeviceId?new URL('devices/'+createHash('sha256').update(boundDeviceId).digest('hex')+'/',base):base;
 const sidFile=new URL('transport-session.txt',state);
 try{sid=(await fs.readFile(sidFile,'utf8')).trim()}catch(e){
   if(e.code!=='ENOENT')throw e;
   await fs.mkdir(new URL('./',sidFile),{recursive:true});
   sid=(await call('session/create',{request:{}})).sessionId;
   await fs.writeFile(sidFile,sid,{flag:'wx'});
 }
 const leases=new URL('terminal-leases/',state);
 await fs.mkdir(leases,{recursive:true});
 void reconcileTerminalLeases(fs,leases,sid,call).catch(()=>{});
 return {...context,g,sid,leases};
 }catch(e){await runtime.close();throw e}finally{clearTimeout(deadline)}
}
export async function openRemote(relay=false){
  const existing=connection;
  let stale;
  if(existing){
    stale=await existing;
    if(stale.connected())return stale;
    if(connection!==existing)return openRemote(relay)
  }
  const opening=(async()=>{
    if(stale)await stale.runtime.close().catch(()=>{});
    return connect(relay)
  })();
  connection=opening;
  try{return await opening}
  catch(error){if(connection===opening)connection=null;throw error}
}
export async function* remoteLines(code,events=false,relay=false,onComplete,cancel,onStart,inputBase64){
  const opening=openRemote(relay);
  const ctx=await opening;
  if(ctx.nativeCodex)throw Error('此设备通过原生 Codex 接口连接，当前操作尚未适配');
  const {g,sid,leases}=ctx;
  const deadline=AbortSignal.timeout(cancel||events?330000:45000);
  const signal=cancel?AbortSignal.any([cancel,deadline]):deadline;
  signal.throwIfAborted();
  const call=(endpoint,args,requestSignal=signal)=>g.invoke({namespace:endpoint.split('/')[0],method:endpoint.split('/')[1],args,signal:requestSignal});
  const id=crypto.randomUUID(),attachmentId=crypto.randomUUID(),marker='DSH_'+id.replaceAll('-','');
  const lease=new URL(process.pid+'-'+id,leases);
  const fs=await import('node:fs/promises');
  const stop=new AbortController();
  activeTerminals.add(id);
  try{
    await fs.writeFile(lease,sid);
    await call('terminal/create',{agentId:sid,request:{id,cols:150,rows:24}});
    await g.open('terminal/retain',{args:{sessionId:sid,id}},stop.signal);
    const follow=await g.open('terminal/follow',{args:{agentId:sid,id,attachmentId}},AbortSignal.any([stop.signal,signal]));
    let sent=false,reading=false,buf='',sentAt,writeConfirmedAt;
    for await(const f of follow){
      if(!sent&&f.info?.controllerId===attachmentId&&f.info?.state==='running'&&(f.type==='snapshot'||f.type==='state')){
        const stamp=onStart?' "$(date +%s%3N)"':'';
        sent=true;sentAt=Date.now();
        const configure=inputBase64?'stty -echo; ':'',restore=inputBase64?'stty echo; ':'';
        await call('terminal/write',{agentId:sid,id,attachmentId,data:configure+'echo '+marker+'_START'+stamp+'; '+code+'; '+restore+'echo '+marker+'_DONE\r'});
        writeConfirmedAt=Date.now()
      }
      if(f.type!=='output')continue;
      buf+=f.data;
      for(let end;(end=buf.indexOf('\n'))>=0;){
        const line=buf.slice(0,end).replace(/\r/g,'').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g,'');buf=buf.slice(end+1);
        if(!reading&&(line===marker+'_START'||onStart&&line.startsWith(marker+'_START '))){
          reading=true;
          if(inputBase64){
            // Canonical terminals accept at most 4095 bytes per line. Feed the
            // waiting reader in bounded RPC writes, then signal EOF at BOL.
            const lines=inputBase64.match(/.{1,1024}/g);
            for(let i=0;i<lines.length;i+=24)
              await call('terminal/write',{agentId:sid,id,attachmentId,data:lines.slice(i,i+24).join('\r')+'\r'});
            await call('terminal/write',{agentId:sid,id,attachmentId,data:'\x04'})
          }
          const stamp=line.slice(marker.length+7);
          onStart?.(ctx.transportMode(),/^\d{13}$/.test(stamp)?{sentAt,writeConfirmedAt,hostAt:Number(stamp),receivedAt:Date.now()}:null,ctx.transportMode);
          continue
        }
        if(!reading)continue;
        if(line===marker+'_DONE'){if(onComplete)onComplete(ctx.transportMode(),ctx.nativeCodex);return}
        yield line
      }
    }
    throw Error('Remote 数据流提前结束')
  }catch(error){
    const detail=ctx.closeDetail?.();
    if(detail&&error instanceof Error)error.remoteClose=detail;
    throw error
  }finally{
    stop.abort();
    try{
      if(ctx.connected()){
        await call('terminal/close',{agentId:sid,id},AbortSignal.timeout(5000));await fs.unlink(lease)
      }
    }catch{/* The next authenticated connection can reclaim the lease. */}
    activeTerminals.delete(id)
  }
}
let foregroundCheck;
export function recoverRemote(){
  if(foregroundCheck)return foregroundCheck;
  foregroundCheck=(async()=>{
    const cached=connection;
    if(!cached)return {reused:false,connectionId:(await openRemote()).connectionId};
    const ctx=await cached;
    for(const timeout of [6000,12000]){
      if(!ctx.connected())break;
      try{await ctx.probe(timeout)}catch(error){
        // A reply from an older peer still confirms that the channel is alive.
        if(error.code!=='METHOD_NOT_FOUND'&&error.code!=='METHOD_NOT_ALLOWED'){
          // A foreground transition can delay a probe while the peer is still connected.
          if(error.code==='RPC_ABORTED'||error.name==='TimeoutError')continue;
          break
        }
      }
      if(connection===cached&&ctx.connected())return {reused:true,connectionId:ctx.connectionId};
      break
    }
    if(connection===cached){
      connection=null;
      await ctx.runtime.close().catch(()=>{})
    }
    return {reused:false,connectionId:(await openRemote()).connectionId}
  })().finally(()=>{foregroundCheck=null});
  return foregroundCheck
}
export async function closeRemote(){
  const current=connection;connection=null;
  if(current)await (await current).runtime.close()
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const relay=process.env.CODEX_WEB_RELAY_FALLBACK==='1';
    if(process.argv[2]==='--authorize'){
      const args=process.argv.slice(3);
      await authorizeFromTerminal(args.find(arg=>arg!=='--open'),args.includes('--open'))
    }
    else if(process.argv[2]==='--devices')console.log(JSON.stringify(await listReceiverDevices()));
    else if(process.argv[2]==='--init')await openRemote(relay);
    else{
      console.log('REMOTE_DIAG_START');
      for await(const line of remoteLines(process.argv[2],process.argv[3]==='events',relay))console.log(line);
      console.log('REMOTE_DIAG_DONE')
    }
  }catch(e){
    if(e.code==='REMOTE_AUTH_EXPIRED')console.error('授权链接已过期。请重新运行启动脚本以获取新链接。');
    else console.error(e.code||e.message);
    process.exitCode=1
  }
  finally{await closeRemote()}
}
