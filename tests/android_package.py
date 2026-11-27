import hashlib,io,json,os,zipfile,tempfile,subprocess,pathlib,urllib.request,urllib.error,socket,time
root=pathlib.Path(__file__).resolve().parents[1]
with zipfile.ZipFile(root/'dist/Codex-Remote-Android-test.apk') as apk:
 assert apk.testzip() is None
 assert [n for n in apk.namelist() if n.startswith('assets/')] == ['assets/receiver.zip']
 assert all(f'lib/{abi}/{lib}.so' in apk.namelist() for abi in ('arm64-v8a','x86_64') for lib in ('libnode','libc++_shared','libreceiver'))
 with tempfile.TemporaryDirectory() as temp:
  d=pathlib.Path(temp);app=d/'app';app.mkdir()
  with zipfile.ZipFile(io.BytesIO(apk.read('assets/receiver.zip'))) as assets:
   private_names={'identity','state','device.json','device.key','trusted-peers.json','launch.json','screen.json'}
   for name in assets.namelist():
    parts=pathlib.PurePosixPath(name.lower()).parts
    assert not private_names.intersection(parts) and not name.lower().endswith('credentials.json'),name
   assets.extractall(app)
  with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
  (d/'launch.json').write_text(json.dumps({'port':port,'token':'isolated-cookie'}))
  # Replace only device authorization and host connectivity in the extracted copy.
  (app/'transport.mjs').rename(app/'real-transport.mjs')
  (app/'transport.mjs').write_text("""export {receiverIdentityDirectory} from './real-transport.mjs';
let attempt=0;
export async function authorizeReceiver({onScanUrl}){
  attempt++;
  await onScanUrl('https://example.invalid/device/'+attempt,Date.now()+500);
  await new Promise(r=>setTimeout(r,500));
  if(attempt===1)throw Object.assign(Error('expired'),{code:'REMOTE_AUTH_EXPIRED'});
  return {status:'complete'}
}
let boundDevice;
export function bindReceiverDevice(id){boundDevice=id}
export async function* remoteLines(command){
 if(boundDevice!=='daemon-fixture')throw Error('offline fixture');
 if(command.endsWith('&& echo CREATED')){yield 'CREATED';return}
 if(command.endsWith('&& echo STORED')){yield 'STORED';return}
 if(command.endsWith('&& echo READY')){yield 'READY';return}
 if(!command.includes('/follow.py ')||!command.endsWith(' 1'))throw Error('Unexpected daemon replay');
 const events=[
  {type:'command.output',item_id:'cmd',delta:'second line'},
  {type:'item.completed',item:{id:'cmd',type:'commandExecution',status:'completed',output:'first and second lines',exitCode:0}},
  {type:'item.completed',item:{id:'msg',type:'agent_message',text:'finished'}},
  {type:'turn.completed'}
 ];
 for(const [index,event] of events.entries()){
  yield 'CX '+(index+2)+' '+Buffer.from(JSON.stringify(event)).toString('base64');
  if(index===0){
   const {access}=await import('node:fs/promises');
   while(!await access(new URL('./finish-command',import.meta.url)).then(()=>true,()=>false))
    await new Promise(resolve=>setTimeout(resolve,20))
  }
 }
}
const directoryFailures=[{code:'REMOTE_NOT_PAIRED'},{code:'AUTH_INVALID'},{code:'PEER_IDENTITY_MISMATCH'},
 {code:'CONNECTION_FAILED',reason:'timeout'},{code:'SERVER_CREDENTIALS_LOCK_UNSUPPORTED'},{code:'UNEXPECTED'}];
export async function listReceiverDevices(){
 const failure=directoryFailures.shift();
 if(failure)throw Object.assign(Error('private upstream detail'),failure);
 return [{deviceId:'preview-fixture',name:'预览主机',online:true},{deviceId:'daemon-fixture',name:'命令测试主机',online:true}]
}
export async function openRemote(){if(boundDevice==='daemon-fixture')return {};return {
 nativeCall:async(method,params)=>{
  if(method!=='thread/fork'||params.threadId!=='00000000-0000-4000-8000-000000000001')
    throw Error('Unexpected side chat target');
  if(!params.developerInstructions?.includes('Parent history is reference material only'))
    throw Error('Missing side chat context boundary');
  return {thread:{id:'00000000-0000-4000-8000-000000000002'}}
 },
 listPreviewPorts:async()=>({ports:[5173]}),
 openPreviewPort:async port=>{
  if(port!==5173)throw Object.assign(Error('denied'),{code:'LOOPBACK_PORT_DENIED'});
  return {url:'http://dsh-'+'a'.repeat(48)+'.localhost:41000/'}
 }
}}
export async function requireReceiverIdentity(){throw Object.assign(Error('offline fixture'),{code:'REMOTE_NOT_PAIRED'})}
""",encoding='utf-8')
  child=subprocess.Popen([os.environ.get('TEST_NODE','node'),str(app/'embedded.mjs')],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  try:
   stages=set();links=[];retried=False
   for _ in range(150):
    if child.poll() is not None:raise RuntimeError(child.stdout.read())
    try:
     state=json.loads((d/'screen.json').read_text(encoding='utf-8'))
    except (FileNotFoundError,PermissionError):
     # Windows can temporarily deny a reader during atomic replacement.
     state=None
    if state:
     stages.add(state['stage'])
     if state['stage']=='authorize' and state['url'] not in links:links.append(state['url'])
     if state['stage']=='retry' and not retried:
      assert state['expired']
      (d/'retry').touch();retried=True
    if 'ready' in stages:break
    time.sleep(.05)
   assert {'ready','retry','authorize'}<=stages and len(links)==2,(stages,links)
   url=f'http://127.0.0.1:{port}/'
   if os.name=='nt':
    listeners=[line.split() for line in subprocess.check_output(
      ['netstat','-ano','-p','tcp'],text=True,errors='replace').splitlines()
      if line.strip().startswith('TCP')]
    assert [row[1] for row in listeners if row[-1]==str(child.pid) and row[2]=='0.0.0.0:0']==[f'127.0.0.1:{port}']
   try:urllib.request.urlopen(url);raise AssertionError('missing cookie accepted')
   except urllib.error.HTTPError as e:assert e.code==403
   assert (app/'devices.html').read_bytes() == urllib.request.urlopen(urllib.request.Request(url,headers={'Cookie':'receiver=isolated-cookie'})).read()
   request=urllib.request.Request(url+'api/devices',method='POST',headers={
    'Cookie':'receiver=isolated-cookie','Origin':url.rstrip('/')
   })
   try:urllib.request.urlopen(request);raise AssertionError('unpaired directory accepted')
   except urllib.error.HTTPError as error:
    assert error.code==503
    assert json.load(error)=={'code':'REMOTE_NOT_PAIRED','error':'完成应用内的 Remote 设备授权后，即可选择主机。'}
   for code in ['AUTH_INVALID','PEER_IDENTITY_MISMATCH','DIRECTORY_TIMEOUT','SERVER_CREDENTIALS_LOCK_UNSUPPORTED','DEVICE_DIRECTORY_FAILED']:
    try:urllib.request.urlopen(request);raise AssertionError('failed directory accepted')
    except urllib.error.HTTPError as error:
     result=json.load(error)
     assert error.code==503 and result['code']==code,result
     assert 'private upstream detail' not in result['error']
   devices=json.load(urllib.request.urlopen(request))['devices']
   scope=hashlib.sha256(b'preview-fixture').hexdigest()
   daemon_scope=hashlib.sha256(b'daemon-fixture').hexdigest()
   assert {device['scope'] for device in devices}=={scope,daemon_scope}
   preview=url+'devices/'+scope+'/api/web-preview/'
   headers={'Cookie':'receiver=isolated-cookie','Sec-Fetch-Site':'same-origin'}
   # Resume exactly where a receiver stopped after seeing a command start.
   state_dir=app/'state'/'devices'/daemon_scope
   state_dir.mkdir(parents=True,exist_ok=True)
   job_id='00000000-0000-4000-8000-000000000004'
   job_file=state_dir/(job_id+'.json')
   job_file.write_text(json.dumps({'id':job_id,'thread':'00000000-0000-4000-8000-000000000005',
    'turn':'00000000-0000-4000-8000-000000000006','backend':'daemon','status':'waiting','offset':1,
    'order':[{'kind':'activity','id':'cmd'}],'progress':{'items':[{'id':'cmd','type':'commandExecution','status':'inProgress'}]}}))
   events=urllib.request.Request(url+'devices/'+daemon_scope+'/api/turn/'+job_id+'/events',headers=headers)
   saw_delta=False
   with urllib.request.urlopen(events,timeout=6) as stream:
    deadline=time.monotonic()+8
    for line in stream:
     assert time.monotonic()<deadline,'daemon event replay did not finish'
     if not line.startswith(b'data: '):continue
     job=json.loads(line[6:])
     if job['status']=='done':break
     if job['progress']['items'][0].get('output')=='second line':
      saw_delta=True
      (app/'finish-command').touch()
   assert saw_delta and job['status']=='done' and job['offset']==5
   saved=json.loads(job_file.read_text())
   assert saved['status']=='done' and saved['answer']=='finished'
   assert [item['output'] for item in saved['progress']['items']]==['first and second lines']
   assert json.load(urllib.request.urlopen(urllib.request.Request(preview+'ports',headers=headers)))=={'ports':[5173]}
   def open_preview(port,source):
    req=urllib.request.Request(preview+'open',data=json.dumps({'port':port}).encode(),
     headers={**headers,'Origin':source,'Content-Type':'application/json'})
    try:
     with urllib.request.urlopen(req) as response:return response.status,json.load(response)
    except urllib.error.HTTPError as error:return error.code,json.load(error)
   origin=url.rstrip('/')
   assert open_preview(5173,origin)==(200,{'url':'http://dsh-'+'a'*48+'.localhost:41000/'})
   status,denied=open_preview(5174,origin)
   assert status==403 and denied['code']=='LOOPBACK_PORT_DENIED'
   assert open_preview(5173,'http://untrusted.localhost')[0]==403
   assert open_preview('5173',origin)[0]==400
   parent_thread='00000000-0000-4000-8000-000000000001'
   side_request=urllib.request.Request(url+'devices/'+scope+'/api/thread-fork',
    data=json.dumps({'thread':parent_thread,'request':'00000000-0000-4000-8000-000000000003','sideChat':True}).encode(),
    headers={**headers,'Origin':origin,'Content-Type':'application/json'})
   with urllib.request.urlopen(side_request) as response:
    assert json.load(response)=={'source':parent_thread,'thread':'00000000-0000-4000-8000-000000000002'}
   for endpoint in ('api/client-version','chat.js'):
    try:urllib.request.urlopen(url+endpoint);raise AssertionError('missing cookie accepted')
    except urllib.error.HTTPError as e:assert e.code==403
    with urllib.request.urlopen(urllib.request.Request(url+endpoint,headers={'Cookie':'receiver=isolated-cookie'})) as response:
     assert response.status==200
   print('APK contents, authorization handoff, loopback listener, protected routes and daemon command replay verified')
  finally:child.terminate();child.wait()
