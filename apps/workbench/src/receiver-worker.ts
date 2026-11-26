// Only handle navigation to the launcher. Chat content and API responses stay out of worker storage.
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.mode!=='navigate'||url.origin!==self.location.origin||url.pathname!=='/')return;
  event.respondWith(fetch(request).catch(()=>new Response(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex · tim-SER</title><style>:root{color-scheme:light dark;font:16px/1.6 system-ui}body{max-width:32rem;margin:20vh auto;padding:1.5rem}h1{font-size:1.4rem}a{color:LinkText}</style>
<h1>接收端服务未连接</h1><p id="guide">请从接收端目录重新启动工作台。</p>
<p>服务启动后，本页会自动恢复。</p><a href="/">重新连接</a>
<script>/* OFFLINE_RECONNECT */</script></html>`,
    {status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}})))
});
