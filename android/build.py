from pathlib import Path
import os,zipfile,subprocess,shutil,sys
a=Path(__file__).resolve().parent
root=a.parent
out_dir=root/'dist'
jdk=Path(os.environ['JAVA_HOME'])
bt=Path(os.environ['ANDROID_BUILD_TOOLS'])
jar=Path(os.environ['ANDROID_PLATFORM_JAR'])
node_dist=Path(os.environ['NODE_MOBILE_ANDROID'])
assets_dir=a/'assets'
assets_dir.mkdir(exist_ok=True)
env=os.environ.copy()
def run(*args):subprocess.run([str(v) for v in args],check=True,env=env)
build=a/'build'; build.mkdir(exist_ok=True);classes=build/'classes';classes.mkdir(exist_ok=True)
with zipfile.ZipFile(out_dir/'Codex-Remote-Web.zip') as source,zipfile.ZipFile(a/'assets/receiver.zip','w',zipfile.ZIP_DEFLATED) as assets:
 for name in source.namelist():
  if name in ['start.cmd','start.sh','使用说明.txt']:continue
  data=source.read(name)
  if name.startswith('vendor/') and name.endswith(('.js','.cjs','.mjs')) and b'\\p{' in data:
   data=subprocess.run(['node',str(a/'expand-regex.cjs')],input=data,stdout=subprocess.PIPE,check=True).stdout
  if name=='vendor/remote.mjs':
   assert b'exports.toBuffer =' in data and b'var require_lib =' in data
   data+=b"\nexport async function authorizationQrPng(url){return (await require_lib().toBuffer(url,{margin:4,scale:8,errorCorrectionLevel:'M'})).toString('base64')}\n"
   assert data.count(b'realpathSync2(tmpdir())')==1
   data=data.replace(b'realpathSync2(tmpdir())',b'realpathSync2(process.env.TMPDIR || tmpdir())')
   import re
   data,count=re.subn(rb'new TextDecoder\("utf-8", \{ fatal: true(?:, ignoreBOM: false)? \}\)',b'androidStrictUtf8',data)
   assert count==9
   data=b"""import {isUtf8 as androidIsUtf8} from 'node:buffer';
const androidStrictUtf8={decode(bytes){
  if(!androidIsUtf8(bytes))throw new TypeError('Invalid UTF-8');
  return new TextDecoder('utf-8').decode(bytes)
}};
"""+data
  if name=='index.html':
   data=data.replace(b'<textarea rows="2" id="prompt"',b'<textarea data-android-ime rows="2" id="prompt"')
   data=data.decode().replace('<p>在这台设备的接收端解压目录运行以下命令，按提示完成 Remote 设备授权。</p><code>node transport.mjs --authorize</code>','<p>点击上方的设备授权按钮，授权后即可发送。</p>').encode()
  if name=='receiver-worker.js':
   page=data.decode()
   start=page.index("const guide=document.querySelector('#guide');")
   end=page.index('let timer,checking=false',start)
   page=page[:start]+page[end:]
   data=page.replace('请从接收端目录重新启动工作台。','正在等待应用内接收端启动。如果一直没有恢复，请关闭并重新打开应用。').encode()
  if name=='server.mjs':
   s=data.decode()
   key="    if(req.headers.host!=="
   assert s.count(key)==1
   s=s.replace(key,"    if(!(req.headers.cookie||'').split(';').some(v=>v.trim()==='receiver='+process.env.CODEX_RECEIVER_COOKIE))return json(403,{error:'无效接收端会话'});\n"+key)
   s=s.replace("app.once('error',async error=>{","app.once('error',async error=>{\n  process.emit('receiver-bind-error');return;")
   s=s.replace("app.listen(port,'127.0.0.1',()=>{","app.listen(port,'127.0.0.1',()=>{\n  process.emit('receiver-listening');")
   data=s.encode()
  assets.writestr(name,data)
 assets.write(a/'embedded.mjs','embedded.mjs')
run(jdk/'bin/javac.exe','-encoding','UTF-8','--release','8','-classpath',jar,'-d',classes,*list((a/'java').rglob('*.java')))
run(jdk/'bin/jar.exe','cf',build/'classes.jar','-C',classes,'.')
run(bt/'d8.bat','--lib',jar,'--min-api','26','--output',build,build/'classes.jar')
raw=build/'unsigned.apk'
run(bt/'aapt2.exe','link','-I',jar,'--manifest',a/'AndroidManifest.xml','-A',a/'assets','-o',raw)
with zipfile.ZipFile(raw,'a',zipfile.ZIP_DEFLATED) as apk:
 apk.write(build/'classes.dex','classes.dex')
 for abi in ['arm64-v8a','x86_64']:
  for lib in ['libnode.so','libreceiver.so','libc++_shared.so']:
   src=(node_dist/'bin' if lib=='libnode.so' else a/'native')/abi/lib
   apk.write(src,'lib/'+abi+'/'+lib)
aligned=build/'aligned.apk';run(bt/'zipalign.exe','-f','4',raw,aligned)
ks=build/'local-test.jks'
if not ks.exists():run(jdk/'bin/keytool.exe','-genkeypair','-keystore',ks,'-storepass','android','-keypass','android','-alias','receiver','-keyalg','RSA','-validity','3650','-dname','CN=Codex Remote Local Test')
out=out_dir/'Codex-Remote-Android-test.apk'
run(bt/'apksigner.bat','sign','--ks',ks,'--ks-pass','pass:android','--out',out,aligned)
run(bt/'apksigner.bat','verify','--verbose',out)
out.with_suffix('.apk.idsig').unlink(missing_ok=True)
print(out.stat().st_size)

