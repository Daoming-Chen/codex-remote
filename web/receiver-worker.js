// Only handle navigation to the launcher. Chat content and API responses stay out of worker storage.
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.mode!=='navigate'||url.origin!==self.location.origin||url.pathname!=='/')return;
  event.respondWith(fetch(request).catch(()=>new Response(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex · tim-SER</title><style>:root{color-scheme:light dark;font:16px/1.6 system-ui}body{max-width:32rem;margin:20vh auto;padding:1.5rem}h1{font-size:1.4rem}a{color:LinkText}</style>
<h1>接收端服务未连接</h1><p id="guide">请从接收端目录重新启动工作台。</p>
<p>服务启动后，本页会自动恢复。</p><a href="/">重新连接</a>
<script>
const guide=document.querySelector('#guide');
if(/Android/i.test(navigator.userAgent))guide.innerHTML='请在 Termux 中进入接收端目录，运行 <code>sh start.sh</code>。';
else if(/Windows/i.test(navigator.userAgent))guide.textContent='请在接收端目录中运行 start.cmd。';
let timer,checking=false,delay=1000;
async function check(){
  clearTimeout(timer);
  if(checking||document.hidden)return;
  checking=true;
  try{
    const response=await fetch('/api/client-version',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(3000)});
    if(response.ok&&/^[a-f0-9]{16}$/.test((await response.json()).version)){
      location.reload();return
    }
  }catch{}
  finally{checking=false}
  if(!document.hidden){timer=setTimeout(check,delay);delay=Math.min(5000,delay*2)}
}
function resume(){clearTimeout(timer);delay=1000;if(!document.hidden)void check()}
document.querySelector('a').onclick=e=>{e.preventDefault();resume()};
document.addEventListener('visibilitychange',resume);
window.addEventListener('pageshow',resume);
window.addEventListener('pagehide',()=>clearTimeout(timer));
</script></html>`,
    {status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}})))
});
