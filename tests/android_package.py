import io,json,os,zipfile,tempfile,subprocess,pathlib,urllib.request,urllib.error,socket,time
root=pathlib.Path(__file__).resolve().parents[1]
with zipfile.ZipFile(root/'dist/Codex-Remote-Android-test.apk') as apk:
 assert apk.testzip() is None
 assert all(f'lib/{abi}/{lib}.so' in apk.namelist() for abi in ('arm64-v8a','x86_64') for lib in ('libnode','libc++_shared','libreceiver'))
 with tempfile.TemporaryDirectory() as temp:
  d=pathlib.Path(temp);app=d/'app';app.mkdir()
  with zipfile.ZipFile(io.BytesIO(apk.read('assets/receiver.zip'))) as assets:
   assert not any(n.startswith('state/') or n.endswith('credentials.json') for n in assets.namelist())
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
export async function* remoteLines(){throw Error('offline fixture')}
export function bindReceiverDevice(){}
export async function listReceiverDevices(){return []}
export async function requireReceiverIdentity(){throw Object.assign(Error('offline fixture'),{code:'REMOTE_NOT_PAIRED'})}
""")
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
   for endpoint in ('api/client-version','chat.js'):
    try:urllib.request.urlopen(url+endpoint);raise AssertionError('missing cookie accepted')
    except urllib.error.HTTPError as e:assert e.code==403
    with urllib.request.urlopen(urllib.request.Request(url+endpoint,headers={'Cookie':'receiver=isolated-cookie'})) as response:
     assert response.status==200
   print('APK contents, isolated authorization handoff, loopback listener, protected UI and API routes verified')
  finally:child.terminate();child.wait()
