
const guide=document.querySelector<HTMLElement>('#guide')!;
if(/Android/i.test(navigator.userAgent))guide.innerHTML='请重新打开接收端应用。使用独立 Web 包时，请在接收端目录运行 <code>sh start.sh</code>。';
else if(/Windows/i.test(navigator.userAgent))guide.textContent='请在接收端目录中运行 start.cmd。';
let timer: number | undefined,checking=false,delay=1000;
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
  if(!document.hidden){timer=window.setTimeout(check,delay);delay=Math.min(5000,delay*2)}
}
function resume(){clearTimeout(timer);delay=1000;if(!document.hidden)void check()}
document.querySelector('a')!.onclick=e=>{e.preventDefault();resume()};
document.addEventListener('visibilitychange',resume);
window.addEventListener('pageshow',resume);
window.addEventListener('pagehide',()=>clearTimeout(timer));
