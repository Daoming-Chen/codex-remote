import {readFile,writeFile,rename,access,unlink,mkdir,readdir,lstat,realpath} from 'node:fs/promises';
import {join,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
const root=new URL('../',import.meta.url);
const file=name=>new URL(name,root);
const cfg=JSON.parse(await readFile(file('launch.json'),'utf8'));
await mkdir(file('tmp'),{recursive:true,mode:0o700});
process.env.TMPDIR=fileURLToPath(file('tmp'));
process.env.DSH_HOME=fileURLToPath(file('identity'));
process.env.HOME=fileURLToPath(root);
process.env.CODEX_WEB_PORT=String(cfg.port);
const {authorizeReceiver,receiverIdentityDirectory}=await import('./transport.mjs');
async function preserveEmptyIdentity(directory){
  try{
    const privateRoot=await realpath(root),actual=await realpath(directory);
    if(actual!==directory||!actual.startsWith(privateRoot+sep))return;
    const names=await readdir(directory);
    const expected=['device.json','device.key','trusted-peers.json'];
    if(names.length!==expected.length||!expected.every(name=>names.includes(name)))return;
    for(const name of expected){
      const info=await lstat(join(directory,name));
      if(!info.isFile()||info.size!==0)return
    }
    await rename(directory,directory+'.empty-'+randomUUID())
  }catch(error){if(error.code!=='ENOENT')throw error}
}
await preserveEmptyIdentity(receiverIdentityDirectory);
const publish=async state=>{
  await writeFile(file('screen.tmp'),JSON.stringify(state),{mode:0o600});
  await rename(file('screen.tmp'),file('screen.json'))
};
process.env.CODEX_RECEIVER_COOKIE=cfg.token;
const listening=new Promise(resolve=>{
  process.once('receiver-listening',()=>resolve(true));
  process.once('receiver-bind-error',()=>resolve(false))
});
await import('./server.mjs');
if(await listening){
  await publish({stage:'pairing'});
for(let attempt=1;;attempt++){
  try{
    await authorizeReceiver({onScanUrl:async(url,expires)=>{
      const {authorizationQrPng}=await import('./vendor/remote.mjs');
      await publish({stage:'authorize',url,expires,qr:await authorizationQrPng(url)})
    }});
    break
  }catch(error){
    const reasons={identity:'无法读取本机设备身份。',providers:'未能从 Remote 服务获取授权方式。',session:'未能创建 Remote 设备授权会话。',confirmation:'未能从 Remote 服务确认授权结果。'};
    const code=error?.cause?.code||error?.code;
    let detail=typeof code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(code)?'（'+code+'）':'';
    if(code==='IDENTITY_INVALID'){
      const descriptions=[[/private key permissions/,'设备密钥的文件权限异常。'],[/identity is incomplete/,'本地设备身份文件不完整。'],[/keys do not match/,'设备公钥与私钥不匹配。'],[/identity is invalid/,'本地设备身份校验失败。'],[/not ready|not loaded/,'设备身份尚未就绪。']];
      detail=descriptions.find(([pattern])=>pattern.test(error.message))?.[1]||detail;
    }
    await publish({stage:'retry',attempt,expired:error?.code==='REMOTE_AUTH_EXPIRED',reason:(reasons[error?.authorizationStage]||'设备授权未完成。')+detail});
    for(;;){try{await access(file('retry'));await unlink(file('retry'));break}catch{await wait(500)}}
  }
}
  await publish({stage:'ready'});
}else await publish({stage:'bind-error'});
