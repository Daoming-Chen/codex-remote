'use strict';
const $=id=>document.getElementById(id);
const deviceScope=document.querySelector('meta[name="receiver-scope"]')?.content||'';
const devicePath=deviceScope&&location.pathname.startsWith('/devices/'+deviceScope+'/')?'/devices/'+deviceScope:'';
let leavingRevokedDevice=false;
function leaveRevokedDevice(){
  if(!devicePath||leavingRevokedDevice)return;
  leavingRevokedDevice=true;save();location.replace('/devices')
}
async function deviceFetch(path,options){
  const response=await window.fetch(typeof path==='string'&&path.startsWith('/api/')?devicePath+path:path,options);
  if(response.status===403&&response.headers.get('X-Receiver-Device-Access')==='revoked')leaveRevokedDevice();
  return response
}
let receiverName=document.querySelector('meta[name="receiver-name"]')?.content||'远程主机';
function renderReceiverName(){
  for(const label of document.querySelectorAll('[data-receiver-name]'))label.textContent=receiverName;
  const avatar=document.querySelector('.account .avatar');
  if(avatar)avatar.textContent=Array.from(receiverName)[0]?.toLocaleUpperCase()||''
}
renderReceiverName();
let permissionCapability,permissionCheckedAt=0,nativePermissionMode;
function nativePermissions(){
  if(!devicePath)return Promise.resolve(false);
  if(!permissionCapability||Date.now()-permissionCheckedAt>60000){
    permissionCheckedAt=Date.now();
    const request=deviceFetch('/api/native-capability').then(async r=>{
      const data=await r.json();
      if(!r.ok||typeof data.native!=='boolean')throw Error(data.error||'无法读取主机任务权限');
      nativePermissionMode=data.native;
      updatePermissionLabel(current());
      return data.native
    }).catch(error=>{if(permissionCapability===request)permissionCapability=null;throw error});
    permissionCapability=request
  }
  return permissionCapability
}
if(devicePath)void nativePermissions().catch(()=>{});
function scopedStorage(storage){
  const prefix=deviceScope?'receiver:'+deviceScope+':':'';
  return {
    getItem:name=>storage.getItem(prefix+name),
    setItem:(name,value)=>storage.setItem(prefix+name,value),
    removeItem:name=>storage.removeItem(prefix+name),
    keys:()=>Object.keys(storage).filter(name=>name.startsWith(prefix)).map(name=>name.slice(prefix.length))
  }
}
const chatStorage=scopedStorage(window.localStorage),pageStorage=scopedStorage(window.sessionStorage);
const nativeDraftId=id=>deviceScope?deviceScope+':'+id:id;
const key='tim-ser-chats-v2',legacy='tim-ser-local-chat-v1',mobile=matchMedia('(max-width:800px)'),dark=matchMedia('(prefers-color-scheme:dark)');
const effortNames={none:'无',minimal:'极低',low:'轻度',medium:'中',high:'高',xhigh:'极高',max:'Max',ultra:'Ultra',persistent:'持续'};
const newChat=()=>({id:crypto.randomUUID(),title:'新聊天',messages:[],parent:null,pending:null,draft:'',files:[],updated:Date.now()});
const composingFields=new WeakSet();
document.addEventListener('compositionstart',event=>composingFields.add(event.target),true);
document.addEventListener('compositionend',event=>composingFields.delete(event.target),true);
document.addEventListener('blur',event=>composingFields.delete(event.target),true);
function isCompositionKey(event){
  return event.isComposing||event.keyCode===229||composingFields.has(event.target)
}
function readStoredObject(raw){
  try{
    const value=JSON.parse(raw);
    return value&&typeof value==='object'&&!Array.isArray(value)?value:null
  }catch{return null}
}
let db=readStoredObject(chatStorage.getItem(key));
const chatPrefix='tim-ser-chat-record:',savedChats=new Map();
const draftPrefix='tim-ser-chat-draft:',savedDrafts=new Map();
const resumeCursorKey='tim-ser-resume-cursor';
const savedAttachmentLists=new WeakMap();
const storedChatKeys=chatStorage.keys().filter(name=>name.startsWith(chatPrefix));
if(db?.chatStorage===1||Array.isArray(db?.chats)||storedChatKeys.length){
  db??={theme:'system',collapsed:false};
  const chats=new Map((Array.isArray(db.chats)?db.chats:[]).filter(chat=>chat?.id&&Array.isArray(chat.messages)).map(chat=>[chat.id,chat]));
  for(const name of storedChatKeys){
    const raw=chatStorage.getItem(name);
    const chat=readStoredObject(raw);
    if(!chat?.id||name!==chatPrefix+chat.id||!Array.isArray(chat.messages))continue;
    chats.set(chat.id,chat);savedChats.set(chat.id,raw)
  }
  db.chats=[...chats.values()];
  if(!chats.has(db.active))db.active=db.chats[0]?.id;
  if(!db.chats.length)db=null
}
if(!Array.isArray(db?.chats)){const c=newChat(),old=readStoredObject(chatStorage.getItem(legacy));if(old&&Array.isArray(old.messages)){Object.assign(c,{messages:old.messages,pending:old.pending||null,parent:old.parent||null});c.title=c.messages.find(m=>m?.role==='user')?.text?.slice(0,45)||c.title}db={active:c.id,chats:[c],theme:'system',collapsed:false}}
for(const c of db.chats){
  if(c.pending)c.activeTurn=null;
  const draft=window.ReceiverDrafts?.read(nativeDraftId(c.id))??chatStorage.getItem(draftPrefix+c.id);
  if(draft!==null){c.draft=draft;savedDrafts.set(c.id,draft)}
  else c.draft??='';
  if(!Array.isArray(c.files))c.files=c.file?[c.file]:[];
  const attachments=readStoredObject(window.ReceiverDrafts?.readAttachments?.(nativeDraftId(c.id)));
  if(Array.isArray(attachments?.files)&&attachments.pending===(c.pending||null))c.files=attachments.files;
  if(attachments?.pending===(c.pending||null)||(!attachments&&!c.files.length))savedAttachmentLists.set(c,c.files);
  delete c.file;delete c.steering
}
const readingFiles=new WeakMap();
const catalogRequests=new Map();
const projectCatalogs=new Map();
const catalogPrefix='tim-ser-project-models:';
const catalogRetryAfter=new Map();
const projectPages=new Map();
function promptWithFiles(text,files){
  return [text,...files.filter(file=>!file.url).map(file=>file.remotePath?'主机项目路径：'+file.remotePath:'文件：'+file.name+'\n'+file.text)].filter(Boolean).join('\n\n')
}
const current=()=>db.chats.find(c=>c.id===db.active);
function persistDraft(chat){
  const text=chat.draft||'';
  if((savedDrafts.get(chat.id)||'')===text)return;
  pageStorage.removeItem(resumeCursorKey+':'+chat.id);
  window.ReceiverDrafts?.write(nativeDraftId(chat.id),text);
  if(text)chatStorage.setItem(draftPrefix+chat.id,text);
  else chatStorage.removeItem(draftPrefix+chat.id);
  savedDrafts.set(chat.id,text)
}
function storageFull(){$('notice').textContent='浏览器存储已满，当前对话只保存在此页面。'}
function save(){
  try{
    const {chats,...metadata}=db;
    for(const chat of chats){
      persistDraft(chat);
      const {draft,...details}=chat;
      const raw=JSON.stringify(details),before=savedChats.get(chat.id);
      if(raw===before)continue;
      const name=chatPrefix+chat.id,latest=chatStorage.getItem(name);
      let record=raw;
      if(before&&latest&&before!==latest){
        const previous=JSON.parse(before),merged=JSON.parse(latest);
        for(const field of new Set([...Object.keys(previous),...Object.keys(details)])){
          if(JSON.stringify(previous[field])===JSON.stringify(details[field]))continue;
          if(Object.hasOwn(details,field))merged[field]=details[field];else delete merged[field]
        }
        record=JSON.stringify(merged)
      }
      chatStorage.setItem(name,record);savedChats.set(chat.id,raw)
      const previousFiles=savedAttachmentLists.get(chat);
      if(window.ReceiverDrafts?.writeAttachments&&previousFiles!==chat.files&&
          (previousFiles===undefined||previousFiles.length||chat.files.length)){
        const state=JSON.stringify({pending:chat.pending||null,files:chat.files});
        if(window.ReceiverDrafts.writeAttachments(nativeDraftId(chat.id),state))savedAttachmentLists.set(chat,chat.files)
      }
    }
    chatStorage.setItem(key,JSON.stringify({...metadata,chatStorage:1}))
  }catch{storageFull()}
}
const separator=$('side-resize');
function setSidebarWidth(value){
  const max=Math.max(240,Math.min(520,innerWidth-240));
  const width=Math.min(max,Math.max(240,Number.isFinite(value)?value:252));
  document.documentElement.style.setProperty('--rail',width+'px');
  separator.setAttribute('aria-valuemin','240');separator.setAttribute('aria-valuemax',String(max));
  separator.setAttribute('aria-valuenow',String(width));
  return width
}
setSidebarWidth(db.sidebarWidth);
window.addEventListener('resize',()=>setSidebarWidth(db.sidebarWidth));
function enablePaneDrag(handle,direction,resize,commit,cancel){
  let drag=null;
  function widthAt(e){
    if(e.pointerType==='mouse')return direction===1?e.clientX-$('side').getBoundingClientRect().left:innerWidth-e.clientX;
    return drag.width+direction*(e.clientX-drag.x)
  }
  handle.onpointerdown=e=>{
    if(e.button!==0||drag)return;
    drag={pointer:e.pointerId,x:e.clientX,width:Number(handle.getAttribute('aria-valuenow'))};
    handle.setPointerCapture(e.pointerId);
    if(handle===separator)$('layout').classList.add('resizing-side')
  };
  handle.onpointermove=e=>{
    if(e.pointerId===drag?.pointer)resize(widthAt(e))
  };
  handle.onpointerup=e=>{
    if(e.pointerId!==drag?.pointer)return;
    const width=resize(widthAt(e));
    drag=null;commit(width);handle.releasePointerCapture(e.pointerId)
  };
  handle.onlostpointercapture=()=>{
    if(drag){drag=null;cancel()}
    if(handle===separator)$('layout').classList.remove('resizing-side')
  }
}
enablePaneDrag(separator,1,setSidebarWidth,width=>{db.sidebarWidth=width;save()},()=>setSidebarWidth(db.sidebarWidth));
separator.onkeydown=e=>{
  const current=Number(separator.getAttribute('aria-valuenow'));
  const widths={Home:240,End:520,ArrowLeft:current-8,ArrowRight:current+8};
  if(!(e.key in widths))return;e.preventDefault();db.sidebarWidth=setSidebarWidth(widths[e.key]);save()
};
function element(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function icon(name){const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),use=document.createElementNS(ns,'use');use.setAttribute('href','/icons.svg#'+name);svg.setAttribute('aria-hidden','true');svg.append(use);return svg}
for(const e of document.querySelectorAll('[data-icon]'))e.prepend(icon(e.dataset.icon));
function btn(label,name,run,cls='icon'){const b=element('button',cls);b.type='button';b.title=label;b.setAttribute('aria-label',label);b.append(icon(name));b.onclick=run;return b}
function row(label,name,run,note){const b=btn(label,name,run,'modal-row');b.append(element('span','',label));if(note)b.append(element('small','',note));return b}
let timer;function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(timer);timer=setTimeout(()=>$('toast').hidden=true,1900)}
function theme(){
  const selected=db.theme==='system'?(dark.matches?'dark':'light'):db.theme;
  document.documentElement.dataset.theme=selected;
  document.querySelector('meta[name="theme-color"]').content=selected==='dark'?'#1f1a1e':'#f9f9f9'
}
dark.addEventListener('change',theme);
function projectDirectoryKey(path){
  const canonical=isWindowsRoot(path)||path.startsWith('//')?path.replaceAll('\\','/').toLowerCase():path;
  return canonical.replace(/\/+$/,'')||'/'
}
function hostProject(path,id){
  const projects=db.hostProjects||[];
  if(id)return projects.find(p=>p.id===id);
  if(!path)return null;
  const key=projectDirectoryKey(path);
  const matches=projects.filter(p=>p.roots.some(root=>projectDirectoryKey(root)===key));
  return matches.length===1?matches[0]:null
}
function isProjectPath(value){return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value)}
function projectFolder(path){return path?.split(/[\\/]/).filter(Boolean).at(-1)}
function projectName(path,id){
  const project=hostProject(path,id);
  const folder=projectFolder(path)||'default-workspace';
  return project?.name?(project.roots.length>1?project.name+' · '+folder:project.name):folder
}
async function fetchProjectPage(projectId,page){
  const byPath=isProjectPath(projectId),field=byPath?'projectCwd':'projectId';
  const result=await threadApi(page.global?{cursor:page.cursor}:{[field]:projectId,cursor:page.cursor});
  const belongs=item=>byPath?item.cwd===projectId&&!item.projectId:item.projectId===projectId;
  if(!Array.isArray(result.items))throw Error('主机会话目录格式无效');
  const global=!Object.hasOwn(result,field);
  if(!global&&(result[field]!==projectId||!result.items.every(belongs)))throw Error('主机返回的项目不匹配');
  if(result.cursor&&result.cursor===page.cursor)throw Error('主机返回了重复的目录游标');
  return {items:result.items.filter(belongs),global,cursor:result.cursor,more:!!result.cursor}
}
const pendingProjectLoads=new Set();
async function loadProjectPage(projectId){
  if(firstDirectoryRequest)try{await firstDirectoryRequest}catch{return}
  const page=projectPages.get(projectId)||{cursor:null,more:true,busy:false,count:0};
  if(page.busy||!page.more)return;
  page.busy=true;projectPages.set(projectId,page);renderSidebarHistory();
  const load=fetchProjectPage(projectId,page);pendingProjectLoads.add(load);
  try{
    const {items,...state}=await load;
    if(projectPages.get(projectId)!==page)return;
    const index=new Map((db.hostIndex||[]).map(item=>[item.thread,item]));
    for(const item of items)index.set(item.thread,item);
    Object.assign(page,state);page.count++;
    (db.projectPageCounts??={})[projectId]=page.count;
    db.hostIndex=[...index.values()];save()
  }catch(e){toast(e.message)}
  finally{pendingProjectLoads.delete(load);page.busy=false;renderSidebarHistory()}
}
const sidebarHistory=document.querySelector('#side .history');
const sidebarScrollKey='codex-sidebar-scroll';
let restoreSidebarScroll=true;
function restoreSidebarPosition(){
  if(!restoreSidebarScroll||!sidebarHistory.clientHeight||!$('list').childElementCount)return;
  sidebarHistory.scrollTop=Number(pageStorage.getItem(sidebarScrollKey))||0;
  restoreSidebarScroll=false
}
window.addEventListener('pagehide',()=>{
  if(sidebarHistory.clientHeight)pageStorage.setItem(sidebarScrollKey,String(sidebarHistory.scrollTop))
});
sidebarHistory.addEventListener('scroll',()=>{
  if(!restoreSidebarScroll&&sidebarHistory.clientHeight)
    pageStorage.setItem(sidebarScrollKey,String(sidebarHistory.scrollTop))
},{passive:true});
new ResizeObserver(restoreSidebarPosition).observe(sidebarHistory);
function showUnread(button,state){
  if(!state?.firstUnread)return;
  button.classList.add('thread-unread');
  button.setAttribute('aria-label',button.textContent+'，未读')
}
function sidebarChatButton(title){
  const button=element('button','');
  button.title=title;
  button.append(element('span','sidebar-chat-title',title));
  return button
}
function renderSidebarHistory(){
  const list=$('list');list.replaceChildren();
  const pins=$('pins'),pinned=db.pinnedThreads||[],pinIds=new Set(pinned.map(item=>item.thread));
  pins.hidden=!pinned.length;pins.replaceChildren();
  if(pinned.length)pins.append(element('div','section-label','已置顶'));
  for(const item of pinned){
    const local=db.chats.find(c=>c.thread===item.thread),wrap=element('div','history-row'+(local===current()?' active':''));
    const button=sidebarChatButton(local?.title||item.title);button.onclick=()=>loadRemoteChat(item);wrap.append(button);
    showUnread(button,local?.readState??item.readState);
    wrap.append(btn('聊天选项','ellipsis',event=>options(local||item,event.currentTarget),'icon more'));pins.append(wrap)
  }
  const groups=new Map(),seen=new Set(),folded=new Set(db.foldedProjects||[]);
  const add=(path,item)=>{if(!groups.has(path))groups.set(path,[]);groups.get(path).push(item)};
  const projectsByKey=new Map();
  for(const project of db.hostProjects||[]){
    if(!project.id){for(const path of project.roots)groups.set(path,[]);continue}
    projectsByKey.set(project.id,project);groups.set(project.id,[])
  }
  const groupKey=c=>hostProject(c.cwd,c.projectId)?.id||c.cwd||'';
  for(const c of db.chats){
    if(c.thread)seen.add(c.thread);
    if(c.archived||pinIds.has(c.thread))continue;
    if(c.messages.length||c.thread)add(groupKey(c),{local:c,title:c.title,updated:c.updated});
    else if(c!==current()&&(c.draft?.trim()||c.files?.length)){
      const preview=c.draft.trim().split('\n')[0].slice(0,60)||c.files[0].name;
      add(groupKey(c),{local:c,title:'草稿 · '+preview,updated:c.updated})
    }
  }
  for(const item of db.hostIndex||[])if(!seen.has(item.thread)&&!pinIds.has(item.thread))add(groupKey(item),{remote:item,title:item.title,updated:item.updated*1000});
  const activeGroup=current()&&groupKey(current());
  if(activeGroup&&!groups.has(activeGroup))groups.set(activeGroup,[]);
  const recent=groups.get('');
  groups.delete('');
  if(recent?.length)groups.set('',recent);
  for(const [path,items] of groups){
    const group=element('div','project-group'),project=projectsByKey.get(path);
    if(path){
      const head=element('div','group-head'),toggle=element('button','project-row');
      const title=project?.name||projectName(path);
      toggle.append(icon(folded.has(path)?'folder-closed':'folder-open'),element('span','',title),icon(folded.has(path)?'chevron-right':'chevron-down'));
      toggle.title=project?.roots.join('\n')||path||title;toggle.setAttribute('aria-expanded',String(!folded.has(path)));
      toggle.onclick=()=>{if(folded.has(path))folded.delete(path);else folded.add(path);db.foldedProjects=[...folded];save();renderSidebarHistory()};
      head.append(toggle);
      if(!project||project.roots.length)head.append(btn('在 '+title+' 中新建任务','square-pen',()=>{
        if(!project||project.roots.length===1){start(project?project.roots[0]:path||null,project?.id||null);return}
        const body=modal('选择工作目录');
        for(const root of project.roots)body.append(row(root,'folder-open',()=>start(root,project.id)))
      },'icon group-new'));
      group.append(head)
    }else{
      group.classList.add('recent-chats');group.append(element('div','section-label','最近'))
    }
    list.append(group);
    if(path&&folded.has(path))continue;
    items.sort((a,b)=>b.updated-a.updated);
    const expanded=new Set(db.expandedProjects||[]),all=expanded.has(path);
    const visible=all?items:items.filter((item,i)=>i<5||item.local===current());
    for(const item of visible){
      const wrap=element('div','history-row'+(item.local===current()?' active':'')),pick=sidebarChatButton(item.title);
      pick.dataset.thread=item.local?.thread||item.remote?.thread||'';pick.onclick=()=>item.local?openCachedChat(item.local):loadRemoteChat(item.remote);
      showUnread(pick,(item.local||item.remote).readState);
      wrap.append(pick);wrap.append(btn('聊天选项','ellipsis',event=>options(item.local||item.remote,event.currentTarget),'icon more'));group.append(wrap)
    }
    const sources=project?[path,...project.roots.filter(root=>hostProject(root)?.id===project.id)]:isProjectPath(path)?[path]:[];
    const remaining=sources.filter(source=>projectPages.get(source)?.more??!!db.directoryCursor);
    const canLoad=remaining.length>0,loading=remaining.some(source=>projectPages.get(source)?.busy);
    const loadRemaining=async sources=>{for(const source of sources)await loadProjectPage(source)};
    if(items.length>5||canLoad||all){
      const more=element('button','project-more',all?'收起':'展开显示');
      more.setAttribute('aria-expanded',String(all));
      more.onclick=()=>{if(all)expanded.delete(path);else expanded.add(path);db.expandedProjects=[...expanded];save();renderSidebarHistory();if(!all)void loadRemaining(remaining.filter(source=>!projectPages.has(source)))};
      group.append(more);
      if(all&&canLoad){
        const next=element('button','project-more',loading?'正在读取…':'加载更早的项目聊天');
        next.disabled=loading;next.onclick=()=>loadRemaining(remaining);group.append(next)
      }
    }
  }
  restoreSidebarPosition()
}
async function loadRemoteChat(item){
  const c=db.chats.find(x=>x.thread===item.thread);
  if(c){if(item.shared)c.shared=true;if(item.archived)c.archived=true;await openCachedChat(c);return}
  const chat=Object.assign(newChat(),{thread:item.thread,title:item.title||'聊天',cwd:item.cwd,
    projectId:item.projectId,updated:item.updated*1000||Date.now(),shared:item.shared===true,
    archived:item.archived===true,historyMissing:true});
  db.chats.push(chat);await openCachedChat(chat)
}
let selectionRevision=0;
const historyRefreshes=new WeakMap(),historyLoadErrors=new WeakMap();
function showHistoryLoad(c){
  const box=$('history-load');box.hidden=!c.historyMissing;
  if(box.hidden)return;
  const error=historyLoadErrors.get(c);
  box.firstElementChild.textContent=error?'读取失败：'+error:('正在读取 '+receiverName+' 上的聊天记录…');
  box.lastElementChild.hidden=!error
}
$('history-load').lastElementChild.onclick=()=>refreshCurrentHistory(current());
function retryVisibleHistory(){
  const c=current();
  if(!document.hidden&&c&&historyLoadErrors.has(c))void refreshCurrentHistory(c)
}
window.addEventListener('online',retryVisibleHistory);
document.addEventListener('visibilitychange',retryVisibleHistory);
async function openCachedChat(c,restore=false){
  select(c,restore);
  await refreshCurrentHistory(c)
}
function applyHostTurn(c,data){
  if(Object.hasOwn(data,'usage'))c.usage=data.usage;
  if(Object.hasOwn(data,'goal'))c.goal=data.goal;
  if(Object.hasOwn(data,'threadServiceTier'))c.threadServiceTier=data.threadServiceTier;
  c.pending=data.pending||null;
  c.turn=data.turn||null;
  c.activeTurn=c.pending?null:data.activeTurn||null;
  c.externalWait=c.activeTurn?hostWaitLabel(data.activeFlags):null;
  if(c.pending&&c.selectedForNext)c.selectionDuringTurn=c.pending
}
async function checkHostReceipt(c){
  const body=modal('主机上的最近一轮'),status=element('p','quiet','正在读取主机记录…');
  body.append(status);
  try{
    const data=await threadApi({thread:c.thread,shared:true},AbortSignal.timeout(30000));
    if(!body.contains(status)||c!==current()||!$('dialog').open)return;
    const input=data.messages.findLast(m=>m.role==='user');
    status.textContent=input?'主机记录的最近一条用户消息':'主机尚未返回用户消息';
    if(input){
      body.append(element('p','',input.text||'（附件消息）'));
      const replies=data.messages.slice(data.messages.indexOf(input)+1).filter(m=>m.role==='assistant'&&m.text);
      if(replies.length){
        body.append(element('p','quiet','主机回复'));
        for(const reply of replies)body.append(element('p','',reply.text))
      }else body.append(element('p','quiet',data.activeTurn?'主机正在处理这一轮。':'主机尚未返回这一轮的回复。'))
      if(input.turn)body.append(row('在聊天中打开主机记录','message-circle',()=>{
        if(c!==current()||!c.receiptUnknown||c.pending||c.thread!==data.thread)return;
        closeDialog();applyHistorySnapshot(c,data,true);void refreshCurrentHistory(c,true)
      }))
    }
  }catch{status.textContent='暂时无法读取主机记录。'}
  if(body.contains(status)&&c===current())body.append(row('重新读取','refresh-cw',()=>checkHostReceipt(c)))
}
function applyHistorySnapshot(c,data,reviewed=false){
  const loadedMessages=withKnownSteps(c,data.messages);
  const pane=$('scroller'),reading=loadedMessages!==c.messages&&!isAtLatestMessage(pane)&&firstVisibleMessage(pane);
  const oldRows=historyRender?.chat===c?historyRender.rows:[];
  const anchor=oldRows[reading?.index];
  delete c.historyMissing;historyLoadErrors.delete(c);showHistoryLoad(c);
  if(Object.hasOwn(data,'readState'))c.readState=data.readState;
  if(data.threadConfig)c.threadConfig=data.threadConfig;
  if(Object.hasOwn(data,'sectionId'))c.sectionId=data.sectionId;
  applyHostTurn(c,data);c.messages=loadedMessages;c.title=data.name||c.title;c.cwd=data.cwd;if(Object.hasOwn(data,'projectId'))c.projectId=data.projectId;
  if(reviewed){delete c.receiptUnknown;c.error=null}
  c.parent=data.parent||(reviewed?null:c.parent);
  save();renderSidebarHistory();renderProjectName(c);renderGoal(c);modelLabel(c);messages(false);
  if(anchor){
    const sameGroup=m=>m.role===anchor.role&&(!anchor.turn||m.turn===anchor.turn);
    const indices=[];
    historyRender.rows.forEach((m,i)=>{if(sameGroup(m))indices.push(i)});
    const exact=indices.filter(i=>anchor.text&&historyRender.rows[i].text===anchor.text);
    let index=indices.find(i=>anchor.id&&historyRender.rows[i].id===anchor.id)
      ??(exact.length===1?exact[0]:undefined);
    if(index===undefined&&anchor.turn){
      const ordinal=oldRows.slice(0,reading.index).filter(sameGroup).length;
      index=indices[ordinal]
    }
    const node=$('messages').children[index];
    if(node)pane.scrollTop+=node.getBoundingClientRect().top-pane.getBoundingClientRect().top-reading.inset
  }
  if(c.pending)void poll(c);else if(c.activeTurn)void followExternalTurn(c,selectionRevision)
}
async function refreshCurrentHistory(c,shared=c.shared===true){
  if(!c.thread||c.pending||c.activeTurn)return;
  const revision=selectionRevision,previousParent=c.parent,previousUpdated=c.updated,previousReceipt=c.receiptUnknown;
  if(historyRefreshes.get(c)===revision)return;
  historyRefreshes.set(c,revision);
  const controller=new AbortController();
  const cancelRead=()=>controller.abort();
  const timeout=setTimeout(cancelRead,30000);
  document.addEventListener('chat-selected',cancelRead,{once:true});
  if(c.historyMissing){historyLoadErrors.delete(c);showHistoryLoad(c)}
  try{
    const data=await threadApi({thread:c.thread,shared,opening:c.historyMissing||undefined},controller.signal);
    if(revision!==selectionRevision||current()!==c||c.pending||c.parent!==previousParent||c.updated!==previousUpdated||c.receiptUnknown!==previousReceipt)return;
    applyHistorySnapshot(c,data);
    return true
  }catch(error){
    if(revision===selectionRevision&&current()===c){
      historyLoadErrors.set(c,controller.signal.aborted?'等待主机超时，请重试。':error.message);
      if(c.historyMissing)showHistoryLoad(c)
      else toast('主机刷新失败，显示上次读取的对话')
    }
    return false
  }
  finally{
    clearTimeout(timeout);document.removeEventListener('chat-selected',cancelRead);
    if(historyRefreshes.get(c)===revision)historyRefreshes.delete(c)
  }
}
let threadWatch;
function syncThreadWatch(){
  const c=current();
  const thread=document.visibilityState==='visible'&&c&&!c.pending&&!c.historyMissing&&c.thread;
  if(threadWatch?.thread===thread)return;
  if(threadWatch){threadWatch.source.close();threadWatch=null}
  if(!thread||typeof EventSource!=='function')return;
  const source=new EventSource(devicePath+'/api/thread-events/'+thread);
  const watch=threadWatch={thread,source,ready:false};
  let queued=null,loading=false;
  source.addEventListener?.('text',event=>{
    if(threadWatch!==watch||current()!==c||c.pending)return;
    let packet;
    try{packet=JSON.parse(event.data)}catch{return}
    if(!Array.isArray(packet))return;
    const [turn,id,delta]=packet;
    if(typeof turn!=='string'||typeof id!=='string')return;
    if(delta===null)watch.preview={turn,id,text:''};
    else if(typeof delta==='string'&&watch.preview?.id===id&&!watch.preview.disconnected&&watch.preview.turn===turn){
      watch.preview.text+=delta
    }else return;
    if(!watch.frame)watch.frame=requestAnimationFrame(()=>{
      watch.frame=null;if(threadWatch===watch&&current()===c)messages(false)
    })
  });
  source.onerror=()=>{watch.ready=false;watch.lastChange=0;if(watch.preview)watch.preview.disconnected=true};
  source.onmessage=async e=>{
    if(threadWatch!==watch||!['READY','CHANGED'].includes(e.data))return;
    watch.ready=true;
    if(e.data==='CHANGED')watch.lastChange=Date.now();
    if(c.activeTurn){void followExternalTurn(c,selectionRevision,true);return}
    if(e.data==='READY'){
      // An activity probe on reconnect can take longer than a new change notice.
      while(threadWatch===watch&&!watch.lastChange&&historyRefreshes.has(c))await sleep(100);
      if(threadWatch!==watch||watch.lastChange)return;
      try{await inspectForegroundTurn()}catch{if(!watch.lastChange)watch.ready=false}
      return
    }
    queued=true;
    if(loading)return;
    loading=true;
    try{
      while(queued&&threadWatch===watch){
        if(historyRefreshes.has(c)){await new Promise(resolve=>setTimeout(resolve,100));continue}
        queued=false;
        if(await refreshCurrentHistory(c,true)===false)watch.ready=false
      }
    }catch{watch.ready=false}
    finally{loading=false}
  }
}
async function inspectForegroundTurn(){
  const c=current(),revision=selectionRevision;
    if(document.visibilityState!=='visible'||!c?.thread||c.pending||c.activeTurn||historyRefreshes.has(c))return;
    const response=await deviceFetch('/api/thread-activity/'+c.thread,{method:'POST'});
    if(!response.ok)throw Error();
    const snapshot=await response.json();
    if(document.visibilityState!=='visible'||current()!==c||selectionRevision!==revision||c.pending||c.activeTurn)return;
    const latest=c.messages.findLast(message=>message.turn)?.turn;
    const running=snapshot.turnStatus==='inProgress'&&!['idle','notLoaded','systemError'].includes(snapshot.state);
    if(snapshot.turn&&(snapshot.turn!==latest||running)){
      if(await refreshCurrentHistory(c,true)===false)throw Error('未能刷新会话')
    }
}
async function checkForegroundTurn(){
  let delay=12000;
  try{if(!threadWatch?.ready)await inspectForegroundTurn()}
  catch{delay=30000}
  finally{setTimeout(checkForegroundTurn,delay)}
}
const externalFollowers=new WeakMap();
async function followExternalTurn(c,revision,notify=false){
  const active=()=>current()===c&&selectionRevision===revision&&c.activeTurn&&!c.pending&&document.visibilityState==='visible';
  if(!active())return;
  const existing=externalFollowers.get(c);
  if(existing?.revision===revision){
    if(notify){existing.changed=true;existing.wake?.()}
    return
  }
  const follower={revision,changed:notify};
  externalFollowers.set(c,follower);
  let retry=0;
  try{
    while(active()){
      if(!follower.changed){
        const pushed=threadWatch?.ready&&Date.now()-threadWatch.lastChange<8000;
        const wait=retry||(pushed?8000:1200);
        await new Promise(resolve=>{
          const timer=setTimeout(resolve,wait);
          follower.wake=()=>{clearTimeout(timer);resolve()}
        });
        follower.wake=null
      }
      if(!active())break;
      follower.changed=false;
      try{
        const observedTurn=c.activeTurn;
        const data=await threadApi({thread:c.thread,shared:true});
        if(!active())break;
        if(c.activeTurn!==observedTurn)continue;
        c.messages=withKnownSteps(c,data.messages);applyHostTurn(c,data);c.parent=data.parent||c.parent;
        if(data.threadConfig)c.threadConfig=data.threadConfig;
        save();renderGoal(c);modelLabel(c);messages(false);retry=0;
        if(c.pending)void poll(c)
      }catch{
        if(!retry&&active())toast('连接中断，正在重新读取主机任务');
        retry=Math.min((retry||1200)*2,15000)
      }
    }
  }finally{if(externalFollowers.get(c)===follower)externalFollowers.delete(c)}
}
function fitPrompt(){
  const box=$('prompt');
  box.style.height='auto';box.style.height=Math.min(180,box.scrollHeight)+'px'
}
let promptWidth;
new ResizeObserver(([entry])=>{
  if(entry.contentRect.width===promptWidth)return;
  promptWidth=entry.contentRect.width;fitPrompt()
}).observe($('prompt'));
document.fonts?.addEventListener('loadingdone',fitPrompt);
function resize(){fitPrompt();updateSendControls()}
function updateSendControls(){const box=$('prompt'),send=$('send'),c=current(),running=!!(c.pending||c.activeTurn),turn=c.pending?c.turn:c.activeTurn;
  updatePermissionLabel(c);
  $('plan-mode').disabled=running;
  $('steer').hidden=!(turn&&(box.value.trim()||c.files.length));
  $('steer').disabled=!!c.steering||!!readingFiles.get(c);
  send.disabled=c.historyMissing|| (running?(!turn||c.stopping===turn):!$('receiver-setup').hidden||!!readingFiles.get(c)||!(box.value.trim()||c.files.length));
  send.title=c.historyMissing?'读取聊天记录后可发送':running?'停止当前任务':$('receiver-setup').hidden?'发送消息':'请先完成设备授权';
  send.setAttribute('aria-label',send.title);
  send.classList.toggle('is-stop',running);
  send.type=running?'button':'submit';window.updateVoiceControl?.()}
function goalLabel(status){
  return ({active:'进行中的目标',paused:'已暂停的目标',blocked:'受阻的目标',usageLimited:'达到用量限制',budgetLimited:'达到预算上限',complete:'已完成的目标'})[status]||'目标'
}
function renderGoal(c){
  const goal=c.goal,card=$('goal-card');card.hidden=!goal?.objective;
  if(card.hidden)return;
  $('goal-status').textContent=goalLabel(goal.status);$('goal-objective').textContent=goal.objective;
  const seconds=Math.max(0,Math.floor(goal.timeUsedSeconds)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds/60)%60;
  $('goal-time').textContent=Number.isFinite(seconds)?[hours?hours+'h':'',hours||minutes?minutes+'m':'',seconds%60||!seconds?seconds%60+'s':''].filter(Boolean).join(' '):'';
  $('goal-actions').hidden=c.archived||!c.thread||!Number.isFinite(goal.createdAt);
  const toggle=$('goal-toggle'),paused=goal.status==='paused';
  toggle.hidden=!paused&&goal.status!=='active';toggle.title=paused?'继续目标':'暂停目标';
  toggle.setAttribute('aria-label',toggle.title);toggle.replaceChildren(icon(paused?'play':'pause'))
}
function goalDialog(action){
  const c=current(),g=c.goal;if(!g)return;
  const body=modal(goalLabel(g.status));body.append(element('p','goal-full',g.objective));
  if(Number.isFinite(g.tokensUsed))body.append(element('p','quiet','已用 '+g.tokensUsed.toLocaleString()+' tokens'));
  if(Number.isFinite(g.tokenBudget))body.append(element('p','quiet','预算 '+g.tokenBudget.toLocaleString()+' tokens'));
  if(c.archived||!c.thread||!Number.isFinite(g.createdAt))return;
  const feedback=element('p','quiet');feedback.setAttribute('role','status');
  const submit=async update=>{
    const controls=[...body.querySelectorAll('button,textarea')];
    controls.forEach(control=>control.disabled=true);feedback.textContent='正在保存到主机…';
    try{
      const res=await deviceFetch('/api/thread-goal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        thread:c.thread,expected:{objective:g.objective,status:g.status,createdAt:g.createdAt},...update})});
      const data=await res.json();
      if(Object.hasOwn(data,'goal')){c.goal=data.goal;save();if(current()===c)renderGoal(c)}
      if(!res.ok)throw Error(data.error||'主机未确认修改');
      if(body.contains(feedback))closeDialog()
    }catch(e){feedback.textContent=e.message;controls.forEach(control=>control.disabled=false)}
  };
  function edit(){
    const field=element('textarea','field');field.value=g.objective;field.setAttribute('aria-label','目标内容');
    body.replaceChildren(field,row('保存目标','square-pen',()=>{if(field.value.trim())void submit({objective:field.value})}),feedback);field.focus()
  }
  if(action==='edit'){edit();return}
  if(action==='clear'){
    body.append(row('确认清除目标','x',()=>submit({clear:true})),row('取消','corner-down-left',closeDialog),feedback);return
  }
  if(action==='toggle'){
    body.append(feedback);if(g.status==='active'||g.status==='paused')void submit({status:g.status==='active'?'paused':'active'});return
  }
  body.append(row('编辑目标','square-pen',edit));
  if(g.status==='active')body.append(row('暂停目标','pause',()=>submit({status:'paused'})));
  if(g.status==='paused')body.append(row('继续目标','play',()=>submit({status:'active'})));
  body.append(feedback)
};
$('goal-details').onclick=()=>goalDialog();
$('goal-edit').onclick=()=>goalDialog('edit');
$('goal-clear').onclick=()=>goalDialog('clear');
$('goal-toggle').onclick=()=>goalDialog('toggle');
function attachmentImage(url,name='图片附件'){
  const img=element('img','attachment-image');img.src=url;img.alt=name;
  const trigger=element('button','attachment-preview');trigger.type='button';
  trigger.setAttribute('aria-label','查看'+name);trigger.setAttribute('aria-haspopup','dialog');trigger.append(img);
  trigger.onclick=()=>{
    const body=modal(name),dialog=$('dialog');dialog.classList.add('image-viewer');
    const viewport=element('div','image-viewport'),full=element('img');
    full.alt=name;full.src=url;viewport.append(full);
    const zoom=element('button','image-zoom','原始尺寸');zoom.type='button';zoom.setAttribute('aria-pressed','false');
    function toggleSize(event){
      const before=full.getBoundingClientRect();
      const pointed=event.currentTarget===full;
      const x=pointed?event.clientX-before.left:before.width/2;
      const y=pointed?event.clientY-before.top:before.height/2;
      const original=viewport.classList.toggle('original-size');
      zoom.setAttribute('aria-pressed',String(original));zoom.textContent=original?'适应窗口':'原始尺寸';
      if(!original||!before.width||!before.height){viewport.scrollTo(0,0);return}
      const after=full.getBoundingClientRect(),frame=viewport.getBoundingClientRect();
      const targetX=pointed?event.clientX:frame.left+viewport.clientWidth/2;
      const targetY=pointed?event.clientY:frame.top+viewport.clientHeight/2;
      viewport.scrollBy(after.left+x*after.width/before.width-targetX,
        after.top+y*after.height/before.height-targetY)
    }
    zoom.onclick=toggleSize;full.onclick=toggleSize;
    body.append(viewport,zoom)
  };
  return trigger
}
function renderProjectName(c){
  for(const name of document.querySelectorAll('.project-name')){name.textContent=!c.cwd&&!c.projectId&&name.closest(".hostline")?"选择项目":projectName(c.cwd,c.projectId);name.title=c.cwd||name.textContent}
  const title=$('home-title'),project=hostProject(c.cwd,c.projectId);
  const label=c.projectId&&(project?.name?.trim()||projectFolder(c.cwd));
  if(!label){
    if(title.textContent!=='我们要构建什么？')title.textContent='我们要构建什么？';
    return
  }
  let select=title.querySelector('button');
  if(!select){
    select=element('button','hero-project');select.type='button';select.dataset.action='project';
    select.setAttribute('aria-haspopup','dialog');
    title.replaceChildren(document.createTextNode(''),select,document.createTextNode(''))
  }
  select.textContent=label;select.title=c.cwd||label;
  const build=project?.hasGitRoot;
  title.firstChild.data=build?'你想让我们在 ':'我们应该在';
  title.lastChild.data=build?' 中构建什么？':'中做些什么？'
}
function archiveComposer(c){
  $('composer').hidden=!!c.archived;$('archive-notice').hidden=!c.archived;
}
function questionDraftKey(c,token){return 'codex-question:'+JSON.stringify([c.id,c.pending,c.turn,token])}
function pendingQuestions(c){
  const box=$('pending-questions'),requests=c.pending?Object.entries(c.inputRequests||{}):[];
  const owner=JSON.stringify([c.id,c.pending,c.turn]);
  const key=JSON.stringify([owner,...requests.map(([token])=>token)]);
  if(box.dataset.owner!==owner){box.replaceChildren();box.dataset.owner=owner}
  if(box.dataset.key===key)return;box.dataset.key=key;box.hidden=!requests.length;
  const tokens=new Set(requests.map(([token])=>token));
  for(const form of [...box.children])if(!tokens.has(form.dataset.token))form.remove();
  const rendered=new Set([...box.children].map(form=>form.dataset.token));
  for(const [token,questions] of requests){
    if(rendered.has(token))continue;
    const form=element('form','question-form'),fields=[];form.dataset.token=token;
    const draftKey=questionDraftKey(c,token);
    const canSave=questions.every(q=>!q.commandReview&&!q.fileReview&&!q.isSecret);
    let saved={};
    if(canSave)try{saved=JSON.parse(pageStorage.getItem(draftKey))||{}}catch{}
    const draftFields=[];
    const forget=()=>{try{pageStorage.removeItem(draftKey)}catch{}};
    for(const q of questions){
      const field=element('fieldset'),legend=element('legend','',q.question);
      field.append(legend);
      if(q.commandReview){
        const review=q.commandReview;
        field.append(element('pre','approval-command',review.command));
        if(review.cwd)field.append(element('p','quiet','工作目录 · '+review.cwd));
        if(review.reason)field.append(element('p','',review.reason));
        const details=element('details');details.append(element('summary','','请求详情'),element('pre','approval-command',JSON.stringify(review,null,2)));field.append(details)
      }
      if(q.fileReview){
        if(q.fileReview.reason)field.append(element('p','',q.fileReview.reason));
        if(q.fileReview.grantRoot)field.append(element('p','quiet','申请的目录范围 · '+q.fileReview.grantRoot));
        for(const change of Array.isArray(q.changes)?q.changes:[]){
          if(typeof change?.path!=='string'||typeof change.diff!=='string')continue;
          const operation={add:'新增',delete:'删除',update:change.kind?.move_path?'移动':'修改'}[change.kind?.type]||'文件';
          const file=element('details','work-file'),title=element('summary','',operation+' · '+change.path);
          if(change.kind?.move_path)title.append(document.createTextNode(' → '+change.kind.move_path));
          file.open=true;file.append(title);renderFileDiff(file,title,change);field.append(file)
        }
        if(q.complete===false||!q.changes?.length)field.append(element('p','quiet','尚未收到本次修改的完整补丁。'))
      }
      const options=q.options||[];
      for(const option of options){
        const label=element('label','question-option'),input=element('input');input.type='radio';input.name=q.id;input.value=option.label;
        const content=element('span','',option.label);if(option.description)content.append(element('small','quiet',option.description));
        label.append(input,content);field.append(label)
      }
      let text;
      if(!options.length||q.isOther){
        text=element('input','field');text.placeholder=options.length?'其他回答':'填写回答';text.setAttribute('aria-label',text.placeholder);
        text.oninput=()=>{if(text.value)for(const r of field.querySelectorAll('input[type=radio]'))r.checked=false};
        field.addEventListener('change',e=>{if(e.target.type==='radio')text.value=''});field.append(text)
      }
      if(canSave){
        const value=saved[q.id];
        const radio=[...field.querySelectorAll('input[type=radio]')].find(input=>input.value===value?.choice);
        if(radio)radio.checked=true;
        else if(text&&typeof value?.text==='string')text.value=value.text;
        draftFields.push(()=>[q.id,{choice:field.querySelector('input:checked')?.value,text:text?.value}])
      }
      fields.push(()=>[q.id,field.querySelector('input:checked')?.value||text?.value.trim()||'']);form.append(field)
    }
    if(canSave){
      const storeDraft=()=>{try{pageStorage.setItem(draftKey,JSON.stringify(Object.fromEntries(draftFields.map(read=>read()))))}catch{}};
      form.addEventListener('input',storeDraft);form.addEventListener('change',storeDraft)
    }
    const approval=questions.length===1&&!!(questions[0].commandReview||questions[0].fileReview);
    const submit=element('button','submit-answers',approval?'提交审批决定':'提交回答'),status=element('span','quiet');submit.type='submit';status.setAttribute('role','status');
    form.append(submit,status);box.append(form);
    let candidateEnter=false;
    form.onkeydown=event=>{
      candidateEnter=event.key==='Enter'&&isCompositionKey(event);
      if(candidateEnter)setTimeout(()=>{candidateEnter=false},0)
    };
    form.onsubmit=async e=>{
      e.preventDefault();if(submit.disabled||candidateEnter||composingFields.has(document.activeElement))return;
      const entries=fields.map(read=>read()),missing=entries.findIndex(([,value])=>!value);
      if(missing>=0){
        status.textContent=approval?'请选择审批决定':'请回答每个问题';
        form.querySelectorAll('fieldset')[missing].querySelector('input')?.focus();
        return
      }
      const lock=disabled=>{submit.disabled=disabled;for(const field of form.querySelectorAll('fieldset'))field.disabled=disabled};
      lock(true);status.textContent='正在发送…';
      try{
        const res=await deviceFetch('/api/answer/'+c.pending,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          turn:c.turn,token,answers:Object.fromEntries(entries.map(([id,value])=>[id,{answers:[value]}]))})});
        const data=await res.json();
        if(res.status===409){forget();status.textContent=data.error||'此问题已关闭';return}
        if(!res.ok)throw Error(data.error||'提交失败');
        forget();status.textContent='已发送，等待主机继续'
      }catch(err){
        lock(false);status.textContent=err.message;
        if(form.isConnected&&document.activeElement===document.body)submit.focus({preventScroll:true})
      }
    }
  }
}
function composer(){const c=current();archiveComposer(c);pendingQuestions(c);$('plan-mode').hidden=c.collaborationMode!=='plan';renderGoal(c);modelLabel(c);renderProjectName(c);if($('prompt').value!==(c.draft||''))$('prompt').value=c.draft||'';updateEnterHint();$('attachment').replaceChildren();for(const file of c.files){const chip=element('div','chip');if(file.remotePath)chip.title=(''+receiverName+' · ')+file.remotePath;chip.append(file.url?attachmentImage(file.url,file.name):icon(file.directory?'folder-open':'file-text'),element('span','',file.name),btn('移除 '+file.name,'x',()=>{c.files=c.files.filter(f=>f!==file);save();composer()}));$('attachment').append(chip)}resize()}
let readingReply=null;
function stopReadingReply(){
  const active=readingReply;
  if(!active)return;
  readingReply=null;window.speechSynthesis.cancel();active.update()
}
function readReplyButton(message,body){
  const button=btn('朗读','speaker',toggle);
  function update(){
    const active=readingReply?.message===message,label=active?'停止朗读':'朗读';
    button.setAttribute('aria-pressed',String(active));button.setAttribute('aria-label',label);
    button.title=label;button.replaceChildren(icon(active?'stop-reading':'speaker'))
  }
  function toggle(){
    const wasReading=readingReply?.message===message;
    stopReadingReply();if(wasReading)return;
    const synth=window.speechSynthesis;
    if(!synth||!window.SpeechSynthesisUtterance){toast('此浏览器暂不支持朗读');return}
    const plain=body.cloneNode(true);
    plain.querySelectorAll('button,.code-toolbar').forEach(e=>e.remove());
    for(const el of plain.querySelectorAll('p,li,pre,h1,h2,h3,h4,h5,h6,blockquote,tr,br'))el.append('\n');
    const text=plain.textContent.trim();
    if(!text)return;
    const lang=/[\u3400-\u9fff]/u.test(text)?'zh-CN':navigator.language;
    const active={message,update,utterance:null};readingReply=active;update();
    // Send short utterances sequentially so a long answer can be stopped between chunks.
    const chunks=Array.from(text.matchAll(/[^。！？.!?\n]{1,200}[。！？.!?\n]*|[。！？.!?\n]+/gu),m=>m[0]);
    let index=0;
    function next(){
      if(readingReply!==active)return;
      if(index===chunks.length){readingReply=null;active.update();return}
      const utterance=new SpeechSynthesisUtterance(chunks[index++]);active.utterance=utterance;
      utterance.lang=lang;
      utterance.onend=next;
      utterance.onerror=()=>{if(readingReply===active){readingReply=null;active.update();toast('朗读失败，请检查设备语音设置')}};
      try{synth.speak(utterance)}catch{utterance.onerror()}
    }
    next()
  }
  if(readingReply?.message===message)readingReply.update=update;
  update();return button
}
document.addEventListener('chat-selected',e=>{if(e.detail!==current()?.id)stopReadingReply()});
window.addEventListener('pagehide',stopReadingReply);
async function copyText(value){
  if(window.ReceiverKeyboard){
    // Android WebView can deny the async clipboard even during a user tap.
    let written=false;
    const copy=event=>{
      if(!event.clipboardData)return;
      event.clipboardData.setData('text/plain',value);event.preventDefault();written=true
    };
    document.addEventListener('copy',copy);
    try{if(document.execCommand('copy')&&written)return}
    finally{document.removeEventListener('copy',copy)}
  }
  await navigator.clipboard.writeText(value)
}
function copyButton(label,getText){
  const button=btn(label,'copy',async()=>{
    try{await copyText(getText())}
    catch{toast('浏览器未允许复制');return}
    button.replaceChildren(icon('check'));button.setAttribute('aria-label','已复制');button.title='已复制';
    clearTimeout(timer);timer=setTimeout(()=>{
      button.replaceChildren(icon('copy'));button.setAttribute('aria-label',label);button.title=label
    },1500)
  });
  let timer;return button
}
const workItems=new WeakMap();
const workScrollKey=(chatId,recordId)=>'codex-work-scroll:'+JSON.stringify([chatId,recordId]);
let displayedWorkView;
function rememberWorkScroll(detail){
  if(previousDetail&&displayedWorkView?.ids.includes(previousDetail.id)&&detail.clientHeight){
    const key=workScrollKey(workChat,previousDetail.id);
    if(detail.scrollTop)pageStorage.setItem(key,String(detail.scrollTop));
    else pageStorage.removeItem(key)
  }
}
window.addEventListener('pagehide',()=>rememberWorkScroll($('work-detail')));
let workChat=null,previousDetail=null,previousTabs='';
const changeLabels={add:'新增',update:'修改',delete:'删除'};
function relativeChangeLabel(path,cwd){
  if(!cwd)return path;
  const windows=/^[a-z]:[\\/]/i.test(cwd);
  const root=windows?cwd.replace(/\\/g,'/'):cwd;
  const name=windows?path.replace(/\\/g,'/'):path;
  const prefix=root.replace(/\/+$/,'')+'/';
  const inside=windows?name.toLowerCase().startsWith(prefix.toLowerCase()):name.startsWith(prefix);
  return inside?name.slice(prefix.length):path
}
function recordTitle(record){
  if(record.type!=='fileChange')return record.title||record.type;
  const changes=record.changes||[];
  if(changes.length===1){
    const change=changes[0];
    const windows=/^[a-z]:[\\/]/i.test(current()?.cwd||change.path);
    const name=change.path?.split(windows?/[\\/]/:'/').pop();
    if(name)return (changeLabels[change.kind?.type]||'变更')+' '+name
  }
  return changes.length?'文件变更（'+changes.length+'）':'文件变更'
}
function chatWorkRecords(chat){
  const rows=[...chat.messages,...(orderedSnapshots.get(chat)||[])];
  const items=[...rows.flatMap(row=>row.items||[]),...(chat.items||[])];
  return new Map(items.filter(item=>item.id).map(item=>[item.id,item]))
}
function newWorkTabButton(){
  const button=btn('新建标签页','plus',()=>{
    const chat=current(),body=modal('新建标签页',button);
    const records=[...chatWorkRecords(chat).values()].reverse();
    const titles=new Map();
    for(const item of records){
      const name=recordTitle(item);titles.set(name,(titles.get(name)||0)+1)
    }
    const field=element('input','field'),list=element('div','work-record-options');
    field.type='search';field.placeholder='查找执行记录';field.setAttribute('aria-label',field.placeholder);
    if(records.length>1)body.append(field);
    body.append(list);
    const options=records.map(item=>{
      const label=recordTitle(item);
      const paths=(item.changes||[]).flatMap(change=>[change.path,change.kind?.move_path]).filter(Boolean);
      const output=(item.output||'').trim();
      const hint=paths.join('、')||output.split('\n').find(line=>line.trim())||activityStatus(item.status);
      const note=titles.get(label)>1?hint.slice(0,100):'';
      const option=row(label,activityIcons[item.type]||'file-text',()=>{
        closeDialog();openRecord(item);
        const tab=$('work-tabs').querySelector('.work-tab[aria-pressed=true]');
        tab?.focus({preventScroll:true});tab?.scrollIntoView({block:'nearest',inline:'nearest'})
      },note);
      if(note)option.setAttribute('aria-description',note);
      list.append(option);
      return {option,search:[label,...paths,output].join('\n').toLocaleLowerCase()}
    });
    const empty=element('p','quiet',records.length?'没有匹配的执行记录。':'此聊天还没有可打开的执行记录。');
    empty.hidden=!!records.length;body.append(empty);
    field.oninput=()=>{
      const query=field.value.trim().toLocaleLowerCase();
      for(const {option,search} of options)option.hidden=!search.includes(query);
      empty.hidden=options.some(({option})=>!option.hidden)
    };
    body.onkeydown=e=>{
      if(isCompositionKey(e)||!['ArrowDown','ArrowUp','Enter'].includes(e.key))return;
      const visible=options.filter(({option})=>!option.hidden);
      if(!visible.length)return;
      if(e.key==='Enter'){if(e.target===field){e.preventDefault();visible[0].option.click()}return}
      e.preventDefault();
      const index=visible.findIndex(({option})=>option===e.target);
      const next=e.key==='ArrowDown'?index+1:index<0?visible.length-1:index-1;
      visible[(next+visible.length)%visible.length].option.focus()
    };
    anchorHeaderMenu(button);
    if(field.isConnected&&!matchMedia('(pointer:coarse)').matches)field.focus();
    else list.querySelector('button')?.focus()
  },'icon work-add-tab');
  button.setAttribute('aria-haspopup','dialog');return button
}
function openRecord(item){
  const chat=current(),view=chat.workView??={ids:[],active:null};chat.summaryOpen=false;delete chat.workHidden;
  if(!workItems.has(chat))workItems.set(chat,new Map());
  workItems.get(chat).set(item.id,item);
  if(!view.ids.includes(item.id))view.ids.push(item.id);
  view.active=item.id;save();renderWorkbench()
}
function renderFileDiff(file,summary,change){
  if(!change.diff)return;
  const pre=element('pre','file-diff'),kind=change.kind?.type;
  const lines=change.diff.split('\n');
  if(lines.at(-1)==='')lines.pop();
  let before=1,after=1,inHunk=false,added=0,removed=0;
  for(const line of lines){
    let cls='',left='',right='';
    const hunk=kind==='update'&&/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if(hunk){
      before=Number(hunk[1]);after=Number(hunk[2]);inHunk=true;cls='diff-hunk'
    }else if(kind==='add'||inHunk&&line.startsWith('+')){
      cls='diff-add';right=after++;added++
    }else if(kind==='delete'||inHunk&&line.startsWith('-')){
      cls='diff-delete';left=before++;removed++
    }else if(inHunk&&line.startsWith(' ')){
      left=before++;right=after++
    }else if(inHunk&&!line.startsWith('\\')){
      inHunk=false
    }
    const row=element('span',cls,line);
    row.dataset.gutter=String(left).padStart(4)+' '+String(right).padStart(4);
    const fileLine=kind==='delete'?left:right;
    if(fileLine)row.dataset.fileLine=String(fileLine);
    pre.append(row)
  }
  if(added)summary.append(element('small','change-added','+'+added));
  if(removed)summary.append(element('small','change-removed','−'+removed));
  file.append(pre)
}
let summarySnapshot;
function openChangedFile(item,path,line){
  openRecord(item);
  const section=[...$('work-detail').querySelectorAll('.work-file')].find(file=>file.dataset.path===path);
  if(section){
    section.open=true;
    const target=line&&section.querySelector('[data-file-line="'+line+'"]');
    if(target){
      target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({block:'center',inline:'nearest'})
    }else{
      section.querySelector('summary').focus();section.scrollIntoView({block:'nearest'});
      if(line)toast('此轮差异未包含第 '+line+' 行')
    }
  }
}
function renderThreadSummary(chat){
  const rows=[...chat.messages,...(orderedSnapshots.get(chat)||[])];
  const plan=rows.findLast(row=>row.role==='steps'||row.role==='plan');
  const files=new Map();
  for(const item of [...rows.flatMap(row=>row.items||[]),...(chat.items||[])]){
    for(const change of item.changes||[])files.set(change.path,item)
  }
  const snapshot=JSON.stringify([chat.id,chat.goal,plan,[...files].map(([path,item])=>[path,item.id,item.status])]);
  if(summarySnapshot===snapshot)return;
  summarySnapshot=snapshot;
  $('work-tabs').replaceChildren(element('strong','summary-title','摘要'),newWorkTabButton());
  const detail=$('work-detail');detail.replaceChildren();
  if(chat.goal?.objective){
    detail.append(element('h3','summary-heading','目标'),element('p','',chat.goal.objective),element('small','quiet',goalLabel(chat.goal.status)))
  }
  if(plan)detail.append(planCard(plan));
  if(files.size){
    detail.append(element('h3','summary-heading','文件变更'));
    for(const [path,item] of files){
      const label=relativeChangeLabel(path,chat.cwd);
      const button=row(label,'file-text',()=>openChangedFile(item,path));
      button.title=path;detail.append(button)
    }
  }
  if(!detail.childElementCount)detail.append(element('p','quiet','此对话暂无目标、计划或文件变更。'))
}
$('header-summary').onclick=()=>{const c=current();c.summaryOpen=c.workHidden||!c.summaryOpen;delete c.workHidden;save();renderWorkbench()};
function endedActivityTurns(chat){
  const turns=new Map();
  for(const message of chat.messages){
    if(message.turn&&(message.interrupted||message.role==='status'&&['interrupted','failed'].includes(message.status))){
      turns.set(message.turn,message.interrupted?'interrupted':message.status)
    }
  }
  return turns
}
function renderWorkbench(){
  const pane=$('workbench'),chat=current(),view=chat.workView;
  const detail=$('work-detail');
  if(workChat!==chat.id){rememberWorkScroll(detail);previousDetail=null;previousTabs='';workChat=chat.id}
  const summary=!!chat.summaryOpen&&chat.messages.length>0;
  const hidden=!!(chat.workHidden&&(summary||view?.ids.length));
  $('work-show').hidden=!hidden;
  $('work-tab-list').hidden=summary;
  $('header-summary').setAttribute('aria-pressed',String(summary&&!hidden));
  if(hidden){pane.hidden=true;return}
  if(summary){rememberWorkScroll(detail);pane.hidden=false;previousTabs='';previousDetail=null;renderThreadSummary(chat);return}
  summarySnapshot=null;
  pane.hidden=!view?.ids.length;
  if(pane.hidden){previousDetail=null;previousTabs='';return}
  const latest=chatWorkRecords(chat);
  const openRecords=view.ids.map(id=>latest.get(id)||workItems.get(chat)?.get(id)).filter(Boolean);
  if(!openRecords.length){pane.hidden=true;previousDetail=null;previousTabs='';return}
  const activeRecord=openRecords.some(r=>r.id===view.active)?view.active:openRecords.at(-1).id;
  const tabs=$('work-tabs');
  const tabState=JSON.stringify([activeRecord,openRecords.map(r=>[r.id,recordTitle(r)])]);
  if(tabState!==previousTabs){
  previousTabs=tabState;tabs.replaceChildren();
  for(const [index,record] of openRecords.entries()){
    const tab=element('button','work-tab');
    tab.dataset.record=record.id;
    tab.append(icon(record.type==='commandExecution'?'terminal':'file-text'),element('span','',recordTitle(record)));
    tab.title=recordTitle(record);tab.setAttribute('aria-pressed',String(record.id===activeRecord));
    function activate(id){
      view.active=id;save();renderWorkbench();
      const selected=tabs.querySelector('.work-tab[aria-pressed="true"]');
      selected?.focus({preventScroll:true});
      selected?.parentElement.scrollIntoView({block:'nearest',inline:'nearest'})
    }
    tab.onclick=()=>activate(record.id);
    function closeTabs(ids,fallback){
      view.ids=view.ids.filter(id=>!ids.has(id));
      for(const id of ids){
        workItems.get(chat)?.delete(id);pageStorage.removeItem(workScrollKey(chat.id,id));
        if(view.folded)delete view.folded[id]
      }
      if(!view.ids.includes(view.active))view.active=view.ids.includes(fallback)?fallback:view.ids.at(-1);
      save();renderWorkbench();
      const target=pane.hidden?$('header-summary'):tabs.querySelector('.work-tab[aria-pressed="true"]');
      target?.focus({preventScroll:true})
    }
    const close=btn('关闭 '+tab.title,'x',()=>closeTabs(new Set([record.id]),openRecords[index+1]?.id||openRecords[index-1]?.id));
    function tabMenu(){
      tab.focus({preventScroll:true});
      const body=modal('标签页操作',tab);
      const others=openRecords.filter(r=>r.id!==record.id),right=openRecords.slice(index+1);
      for(const [label,targets,fallback] of [['关闭',[record],openRecords[index+1]?.id||openRecords[index-1]?.id],['关闭其他标签页',others,record.id],['关闭右侧标签页',right,record.id]]){
        const option=row(label,'x',()=>{
          closeDialog();
          closeTabs(new Set(targets.map(r=>r.id)),fallback)
        });
        option.disabled=!targets.length;body.append(option)
      }
      anchorHeaderMenu(tab)
    }
    tab.oncontextmenu=event=>{event.preventDefault();tabMenu()};
    tab.onkeydown=event=>{
      if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();tabMenu();return}
      if(event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
      const count=openRecords.length;
      const next={ArrowLeft:(index+count-1)%count,ArrowRight:(index+1)%count,Home:0,End:count-1}[event.key];
      if(next!==undefined){event.preventDefault();activate(openRecords[next].id)}
      else if(event.key==='Delete'&&!event.repeat){event.preventDefault();close.click()}
    };
    const wrap=element('div','work-tab-wrap');wrap.append(tab,close);tabs.append(wrap)
  }
  tabs.append(newWorkTabButton());
  }
  const record=openRecords.find(x=>x.id===activeRecord);
  const owner=chat.messages.findLast(m=>m.items?.some(item=>item.id===record.id));
  const ending=owner&&endedActivityTurns(chat).get(owner.turn);
  if(previousDetail&&previousDetail.ending===ending&&['id','title','type','status','output','exitCode','truncated','source','durationMs'].every(key=>record[key]===previousDetail[key])
    &&JSON.stringify(record.changes)===JSON.stringify(previousDetail.changes))return;
  const folded=new Set(previousDetail?.id===record.id?
    [...detail.querySelectorAll('.work-file:not([open])')].map(file=>file.dataset.path):view.folded?.[record.id]||[]);
  rememberWorkScroll(detail);previousDetail={...record,ending};detail.replaceChildren();
  detail.append(element('pre','work-command',recordTitle(record)));
  if(record.source)detail.append(element('p','quiet','工具来源 · '+record.source));
  if(Number.isFinite(record.durationMs))detail.append(element('p','quiet','用时 '+record.durationMs+' 毫秒'));
  if(record.truncated)detail.append(element('p','quiet',truncationLabel(record)));
  if(record.status)detail.append(element('p','quiet',activityStatus(record.status,ending)));
  if(record.changes?.length){
    for(const change of record.changes){
      const file=element('details','work-file'),summary=element('summary'),kind=change.kind?.type;
      file.dataset.path=change.path;file.open=!folded.has(change.path);
      file.ontoggle=()=>{
        if(!file.isConnected||!view.ids.includes(record.id))return;
        const paths=view.folded?.[record.id]||[];
        if(file.open===!paths.includes(change.path))return;
        (view.folded??={})[record.id]=file.open?paths.filter(path=>path!==change.path):[...paths,change.path];save()
      };
      const label=element('span','',relativeChangeLabel(change.path,chat.cwd));
      label.title=change.path;summary.append(label,element('small','quiet',changeLabels[kind]||''));
      file.append(summary);
      if(change.kind?.move_path)file.append(element('p','quiet','移动到 '+change.kind.move_path));
      renderFileDiff(file,summary,change);
      detail.append(file)
    }
  }else if(record.output)detail.append(element('pre','command-output',record.output));
  if(Number.isInteger(record.exitCode))detail.append(element('p','quiet','退出码 '+record.exitCode));
  displayedWorkView=view;
  detail.scrollTop=Number(pageStorage.getItem(workScrollKey(chat.id,record.id)))||0
}
$('work-tab-list').onclick=()=>{
  const trigger=$('work-tab-list'),body=modal('已打开的标签页',trigger),tabs=$('work-tabs');
  for(const tab of tabs.querySelectorAll('.work-tab')){
    const id=tab.dataset.record,active=tab.getAttribute('aria-pressed')==='true';
    const choice=row(tab.title,active?'check':'file-text',()=>{
      closeDialog();
      Array.from(tabs.querySelectorAll('.work-tab')).find(item=>item.dataset.record===id)?.click()
    });
    choice.title=tab.title;choice.setAttribute('aria-current',String(active));body.append(choice)
  }
  anchorHeaderMenu(trigger);body.querySelector('[aria-current=true]')?.focus();
  body.onkeydown=e=>{
    const choices=Array.from(body.children),i=choices.indexOf(document.activeElement);
    const index={Home:0,End:choices.length-1,ArrowDown:(i+1)%choices.length,ArrowUp:(i+choices.length-1)%choices.length}[e.key];
    if(index!==undefined){e.preventDefault();choices[index]?.focus()}
  }
};
$('work-hide').onclick=()=>{
  rememberWorkScroll($('work-detail'));current().workHidden=true;save();renderWorkbench();$('work-show').focus()
};
$('work-show').onclick=()=>{
  delete current().workHidden;save();renderWorkbench();$('work-hide').focus()
};
$('work-close').onclick=()=>{
  const chat=current();
  if(chat.summaryOpen)chat.summaryOpen=false;
  else{
    for(const id of chat.workView?.ids||[])pageStorage.removeItem(workScrollKey(chat.id,id));
    delete chat.workView;workItems.delete(chat)
  }
  save();renderWorkbench()
};
const workResize=$('work-resize');
let preferredWorkWidth=db.workWidth;
function workWidth(width){
  preferredWorkWidth=width;
  const layout=$('layout'),pane=$('workbench');
  const rail=$('app-rail').getBoundingClientRect().width;
  const sidebar=db.collapsed?60:parseFloat(document.documentElement.style.getPropertyValue('--rail'))||252;
  const requested=Math.max(250,width||380);
  const splitVisible=!pane.hidden&&!layout.classList.contains('plugins-open');
  const compact=!mobile.matches&&splitVisible&&!db.collapsed&&innerWidth-rail-sidebar<360+Math.min(requested,380);
  layout.classList.toggle('compact-review',compact);
  if(!compact&&!mobile.matches)layout.classList.remove('drawer');
  const max=Math.max(250,innerWidth-rail-(compact?0:sidebar)-360);
  const value=Math.min(max,requested);
  $('workbench').style.setProperty('--work-width',value+'px');
  workResize.setAttribute('aria-valuemin',250);workResize.setAttribute('aria-valuemax',max);
  workResize.setAttribute('aria-valuenow',value);return value
}
const syncWorkWidth=()=>workWidth(preferredWorkWidth);
new MutationObserver(syncWorkWidth).observe($('workbench'),{attributes:true,attributeFilter:['hidden']});
new ResizeObserver(syncWorkWidth).observe($('side'));
syncWorkWidth();window.addEventListener('resize',syncWorkWidth);
enablePaneDrag(workResize,-1,workWidth,width=>{db.workWidth=width;save()},()=>workWidth(db.workWidth));
workResize.onkeydown=e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();db.workWidth=workWidth(Number(workResize.getAttribute('aria-valuenow'))+(e.key==='ArrowLeft'?8:-8));save()};
function activityStatus(status,ending){
  if(status==='inProgress'&&ending)return (ending==='interrupted'?'本轮已停止':'本轮失败')+'，操作结果未确认';
  return ({inProgress:'执行中',completed:'已完成',failed:'失败',declined:'已拒绝',interrupted:'已停止'})[status]||status||''}
const activityIcons={commandExecution:'terminal',fileChange:'file-text',webSearch:'search',mcpToolCall:'server',dynamicToolCall:'server'};
function truncationLabel(record){
  return record.type==='commandExecution'?'此处显示最近的命令输出':'此处显示工具输出的最后 16384 个字符'
}
function activityHeading(items,ending){
  const names=[];
  for(const type of new Set(items.map(item=>item.type))){
    const group=items.filter(item=>item.type===type);
    const running=!ending&&group.some(item=>item.status==='inProgress');
    const done=group.every(item=>item.status==='completed');
    let name;
    if(type==='commandExecution')name=running?'正在运行命令':done?'运行了命令':'命令执行记录';
    if(type==='webSearch')name=running?'正在搜索网页':'网页搜索';
    if(type==='mcpToolCall'||type==='dynamicToolCall')name=running?'正在调用工具':done?'调用了工具':'工具调用';
    if(type==='fileChange'){
      const paths=new Set(group.flatMap(item=>(item.changes||[]).map(change=>change.path).filter(Boolean)));
      name=running?'正在编辑文件':done&&paths.size?(paths.size===1?'编辑了一个文件':'编辑了 '+paths.size+' 个文件'):'文件变更'
    }
    if(!names.includes(name||'执行记录'))names.push(name||'执行记录')
  }
  return names.join('、')||'执行记录'
}
function disclosureKey(chat,turn,item){
  return 'codex-chat-disclosure:'+JSON.stringify([chat.id,turn,item])
}
function disclosureOpen(key){
  try{return pageStorage.getItem(key)==='1'}catch{return false}
}
function rememberDisclosure(key,open){
  try{if(open)pageStorage.setItem(key,'1');else pageStorage.removeItem(key)}catch{}
}
function activity(items,ending,turn,details=element('details','timeline')){
  if(turn&&items[0]?.id){
    const key=disclosureKey(current(),turn,items[0].id);
    if(details.dataset.disclosure!==key){
      details.dataset.disclosure=key;details.open=disclosureOpen(key);
      details.disclosureObserver?.disconnect();
      details.disclosureObserver=new MutationObserver(()=>rememberDisclosure(key,details.open));
      details.disclosureObserver.observe(details,{attributes:true,attributeFilter:['open']})
    }
  }
  let summary=details.querySelector('summary');
  if(!summary){summary=element('summary');summary.append(element('i'),element('span'));details.append(summary)}
  const kind=activityIcons[items[0]?.type]||'server';
  if(summary.dataset.kind!==kind){summary.firstChild.replaceChildren(icon(kind));summary.dataset.kind=kind}
  const heading=activityHeading(items,ending);
  if(summary.lastChild.textContent!==heading)summary.lastChild.textContent=heading;
  const existing=new Map([...details.querySelectorAll('.timeline-record')].map(node=>[node.dataset.key,node]));
  let previous=summary;
  for(const [index,item] of items.entries()){
    const key=String(item.id??index);
    let record=existing.get(key);existing.delete(key);
    if(!record){
      record=element('div','timeline-record');record.dataset.key=key;
      const line=element('div','timeline-line');
      line.append(icon(activityIcons[item.type]||'server'),element('code'),element('small','quiet'),
        btn('在工作区打开执行记录','panel-left',()=>openRecord(record.item)));
      record.append(line,element('small','quiet',truncationLabel(item)),element('pre','command-output'),element('small','quiet'))
    }
    record.item=item;
    const [line,truncation,output,exit]=record.children,title=recordTitle(item),state=activityStatus(item.status,ending);
    if(line.children[1].textContent!==title)line.children[1].textContent=title;
    if(line.children[2].textContent!==state)line.children[2].textContent=state;
    truncation.hidden=!item.truncated;output.hidden=!item.output;
    const text=item.output||'',old=output.firstChild;
    if(old&&text.startsWith(old.data)){if(text.length>old.length)old.appendData(text.slice(old.length))}
    else if(old||text)output.textContent=text;
    exit.hidden=!Number.isInteger(item.exitCode);
    const code=exit.hidden?'':'退出码 '+item.exitCode;if(exit.textContent!==code)exit.textContent=code;
    if(previous.nextSibling!==record)details.insertBefore(record,previous.nextSibling);
    previous=record
  }
  for(const obsolete of existing.values())obsolete.remove();
  return details
}
function renderAnswer(body,text,wrapped=new Set()){
  body.innerHTML=window.renderMarkdown(text||'');
  decorateAnswer(body,wrapped,0)
}
function resolveChatFile(path,cwd){
  const drive=/^\/?([a-z]):[\\/]/i;
  const windows=drive.test(path)||drive.test(cwd||'');
  if(windows){
    path=path.replace(/\\/g,'/').replace(/^\/(?=[a-z]:\/)/i,'');
    cwd=(cwd||'').replace(/\\/g,'/').replace(/^\/(?=[a-z]:\/)/i,'')
  }
  let prefix='/';
  if(windows&&drive.test(path))prefix=path.slice(0,2)+'/';
  else if(windows)prefix=cwd.slice(0,2)+'/';
  else if(!path.startsWith('/')&&!cwd?.startsWith('/'))return path;
  const full=drive.test(path)?path.slice(2):path.startsWith('/')?path:(windows?cwd.slice(2):cwd)+'/'+path;
  const parts=[];
  for(const part of full.split('/')){
    if(part==='..')parts.pop();
    else if(part&&part!=='.')parts.push(part)
  }
  return prefix+parts.join('/')
}
function chatFileTarget(href){
  if(!href||href.startsWith('//')||href.startsWith('#')||href.startsWith('?'))return;
  const [rawPath,fragment]=href.split('#');
  const suffix=/:([1-9]\d*)(?::[1-9]\d*)?$/.exec(rawPath);
  const filename=suffix?rawPath.slice(0,suffix.index):rawPath;
  if(/^[a-z][a-z0-9+.-]*:/i.test(filename)&&!(/^[a-z]:(?:[\\/]|%5c)/i.test(filename)))return;
  const line=suffix?.[1]||/^L([1-9]\d*)(?:-L?[1-9]\d*)?$/.exec(fragment||'')?.[1];
  return {filename,line}
}
$('messages').addEventListener('click',event=>{
  const link=event.target.closest('.answer a,.live-answer a');
  const href=link?.getAttribute('href');
  const target=chatFileTarget(href);
  if(!target)return;
  event.preventDefault();
  const {filename,line}=target;
  let path;
  const chat=current(),turn=link.closest('.answer,.live-answer').dataset.turn;
  try{path=resolveChatFile(decodeURIComponent(filename),chat.cwd)}catch{toast('文件路径编码无效');return}
  const pathKey=name=>/^[a-z]:\//i.test(name)?name.toLowerCase():name;
  const rows=[...chat.messages,...(orderedSnapshots.get(chat)||[])];
  const items=rows.filter(row=>row.turn===turn).flatMap(row=>row.items||[]);
  if(chat.pending&&turn===chat.turn)items.push(...(chat.items||[]));
  for(const item of items.reverse()){
    const match=item.changes?.find(change=>[change.path,change.kind?.move_path].some(name=>name&&pathKey(resolveChatFile(name,chat.cwd))===pathKey(path)));
    if(match){openChangedFile(item,match.path,line);return}
  }
  const body=modal('主机文件');
  body.append(element('p','',path));
  const roots=(db.hostProjects||[]).flatMap(project=>project.roots);
  const cwd=chat.cwd&&pathKey(resolveChatFile(chat.cwd,chat.cwd));
  const root=roots.filter(dir=>{
    const base=pathKey(resolveChatFile(dir,dir)),prefix=base.endsWith('/')?base:base+'/';
    return pathKey(path).startsWith(prefix)&&(cwd===base||cwd?.startsWith(prefix))
  }).sort((a,b)=>b.length-a.length)[0];
  if(!root){body.append(element('p','quiet','本轮没有此文件的变更记录可预览。'));return}
  const preview=element('button','modal-row',nativePermissionMode?'查看工作区文件':nativePermissionMode===false?'查看 Git 暂存区版本':'查看主机文件');
  body.append(preview);
  preview.onclick=async()=>{
    preview.disabled=true;preview.textContent='正在读取主机文件…';
    try{
      const response=await deviceFetch('/api/project-file-snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,path,thread:chat.thread})});
      const data=await response.json();
      if(!response.ok||typeof data.text!=='string')throw Error(data.error||'无法读取文件');
      if(!preview.isConnected)return;
      const pre=element('pre','snapshot-code'),lines=data.text.split(/\r?\n/);
      const version=data.source==='working-tree'?'工作区文件':'Git 暂存区版本';
      const selected=Number(line);
      const before=lines.slice(0,selected-1),after=lines.slice(selected);
      if(selected>=1&&selected<=lines.length){
        const mark=element('mark','',lines[selected-1]||' ');mark.tabIndex=-1;
        pre.append(before.length?before.join('\n')+'\n':'',mark,after.length?'\n'+after.join('\n'):'');
        preview.replaceWith(element('p','quiet',version+' · 第 '+selected+' 行'),pre);
        mark.focus({preventScroll:true});mark.scrollIntoView({block:'nearest'})
      }else{
        pre.textContent=data.text;preview.replaceWith(element('p','quiet',line?version+' · 指定行已超出文件范围':version),pre)
      }
    }catch(error){preview.disabled=false;preview.textContent='重新读取主机文件';if(preview.isConnected)toast(error.message)}
  }

});
function decorateAnswer(body,wrapped,startIndex){
  for(const link of body.querySelectorAll('a')){
    link.rel='noopener noreferrer';link.target='_blank';
    if(chatFileTarget(link.getAttribute('href'))){
      link.classList.add('chat-file-link');link.prepend(icon('folder-open'))
    }
  }
  let index=startIndex;
  for(const code of body.querySelectorAll('pre > code')){
    const blockIndex=index++;
    const pre=code.parentElement,block=element('div','code-block'),bar=element('div','code-toolbar');
    const language=Array.from(code.classList).find(name=>name.startsWith('language-'))?.slice(9);
    const wrap=element('button','wrap-code','换行');wrap.type='button';
    const update=()=>{
      const on=wrapped.has(blockIndex);pre.classList.toggle('wrapped',on);
      wrap.setAttribute('aria-pressed',String(on));wrap.title=on?'关闭自动换行':'开启自动换行'
    };
    wrap.onclick=()=>{if(wrapped.has(blockIndex))wrapped.delete(blockIndex);else wrapped.add(blockIndex);update()};
    update();bar.append(element('span','code-language',language||''),wrap,copyButton('复制代码',()=>code.textContent));
    pre.replaceWith(block);block.append(bar,pre)
  }
  return index
}
const liveMarkdown=new WeakMap();
function renderLiveAnswer(body,text,wrapped){
  const blocks=window.renderMarkdownBlocks(text||''),previous=liveMarkdown.get(body)||[];
  let start=0;
  while(start<blocks.length&&previous[start]?.html===blocks[start])start++;
  const template=document.createElement('template');
  if(start<blocks.length&&previous[start]){
    template.innerHTML=blocks[start];
    const old=previous[start].nodes.find(n=>n.nodeType===1),next=template.content.firstElementChild;
    const plain=node=>node?.matches('p')&&node.childNodes.length===1&&node.firstChild.nodeType===3;
    const oldCode=old?.matches('.code-block')?old.querySelector('pre>code'):null;
    const nextCode=next?.matches('pre')?next.querySelector(':scope>code'):null;
    if(plain(old)&&plain(next)&&next.textContent.startsWith(old.textContent)){
      old.firstChild.appendData(next.textContent.slice(old.textContent.length));
      previous[start].html=blocks[start];start++
    }else if(oldCode&&nextCode&&oldCode.className===nextCode.className){
      const before=oldCode.textContent,after=nextCode.textContent;
      let common=0;
      while(common<before.length&&common<after.length&&before[common]===after[common])common++;
      if(oldCode.firstChild)oldCode.firstChild.replaceData(common,before.length-common,after.slice(common));
      else oldCode.append(after);
      previous[start].html=blocks[start];start++
    }else if(old?.matches('table')&&next?.matches('table')&&old.tBodies[0]&&next.tBodies[0]){
      // Keep the scroll container and unchanged rows while a wide table is streaming.
      decorateAnswer(next,wrapped,0);
      if(!old.tHead?.isEqualNode(next.tHead)){
        if(old.tHead)old.tHead.remove();
        if(next.tHead)old.prepend(next.tHead)
      }
      const existing=old.tBodies[0],incoming=next.tBodies[0];
      let first=0;
      while(existing.childNodes[first]?.isEqualNode(incoming.childNodes[first]||null))first++;
      while(existing.childNodes.length>first)existing.lastChild.remove();
      while(incoming.childNodes.length>first)existing.append(incoming.childNodes[first]);
      previous[start].html=blocks[start];start++
    }
  }
  for(const block of previous.splice(start))for(const node of block.nodes)node.remove();
  let codeIndex=previous.at(-1)?.endIndex||0;
  for(const html of blocks.slice(start)){
    template.innerHTML=html;
    codeIndex=decorateAnswer(template.content,wrapped,codeIndex);
    previous.push({html,nodes:Array.from(template.content.childNodes),endIndex:codeIndex});
    body.append(template.content)
  }
  liveMarkdown.set(body,previous)
}
const messageWrap=new WeakMap();
const userTextObserver=new ResizeObserver(entries=>{
  for(const {target,contentRect} of entries){
    const container=target.parentElement?.parentElement;
    if(!target.isConnected||!contentRect.width)continue;
    const line=parseFloat(getComputedStyle(target).lineHeight);
    const long=contentRect.height>20*line+1||target.textContent.length>10240;
    let toggle=container.querySelector('.user-text-toggle');
    if(!long){
      toggle?.remove();container.classList.remove('truncated');continue
    }
    if(toggle)continue;
    toggle=element('button','user-text-toggle');toggle.type='button';
    target.id='user-text-'+crypto.randomUUID();toggle.setAttribute('aria-controls',target.id);
    const update=open=>{
      container.classList.toggle('truncated',!open);toggle.setAttribute('aria-expanded',String(open));
      const label=open?'收起':'显示更多';toggle.setAttribute('aria-label',label);
      toggle.replaceChildren(document.createTextNode(label),icon('chevron-down'))
    };
    toggle.onclick=()=>update(toggle.getAttribute('aria-expanded')!=='true');
    update(false);container.append(toggle)
  }
});
function voiceHandoffTranscript(text){
  if(!text?.startsWith('<realtime_delegation>')||!text.trimEnd().endsWith('</realtime_delegation>'))return null;
  const xml=new DOMParser().parseFromString(text,'application/xml'),root=xml.documentElement;
  if(root.tagName!=='realtime_delegation'||root.children.length!==3)return null;
  const [source,input,delta]=root.children;
  if(source.tagName!=='source'||source.textContent!=='transcript_tail_flush'||input.tagName!=='input'||delta.tagName!=='transcript_delta'||delta.children.length)return null;
  return delta.textContent.trim()||null
}
function userBubble(m){
  const group=element('div','user-turn'),bubble=element('div','msg user-msg');
  if(m.text){
    const transcript=voiceHandoffTranscript(m.text);
    const body=element('div','user-text'),viewport=element('div','user-text-viewport'),text=element('div','',transcript||m.text);
    if(transcript)bubble.append(element('strong','voice-transcript-label','语音对话记录'));
    viewport.append(text);body.append(viewport);bubble.append(body);userTextObserver.observe(text);
    if(transcript){
      const original=element('details','voice-original');
      original.append(element('summary','','查看原始记录'),element('pre','',m.text));bubble.append(original)
    }
  }
  for(const url of m.images||[])bubble.append(attachmentImage(url));group.append(bubble);
  if(m.text){const actions=element('div','actions user-actions');actions.append(copyButton('复制消息',()=>m.text));group.append(actions)}
  return group
}
const orderedSnapshots=new WeakMap();
function withKnownSteps(c,history){
  const rows=history.slice();
  for(const end of history.filter(m=>m.role==='status'&&m.status==='interrupted')){
    const inTurn=rows.filter(m=>m.turn===end.turn);
    const known=new Set(inTurn.flatMap(m=>(m.items||[]).map(item=>item.id)));
    const local=c.messages.filter(m=>m.turn===end.turn);
    for(const [index,message] of local.entries()){
      const missing=(message.items||[]).filter(item=>item.id&&item.type==='fileChange'&&!known.has(item.id));
      if(!missing.length)continue;
      const following=local.slice(index+1).find(m=>m.role==='assistant'&&m.text&&inTurn.some(row=>row.role==='assistant'&&row.text===m.text));
      const anchor=following?inTurn.find(m=>m.role==='assistant'&&m.text===following.text):end;
      rows.splice(rows.indexOf(anchor),0,{role:'activity',turn:end.turn,items:missing});
      for(const item of missing)known.add(item.id)
    }
  }
  for(const plan of c.messages.filter(m=>m.role==='steps')){
    if(rows.some(m=>m.turn===plan.turn&&m.role==='steps'))continue;
    const first=rows.findIndex(m=>m.turn===plan.turn);if(first<0)continue;
    const after=c.messages.slice(c.messages.indexOf(plan)+1).find(m=>m.turn===plan.turn&&m.role==='assistant');
    const next=after?rows.findIndex(m=>m.turn===plan.turn&&m.role==='assistant'&&m.text===after.text):-1;
    const end=rows.findLastIndex(m=>m.turn===plan.turn)+1;
    rows.splice(next<0?end:next,0,plan)
  }
  let prefix=0;
  while(prefix<rows.length&&prefix<c.messages.length&&
    JSON.stringify(rows[prefix])===JSON.stringify(c.messages[prefix])){
    rows[prefix]=c.messages[prefix];prefix++
  }
  return prefix===rows.length&&prefix===c.messages.length?c.messages:rows
}
function planCard(row){
  const card=element('section','turn-plan'),heading=element('strong','',row.role==='steps'?'步骤计划':'建议计划');
  card.setAttribute('aria-label',heading.textContent);card.append(heading);
  if(row.role==='plan'){
    const body=element('div','answer');renderAnswer(body,row.text);card.append(body);return card
  }
  if(row.explanation)card.append(element('p','',row.explanation));
  const list=element('ol','plan-steps'),labels={pending:'待处理',inProgress:'进行中',completed:'已完成'};
  for(const step of row.steps){
    const li=element('li'),status=element('span','plan-status',labels[step.status]||step.status);
    li.dataset.status=step.status;li.append(status,element('span','',step.step));list.append(li)
  }
  card.append(list);return card
}
function orderedMessages(c,j){
  const rows=[],tools=new Map((j.progress?.items||[]).map(item=>[item.id,item]));
  for(const {kind,id,part} of j.order){
    if(kind==='assistant'){
      const text=j.parts?.[part]??(j.progress?.activeItem===id?j.progress.message:'');
      if(text)rows.push({role:'assistant',turn:j.turn,id,text})
    }else if(kind==='steps'&&j.stepPlan){
      rows.push({role:'steps',turn:j.turn,id,...j.stepPlan})
    }else if(kind==='plan'&&j.proposedPlans?.[id]){
      rows.push({role:'plan',turn:j.turn,id,text:j.proposedPlans[id]})
    }else if(kind==='user'){
      const user=c.messages.find(m=>m.clientId===id);if(user)rows.push(user)
    }else if(kind==='activity'&&tools.has(id)){
      const last=rows.at(-1);
      if(last?.role==='activity')last.items.push(tools.get(id));
      else rows.push({role:'activity',turn:j.turn,id,items:[tools.get(id)]})
    }
  }
  return rows
}
function renderOrderedTurn(container,rows){
  const existing=new Map([...container.children].map(node=>[node.dataset.key,node]));
  let previous=null;
  for(const row of rows){
    const key=row.role+'-'+(row.clientId||row.id);
    const node=existing.get(key)||element('div','turn-entry');existing.delete(key);node.dataset.key=key;
    const content=row.role==='assistant'?row.text:JSON.stringify(row);
    if(node.rendered!==content){
      if(row.role==='assistant'){
        node.className='turn-entry msg live-answer';node.dataset.turn=row.turn||'';node.wraps??=new Set();renderLiveAnswer(node,row.text,node.wraps)
      }else if(row.role==='activity'){
        const details=activity(row.items,null,row.turn||current().turn,node.firstElementChild||undefined);
        if(!details.parentNode)node.append(details)
      }else if(row.role==='steps'||row.role==='plan')node.replaceChildren(planCard(row));
      else node.replaceChildren(userBubble(row));
      node.rendered=content
    }
    const next=previous?previous.nextSibling:container.firstChild;
    if(next!==node)container.insertBefore(node,next);previous=node
  }
  for(const node of existing.values())node.remove()
}
let historyRender,liveRender;
function syncTurnDetails(root,chat,rows){
  const workByTurn=new Map(),groups=new Map();
  for(const [index,row] of rows.entries()){
    if(!row.turn||row.role==='user')continue;
    if(row.role==='assistant'&&!row.interrupted&&Number.isSafeInteger(row.turnDurationMs)){
      const work=workByTurn.get(row.turn);
      if(work?.length)groups.set(work[0],{turn:row.turn,time:row.turnDurationMs,indices:work,final:index});
      continue
    }
    if(['activity','steps','plan','assistant'].includes(row.role)){
      if(!workByTurn.has(row.turn))workByTurn.set(row.turn,[]);
      workByTurn.get(row.turn).push(index)
    }
  }
  // A row still occupies one history slot when its disclosure is mounted.
  for(let i=0;i<rows.length;i++){
    const slot=root.children[i];
    if(slot.classList.contains('turn-disclosure')&&!groups.has(i)){
      const content=slot.lastElementChild;content.hidden=false;content.removeAttribute('data-turn-hidden');slot.replaceWith(content)
    }else if(slot.hasAttribute('data-turn-hidden')){
      slot.hidden=false;slot.removeAttribute('data-turn-hidden')
    }
    const time=root.children[i].querySelector('.turn-time');if(time)time.hidden=false
  }
  for(const [index,group] of groups){
    let slot=root.children[index];
    if(!slot.classList.contains('turn-disclosure')){
      const wrap=element('div','turn-disclosure'),button=element('button','turn-toggle');
      button.type='button';button.append(element('span'),icon('chevron-right'));
      slot.replaceWith(wrap);wrap.append(button,slot);slot=wrap
    }
    const button=slot.firstElementChild,nodes=group.indices.map(i=>i===index?slot.lastElementChild:root.children[i]);
    const time=root.children[group.final].querySelector('.turn-time');if(time)time.hidden=true;
    button.firstChild.textContent=turnTimeLabel(group.time);
    for(const node of nodes)if(!node.id)node.id='turn-detail-'+crypto.randomUUID();
    button.setAttribute('aria-controls',nodes.map(node=>node.id).join(' '));
    function show(open){
      button.setAttribute('aria-expanded',String(open));
      for(const node of nodes){node.hidden=!open;node.toggleAttribute('data-turn-hidden',!open)}
    }
    const key=disclosureKey(chat,group.turn,null);
    button.onclick=()=>{const open=button.getAttribute('aria-expanded')!=='true';rememberDisclosure(key,open);show(open)};
    show(disclosureOpen(key))
  }
}
function turnTimeLabel(ms,stopped=false){
  if(!Number.isSafeInteger(ms)||ms<0)return stopped?'任务已停止':'';
  const total=Math.floor(ms/1000),h=Math.floor(total/3600),m=Math.floor(total/60)%60,s=total%60;
  const time=[h&&h+'小时',m&&m+'分钟',(s||!total)?s+'秒':''].filter(Boolean).join(' ');
  return (stopped?'你已停止，已用时 ':'用时 ')+time
}
function updateJumpButton(){
  const pane=$('scroller'),button=$('jump-latest');
  const show=!!pane.clientHeight&&pane.scrollHeight-pane.scrollTop-pane.clientHeight>112;
  if(button.inert===show){button.inert=!show;button.tabIndex=show?0:-1;button.setAttribute('aria-hidden',String(!show))}
  button.classList.toggle('working',!!(current()?.pending||current()?.activeTurn))
}
$('scroller').addEventListener('scroll',updateJumpButton,{passive:true});
new ResizeObserver(updateJumpButton).observe($('scroller'));
$('jump-latest').onclick=()=>{const pane=$('scroller');pane.scrollTop=pane.scrollHeight;updateJumpButton()};
function isAtLatestMessage(pane){return pane.scrollHeight-pane.scrollTop-pane.clientHeight<4}
function renderChatTitle(c){
  const title=c.messages.length||c.thread?c.title:'新聊天';
  $('header-thread').textContent=title;document.title=title+' · Codex'
}
function messages(jump=true){renderWorkbench();const c=current();if(readingReply&&!c.messages.includes(readingReply.message))stopReadingReply();const pane=$('scroller'),bottom=isAtLatestMessage(pane);const empty=!c.messages.length&&!c.thread;$('layout').classList.toggle('empty',empty);promptBox.placeholder=empty?'随心输入':'和 Codex 一起工作';const root=$('messages');
  syncThreadWatch();
  const ordered=c.pending&&orderedSnapshots.get(c);
  const orderedUsers=new Set(ordered?ordered.filter(m=>m.clientId).map(m=>m.clientId):[]);
  const ended=endedActivityTurns(c),endingKey=JSON.stringify([...ended]);
  const userKey=[...orderedUsers].join(',');
  const preview=!c.pending&&threadWatch?.thread===c.thread&&threadWatch?.preview;
  const previewText=preview?.text;
  if(historyRender?.chat!==c||historyRender.thread!==c.thread||historyRender.messages!==c.messages||historyRender.length!==c.messages.length||historyRender.pending!==c.pending||historyRender.activeTurn!==c.activeTurn||historyRender.error!==c.error||historyRender.userKey!==userKey||historyRender.endingKey!==endingKey||historyRender.previewText!==previewText||historyRender.previewId!==preview?.id){
    const rows=c.messages.filter(m=>m.role!=='user'||!orderedUsers.has(m.clientId));
    if(previewText){
      const index=rows.findIndex(m=>m.turn===preview.turn&&m.id===preview.id&&m.role==='assistant');
      if(index>=0){
        if(previewText.length>rows[index].text.length&&previewText.startsWith(rows[index].text))
          rows[index]={...rows[index],text:previewText}
      }else if(!rows.some(m=>m.turn===preview.turn&&m.role==='assistant'&&!m.id)&&
        (c.activeTurn===preview.turn||!rows.some(m=>m.turn===preview.turn))){
        rows.push({role:'assistant',turn:preview.turn,id:preview.id,text:previewText})
      }
    }
    let retained=0;
    if(historyRender?.chat===c&&historyRender.thread===c.thread){
      while(retained<rows.length&&rows[retained]===historyRender.rows[retained]){
        const row=rows[retained];
        if(row.items?.length&&ended.get(row.turn)!==historyRender.ended.get(row.turn))break;
        retained++
      }
    }
    const keepLive=c.pending&&historyRender?.chat===c&&historyRender.pending===c.pending&&liveRender;
    const boundary=keepLive?liveRender.tools:null;
    const finished=new Map();
    const horizontalOffsets=[];
    let selection,focused;
    if(!c.pending&&liveRender&&historyRender?.chat===c){
      for(const node of liveRender.tools.querySelectorAll('.turn-entry.live-answer')){
        finished.set(node.dataset.key,{node,text:node.rendered,wrapped:node.wraps})
      }
      if(!liveRender.article.hidden&&liveRender.text)finished.set(null,{node:liveRender.answer,text:liveRender.text,wrapped:liveRender.wrapped});
      for(const {node} of finished.values()){
        for(const block of node.querySelectorAll('table,pre')){
          if(block.scrollLeft)horizontalOffsets.push([block,block.scrollLeft])
        }
      }
      const currentSelection=window.getSelection();
      if(currentSelection&&!currentSelection.isCollapsed&&[...finished.values()].some(({node})=>node.contains(currentSelection.anchorNode)&&node.contains(currentSelection.focusNode))){
        selection=[currentSelection.anchorNode,currentSelection.anchorOffset,currentSelection.focusNode,currentSelection.focusOffset]
      }
      focused=document.activeElement
    }
    while(root.children[retained]&&root.children[retained]!==boundary)root.children[retained].remove();
    if(!keepLive)liveRender=null;
    root.toggleAttribute('data-pending',!!c.pending);
    historyRender={userKey,endingKey,ended,rows,previewText,previewId:preview?.id,chat:c,thread:c.thread,messages:c.messages,length:c.messages.length,pending:c.pending,activeTurn:c.activeTurn,error:c.error};
    const added=document.createDocumentFragment();
    const finalReply=finished.has(null)?rows.findLast(row=>row.role==='assistant'):null;
    for(const m of rows.slice(retained)){if(m.role==='user'){added.append(userBubble(m));continue}
      if(m.role==='activity'){added.append(activity(m.items,ended.get(m.turn),m.turn));continue}
      if(m.role==='steps'||m.role==='plan'){added.append(planCard(m));continue}
      if(m.role==='status'){added.append(element('p','quiet',m.status==='interrupted'?turnTimeLabel(m.turnDurationMs,true):m.text||'任务执行失败'));continue}
      const outer=element('article','msg'),key=m.id?'assistant-'+m.id:null,last=(key||m===finalReply)?finished.get(key):null;
      const reuse=last&&m.text?.startsWith(last.text),body=reuse?last.node:element('div','answer');
      if(m.items?.length)outer.append(activity(m.items,ended.get(m.turn),m.turn));
      if(reuse){
        if(last.text!==m.text)renderLiveAnswer(body,m.text,last.wrapped);
        body.className='answer';delete body.dataset.key;liveMarkdown.delete(body);finished.delete(key);messageWrap.set(m,last.wrapped)
      }
      else{if(!messageWrap.has(m))messageWrap.set(m,new Set());renderAnswer(body,m.text,messageWrap.get(m))}
      body.dataset.turn=m.turn||'';
      const time=turnTimeLabel(m.turnDurationMs);
      if(time&&!m.interrupted)outer.append(element('p','turn-time',time));
      outer.append(body);if(m.interrupted)outer.append(element('p','quiet',turnTimeLabel(m.turnDurationMs,true)));const actions=element('div','actions');actions.append(copyButton('复制回复',()=>m.text));if(m.text)actions.append(readReplyButton(m,body));
      if(c.thread&&m.turn)actions.append(btn('从此轮回复创建分支','square-pen',()=>forkChat(c,m.turn),'icon reply-fork'));
      outer.append(actions);added.append(outer)}
    if(c.activeTurn&&!c.pending){
      const status=element('p','quiet');status.id='external-turn-status';status.setAttribute('role','status');added.append(status)
    }
    if(c.error){
      added.append(element('p','quiet',c.error));
      if(c.receiptUnknown&&c.thread)added.append(row('核对主机记录','message-circle',()=>checkHostReceipt(c)))
    }
    root.insertBefore(added,boundary)
    syncTurnDetails(root,c,rows);
    for(const [block,left] of horizontalOffsets)if(block.isConnected)block.scrollLeft=left;
    if(focused&&focused!==document.body&&focused.isConnected&&document.activeElement===document.body)focused.focus({preventScroll:true});
    if(selection&&selection[0].isConnected&&selection[2].isConnected)window.getSelection().setBaseAndExtent(...selection)
  }
  const externalStatus=$('external-turn-status');
  if(externalStatus){
    const text=c.externalWait?c.externalWait+'，可在发起任务的窗口处理，或在此停止任务。':'正在跟随主机上的任务…';
    if(externalStatus.textContent!==text)externalStatus.textContent=text
  }
  if(c.pending){
    if(!liveRender){
      const tools=element('div'),article=element('article','msg'),answer=element('div','live-answer');
      const waiting=element('p','waiting'),note=element('span','note');
      article.append(answer);waiting.append(element('span','dot'),note);root.append(tools,article,waiting);
      liveRender={tools,article,answer,note,wrapped:new Set()}
    }
    const live=liveRender,items=JSON.stringify(c.items||[]);
    if(ordered){
      live.article.hidden=true;renderOrderedTurn(live.tools,ordered)
    }else{
    if(live.items!==items){
      if(c.items?.length){
        const details=activity(c.items,null,c.turn,live.tools.querySelector(':scope>details')||undefined);
        if(!details.parentNode)live.tools.replaceChildren(details)
      }else live.tools.replaceChildren();
      live.items=items
    }
    live.article.hidden=!c.preview;
    live.answer.dataset.turn=c.turn||'';
    if(live.text!==c.preview){renderLiveAnswer(live.answer,c.preview,live.wrapped);live.text=c.preview}
    }
    live.note.textContent=c.phase||'正在思考…'
  }
  $('notice').textContent=!c.messages.length&&c.error?c.error:'';if(jump||bottom)pane.scrollTop=pane.scrollHeight;updateJumpButton();updateSendControls();renderChatTitle(c)
}
const browserHistory=window.history;
function deviceHistoryEntry(state){
  const entry=state?.codexChat;
  return (entry?.deviceScope||'')===deviceScope?entry:null
}
let navEnd=Number(pageStorage.getItem('codex-nav-end'))||0;
const readingPositionKey=id=>'codex-reading-position:'+id;
function firstVisibleMessage(pane){
  const top=pane.getBoundingClientRect().top;
  const rows=$('messages').children;
  const index=Array.prototype.findIndex.call(rows,row=>row.getBoundingClientRect().bottom>top);
  return {index,inset:index<0?0:rows[index].getBoundingClientRect().top-top}
}
function rememberReadingPosition(){
  const chat=historyRender?.chat,pane=$('scroller');
  if(!chat||!pane.clientHeight)return;
  const key=readingPositionKey(chat.id);
  if(isAtLatestMessage(pane)){
    pageStorage.removeItem(key);return
  }
  pageStorage.setItem(key,JSON.stringify({offset:pane.scrollTop,...firstVisibleMessage(pane)}))
}
window.addEventListener('pagehide',rememberReadingPosition);
let readingRestore;
function restoreReadingPosition(chat,pane){
  readingRestore?.abort();
  const saved=JSON.parse(pageStorage.getItem(readingPositionKey(chat.id)));
  const root=$('messages'),row=root.children[saved?.index];
  const restore=()=>{
    if(row?.parentElement===root)pane.scrollTop+=row.getBoundingClientRect().top-pane.getBoundingClientRect().top-saved.inset;
    else pane.scrollTop=saved?.offset??saved??pane.scrollHeight
  };
  restore();
  const pending=Array.from(root.querySelectorAll('img')).filter(img=>!img.complete);
  if(!pending.length)return;
  const controller=new AbortController();readingRestore=controller;
  const cancel=()=>controller.abort();
  for(const type of ['pointerdown','wheel','touchstart'])pane.addEventListener(type,cancel,{passive:true,signal:controller.signal});
  document.addEventListener('keydown',cancel,{signal:controller.signal});
  Promise.allSettled(pending.map(img=>img.decode())).then(()=>{
    if(!controller.signal.aborted&&current()===chat&&(!row||row.parentElement===root))restore();
    cancel()
  })
}
const draftSelections=new WeakMap();
function rememberDraftCursor(){
  const c=current(),input=$('prompt');
  try{
    if(!input.value||historyRender?.chat!==c||input.value!==c.draft){
      return
    }
    const position={start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection,scrollTop:input.scrollTop};
    if(window.ReceiverDrafts?.writeCursor){
      window.ReceiverDrafts.writeCursor(nativeDraftId(c.id),input.value,JSON.stringify(position));return
    }
    pageStorage.setItem(resumeCursorKey+':'+c.id,JSON.stringify({id:c.id,text:input.value,...position}))
  }catch{/* Draft text is saved independently when edited. */}
}
window.addEventListener('pagehide',rememberDraftCursor);
document.addEventListener('visibilitychange',()=>{if(document.hidden)rememberDraftCursor()});
function select(c,restore=false){
  const previous=current(),pane=$('scroller'),entry=deviceHistoryEntry(browserHistory.state);
  const input=$('prompt');
  const firstRender=!historyRender;
  if(previous!==c&&historyRender?.chat===previous&&previous){
    rememberDraftCursor();
    draftSelections.set(previous,{start:input.selectionStart,end:input.selectionEnd,
      direction:input.selectionDirection,scrollTop:input.scrollTop})
  }
  if($('plugin-page').hidden)rememberReadingPosition();
  else showPluginDestination(false);
  let index=entry?.index||0;
  if(!entry){
    navEnd=index=0;browserHistory.replaceState({codexChat:{id:c.id,index,deviceScope}},'')
  }else if(!restore&&(entry.id!==c.id||entry.destination)){
    navEnd=++index;browserHistory.pushState({codexChat:{id:c.id,index,deviceScope}},'')
  }
  pageStorage.setItem('codex-nav-end',String(navEnd));
  $('chat-back').disabled=index<=0;$('chat-forward').disabled=index>=navEnd;
  document.dispatchEvent(new CustomEvent('chat-selected',{detail:c.id}));selectionRevision++;db.active=c.id;
  const catalog=projectCatalog(c.cwd||'');
  if(catalog)db.modelCatalog=catalog;
  save();$('layout').classList.remove('drawer');closeDialog();renderSidebarHistory();showHistoryLoad(c);composer();messages();
  if(previous!==c||firstRender){
    let cursor=draftSelections.get(c);
    if(!cursor){
      if(window.ReceiverDrafts?.readCursor)cursor=readStoredObject(window.ReceiverDrafts.readCursor(nativeDraftId(c.id)));
      else{
        const saved=readStoredObject(pageStorage.getItem(resumeCursorKey+':'+c.id))||
          (firstRender&&restore&&readStoredObject(pageStorage.getItem(resumeCursorKey)));
        if(saved?.id===c.id&&saved.text===input.value)cursor=saved
      }
    }
    input.setSelectionRange(cursor?.start??input.value.length,cursor?.end??input.value.length,cursor?.direction||'none');
    if(cursor)input.scrollTop=cursor.scrollTop
  }
  restoreReadingPosition(c,pane);
  if(c.activeTurn&&!c.pending)void followExternalTurn(c,selectionRevision)
}
$('chat-back').onclick=()=>browserHistory.back();
$('chat-forward').onclick=()=>browserHistory.forward();
window.addEventListener('popstate',event=>{
  const c=db.chats.find(chat=>chat.id===deviceHistoryEntry(event.state)?.id);
  if(c){void openCachedChat(c,true);restoreDestination(event.state.codexChat.destination)}
});
function start(path=current()?.cwd||null,projectId=current()?.projectId||null){
  let chat=current();
  const reuse=chat&&(chat.cwd||null)===path&&(chat.projectId||null)===projectId&&
    !chat.thread&&!chat.pending&&!chat.messages.length&&!chat.draft&&!chat.files.length&&!readingFiles.has(chat);
  if(!reuse){
    chat=newChat();chat.cwd=path;chat.projectId=projectId;db.chats.push(chat)
  }
  select(chat);$('prompt').focus()
}
function followsProjectDefault(c){
  const defaults=db.projectModelDefaults?.[c.cwd||'']?.defaults;
  const choice=c.pickerChoice;
  return choice?.mode==='default'&&!c.speedChoice&&c.model===choice.model&&
     (c.effort||null)===(Object.hasOwn(choice,'effort')?choice.effort:defaults?.effort||null);
}
function chooseProject(path,projectId){
  const c=current();
  if(c.thread||c.pending||c.messages.length){start(path,projectId);return}
  if(c.cwd!==path&&followsProjectDefault(c)){
    delete c.pickerChoice;delete c.model;delete c.modelName;delete c.effort;
    c.selectedForNext=false
  }
  c.cwd=path;c.projectId=projectId;select(c);$('prompt').focus()
}
let menuAnchor=null;
function closeDialog(){
  const dialog=$('dialog');
  for(const animation of dialog.getAnimations())if(animation.id==='model-view-size')animation.cancel();
  menuAnchor?.setAttribute('aria-expanded','false');
  menuAnchor=null;
  $('model-picker').setAttribute('aria-expanded','false');
  if(dialog.open)dialog.close();
  $('attach-menu').setAttribute('aria-expanded','false')
}
function modal(title,anchor=null){
  closeDialog();
  const dialog=$('dialog');
  dialog.classList.remove('chat-search','model-menu','model-command-menu','context-menu','header-menu','image-viewer','composer-menu','inline-menu','sidebar-menu-above','rename-dialog');
  $('dialog-title').textContent=title;
  const body=$('dialog-body');body.onkeydown=null;body.replaceChildren();
  if(anchor?.getClientRects().length){
    menuAnchor=anchor;anchor.setAttribute('aria-expanded','true');
    dialog.classList.add('inline-menu');dialog.show();
    const r=anchor.getBoundingClientRect();
    dialog.style.setProperty('--composer-left',Math.max(8,Math.min(r.left,innerWidth-328))+'px');
    dialog.style.setProperty('--composer-bottom',Math.max(8,innerHeight-r.top+5)+'px')
  }else dialog.showModal();
  return body
}
document.addEventListener('click',event=>{
  if(!menuAnchor||$('dialog').contains(event.target))return;
  const toggle=menuAnchor.contains(event.target);
  closeDialog();
  if(toggle){event.preventDefault();event.stopPropagation()}
},true);
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||event.defaultPrevented||!menuAnchor)return;
  const anchor=menuAnchor;event.preventDefault();closeDialog();anchor.focus({preventScroll:true})
});

function search(){
  const body=modal('搜索聊天'),field=element('input','field'),results=element('div','results'),status=element('p','quiet');
  $('dialog').classList.add('chat-search');
  field.placeholder='搜索聊天';field.maxLength=180;field.setAttribute('aria-label','搜索词');status.setAttribute('role','status');
  body.append(field,status,results);
  let version=0,timer,inFlight=0,pending;
  function active(v){return version===v&&body.contains(field)&&$('dialog').open}
  async function run(search,cursor,focusNext=false){
    if(!active(search.version))return;
    // Let a new query start while one slow host search is finishing.
    if(inFlight>=2){pending={search,cursor,focusNext};return}
    inFlight++;
    try{
      const page=await threadApi({term:search.term,cursor});
      if(!active(search.version))return;
      const previous=results.children.length;
      for(const item of page.items)search.add(item);
      status.textContent=results.children.length?'':'没有找到匹配的聊天';
      if(page.cursor){
        const more=row('加载更多','chevron-down',()=>{more.remove();field.focus();run(search,page.cursor,true)});results.append(more)
      }
      if(focusNext&&document.activeElement===field)results.children[previous]?.focus();
    }catch{
      if(active(search.version)){
        status.textContent='主机搜索失败，已保存的结果仍可打开。';
        const retry=row('重试','server',()=>{retry.remove();field.focus();run(search,cursor,true)});results.append(retry)
      }
    }finally{
      inFlight--;
      if(pending){const next=pending;pending=null;void run(next.search,next.cursor,next.focusNext)}
    }
  }
  function filter(){
    clearTimeout(timer);pending=null;version++;
    const term=field.value.trim(),lower=term.toLowerCase(),seen=new Set();
    results.replaceChildren();
    for(const c of [...db.chats].sort((a,b)=>b.updated-a.updated)){
      if(c.archived||!c.messages.length||!(c.title.toLowerCase().includes(lower)||c.messages.some(m=>m.text?.toLowerCase().includes(lower))))continue;
      if(c.thread)seen.add(c.thread);
      results.append(row(c.title,'message-circle',()=>openCachedChat(c)))
    }
    function add(item){
      if(seen.has(item.thread))return;seen.add(item.thread);
      results.append(row(item.title,'message-circle',()=>loadRemoteChat(item)))
    }
    for(const item of db.hostIndex||[])if(item.title.toLowerCase().includes(lower))add(item);
    status.textContent=term?'正在搜索主机会话…':results.children.length?'':'输入关键词搜索主机会话';
    const query={term,version,add};
    if(term)timer=setTimeout(()=>run(query,null),450)
  }
  field.addEventListener('compositionstart',()=>{clearTimeout(timer);pending=null;version++});
  field.oninput=e=>{if(!isCompositionKey(e))filter()};
  field.addEventListener('compositionend',filter);
  body.onkeydown=e=>{
    if(isCompositionKey(e)||e.shiftKey||e.ctrlKey||e.metaKey||e.altKey)return;
    if(e.target===field){
      if(e.key==='Enter'){e.preventDefault();if(!e.repeat)results.firstElementChild?.click();return}
      if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;
      e.preventDefault();(e.key==='ArrowDown'?results.firstElementChild:results.lastElementChild)?.focus();
      return
    }
    if(e.target.parentElement!==results)return;
    let next;
    if(e.key==='ArrowDown')next=e.target.nextElementSibling||field;
    else if(e.key==='ArrowUp')next=e.target.previousElementSibling||field;
    else if(e.key==='Home')next=results.firstElementChild;
    else if(e.key==='End')next=results.lastElementChild;
    if(next){e.preventDefault();next.focus()}
  };
  filter();field.focus()
}
const submitModifier=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘':'Ctrl';
const enterChoices={
  enter:'按 Enter 键',
  cmdIfMultiline:'按 '+submitModifier+' + Enter 发送多行提示词',
  cmdAlways:'始终按 '+submitModifier+' + Enter'
};
function sendsWithEnter(value){
  if($('prompt').hasAttribute('data-android-ime'))return false;
  const mode=db.composerEnterBehavior||'enter';
  return mode==='enter'||(mode==='cmdIfMultiline'&&!value.includes('\n'))
}
function updateEnterHint(){
  const prompt=$('prompt');prompt.enterKeyHint=sendsWithEnter(prompt.value)?'send':'enter'
}
function settings(restore=false){
  const body=openSidePage('settings','设置',restore===true);
  if(!body)return;
  if(mobile.matches)body.append(row('定时任务','scheduled',()=>scheduledView()),row('账号用量','usage-ring',accountUsage),row('插件','plugins',()=>pluginsView()));
  const label=element('label','preference-label','发送快捷键'),select=element('select','field');
  select.id='composer-enter-behavior';label.htmlFor=select.id;
  for(const [value,text] of Object.entries(enterChoices)){
    const option=element('option','',text);option.value=value;select.append(option)
  }
  select.value=db.composerEnterBehavior||'enter';
  select.onchange=()=>{db.composerEnterBehavior=select.value;save();updateEnterHint()};
  if($('prompt').hasAttribute('data-android-ime')){
    body.append(element('div','preference-label','发送快捷键'),element('p','quiet','回车换行。点发送按钮，或用外接键盘按 Ctrl + Enter 发送。'))
  }else body.append(label,select);
  body.append(element('div','preference-label','外观'));
  const themes=element('div','settings-themes');
  body.append(themes);
  function updateThemeSelection(){
    for(const choice of themes.children){
      const selected=choice.dataset.theme===db.theme;
      choice.setAttribute('aria-pressed',String(selected));
      choice.querySelector('small').textContent=selected?'已选择':''
    }
  }
  for(const [value,text,iconName] of [['system','跟随系统','monitor'],['light','浅色','sun'],['dark','深色','moon']]){
    const choice=row(text,iconName,()=>{db.theme=value;theme();save();updateThemeSelection()});
    choice.dataset.theme=value;
    choice.append(element('small'));
    themes.append(choice)
  }
  updateThemeSelection();
  const heading=body.querySelector('h1');heading.tabIndex=-1;heading.focus({preventScroll:true})

}
function exportMessage(m){
  if(m.role==='steps')return [m.explanation,...m.steps.map(s=>'- ['+(s.status==='completed'?'x':' ')+'] '+s.step)].filter(Boolean).join('\n');
  if(m.role==='status')return m.status==='interrupted'?'任务已停止':m.text||'任务执行失败';
  const sections=[];
  if(m.items?.length){
    sections.push('## 执行记录');
    for(const item of m.items){
      sections.push([recordTitle(item),item.status,Number.isInteger(item.exitCode)?'退出码 '+item.exitCode:''].filter(Boolean).join(' · '));
      if(item.output)sections.push(item.output.split('\n').map(line=>'    '+line).join('\n'))
    }
  }
  if(m.text)sections.push('## '+(m.role==='user'?'你':'Codex'),m.text);
  if(m.interrupted)sections.push('任务已停止');
  return sections.join('\n\n')
}
async function archiveApi(payload){
  const res=await deviceFetch('/api/archives',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await res.json();if(!res.ok)throw Error(data.error);return data
}
const archiveChanges=new Map();
$('restore-current').onclick=()=>{const c=current();if(c.archived&&c.thread)void setArchived(c.thread,false,$('restore-current'))};
async function setArchived(thread,archived,button){
  button.disabled=true;
  try{
    const reply=await archiveApi({ids:[thread],archived});
    if(reply.ids.includes(thread)!==archived)throw Error('主机尚未确认归档状态');
    const chat=db.chats.find(c=>c.thread===thread);
    archiveChanges.set(thread,(archiveChanges.get(thread)||0)+1);
    if(chat){chat.archived=archived;if(chat===current())archiveComposer(chat)}
    if(archived){
      db.hostIndex=(db.hostIndex||[]).filter(item=>item.thread!==thread);
      db.pinnedThreads=(db.pinnedThreads||[]).filter(item=>item.thread!==thread)
    }
    save();if(button.isConnected)closeDialog();
    if(archived&&current()===chat)start();else renderSidebarHistory();
    await refreshSidebar()
  }catch(e){toast(e.message)}finally{button.disabled=false}
}
function archives(){
  const body=modal('已归档聊天'),status=element('p','quiet'),panel=element('div','results');body.append(status,panel);
  async function load(cursor){
    status.textContent='正在读取主机归档…';
    try{
      const page=await archiveApi(cursor?{cursor}:{});if(!body.contains(status))return;
      for(const item of page.items){
        const entry=element('div','archived-entry');entry.dataset.thread=item.thread;
        const preview=row(item.title,'message-circle',()=>loadRemoteChat({...item,archived:true}));
        const restore=element('button','archive-restore','取消归档');restore.type='button';
        restore.onclick=()=>setArchived(item.thread,false,restore);entry.append(preview,restore);panel.append(entry)
      }
      status.textContent=panel.children.length?'查看或恢复你已归档的聊天':'暂无已归档的聊天';
      if(page.cursor){const more=row('加载更多','chevron-down',()=>{more.remove();load(page.cursor)});panel.append(more)}
    }catch(e){status.textContent=e.message;panel.append(row('重试','server',()=>archives()))}
  }
  void load(null)
}
function attachmentMenu(){
  const anchor=$('attach-menu'),rect=anchor.getBoundingClientRect(),body=modal('添加文件等内容',anchor),dialog=$('dialog');
  anchor.setAttribute('aria-expanded','true');dialog.classList.add('context-menu');
  dialog.style.setProperty('--attach-left',Math.max(8,Math.min(rect.left,innerWidth-232))+'px');
  dialog.style.setProperty('--attach-bottom',Math.max(8,innerHeight-rect.top+5)+'px');
  const menu=element('div');menu.setAttribute('role','menu');body.append(menu);
  function item(label,name,run){
    const button=row(label,name,run);button.setAttribute('role','menuitem');menu.append(button)
  }
  item('添加本地文件','file-text',()=>{closeDialog();$('file').click()});
  item('添加远程文件','folder-open',remoteFilePicker);
  if(!current().activeTurn&&!current().pending&&(!nativePermissionMode||current().collaborationMode==='plan'))item(current().collaborationMode==='plan'?'退出计划模式':'启用计划模式','sliders-horizontal',togglePlanMode);
  menu.firstElementChild.focus();
  menu.onkeydown=e=>{
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
    e.preventDefault();const buttons=[...menu.children],i=buttons.indexOf(document.activeElement);
    const n=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
    buttons[n].focus()
  }
}
$('dialog').addEventListener('close',()=>{if(!$('dialog').open){$('attach-menu').setAttribute('aria-expanded','false');$('model-picker').setAttribute('aria-expanded','false')}});
$('dialog').addEventListener('cancel',()=>{
  $('attach-menu').setAttribute('aria-expanded','false');$('model-picker').setAttribute('aria-expanded','false')
});
function isWindowsRoot(path){return /^(?:[a-z]:|\\\\)/i.test(path)}
function projectRootFor(cwd,roots){
  if(!cwd)return;
  return [...roots].filter(path=>{
    const normalize=value=>(isWindowsRoot(path)?value.replaceAll('\\','/').toLowerCase():value).replace(/\/+$/,'');
    const base=normalize(path),currentPath=normalize(cwd);
    return currentPath===base||currentPath.startsWith(base+'/')
  }).sort((a,b)=>b.length-a.length)[0]
}
function projectEntryPath(root,relative){
  return isWindowsRoot(root)?root.replace(/[\\/]+$/,'')+'\\'+relative.replaceAll('/','\\'):root.replace(/\/+$/,'')+'/'+relative
}
async function projectDirectory(root,relative,thread){
  const response=await deviceFetch('/api/project-directories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,relative,thread})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'未能读取目录');
  return data
}
async function searchProjectFiles(root,query){
  const res=await deviceFetch('/api/project-files',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({root,query})});
  const data=await res.json();if(!res.ok)throw Error(res.status===404?'请使用新版客户端搜索主机项目':data.error);
  return data.files
}
async function remoteFilePicker(){
  const c=current(),body=modal('添加远程文件'),root=element('select','field'),form=element('form','file-search'),
    field=element('input','field'),search=element('button','','搜索'),status=element('p','quiet'),results=element('div','results');
  root.setAttribute('aria-label','主机项目目录');field.placeholder='按文件名搜索';field.setAttribute('aria-label','文件名');
  search.type='submit';form.append(field,search);body.append(root,form,status,results);status.setAttribute('role','status');
  let native=false;
  function attach(path,entry){
    const remotePath=projectEntryPath(path,entry.path);
    if(!c.files.some(f=>f.remotePath===remotePath)){
      const files=c.files.concat({name:entry.path,remotePath,directory:entry.directory});
      if(new TextEncoder().encode(promptWithFiles(c.draft,files)).length>16000){toast('正文与附件合计最多 16 KB');return}
      c.files=files;save()
    }
    closeDialog();composer();$('prompt').focus()
  }
  function visible(){return current()===c&&body.contains(form)&&$('dialog').open}
  let version=0;
  function reset(){version++;results.replaceChildren();status.textContent=''}
  root.onchange=field.oninput=reset;
  form.onsubmit=async e=>{
    e.preventDefault();reset();if(!field.value.trim()||!root.value)return;
    if(native){
      const path=field.value.trim().replaceAll('\\','/');
      if(path.split('/').some(part=>!part||part==='.'||part==='..'||/[:\x00-\x1f]/.test(part))){
        status.textContent='请输入项目内的相对路径，例如 src/main.js';return
      }
      attach(root.value,{path,directory:false});return
    }
    const generation=version,path=root.value;status.textContent=('正在搜索 '+receiverName+'…');
    try{
      const files=await searchProjectFiles(path,field.value.trim());if(!visible()||generation!==version)return;
      status.textContent=files.length?'':'未找到匹配的文件或目录';
      for(const entry of files)results.append(row(entry.path,entry.directory?'folder-open':'file-text',()=>attach(path,entry)))
    }catch(err){if(visible()&&generation===version)status.textContent=err.message}
  };
  async function browse(relative){
    reset();const generation=version,path=root.value;
    if(!path)return;
    field.value=relative?relative+'/':'';
    status.textContent='正在读取目录…';
    try{
      const data=await projectDirectory(path,relative,c.cwd===path?c.thread:null);
      if(!visible()||generation!==version)return;
      if(relative){
        results.append(row('上一级','folder-open',()=>browse(relative.split('/').slice(0,-1).join('/'))));
        results.append(row('添加当前目录','plus',()=>attach(path,{path:relative,directory:true})))
      }
      for(const name of data.folders)results.append(row(name,'folder-open',()=>browse(relative?relative+'/'+name:name)));
      for(const name of data.files||[])results.append(row(name,'file-text',()=>attach(path,{path:relative?relative+'/'+name:name,directory:false})));
      status.textContent=data.truncated?'主机仅返回部分条目':data.files?(data.files.length||data.folders.length?'':'目录为空'):'当前项目仅能浏览子目录'
    }catch(error){if(visible()&&generation===version)status.textContent=error.message}
  }
  function showRoots(projects){
    const paths=new Set();
    for(const project of projects)for(const path of project.roots){
      if(paths.has(path))continue;paths.add(path);
      const option=element('option','',project.name+' · '+path);option.value=path;root.append(option)
    }
    const matched=projectRootFor(c.cwd,paths);
    if(matched)root.value=matched;
    if(!paths.size)status.textContent='主机没有已登记的项目目录';field.focus()
  }
  search.disabled=true;
  try{native=await nativePermissions()}catch(error){if(visible())status.textContent=error.message;return}
  if(!visible())return;
  search.disabled=false;
  if(native){
    field.placeholder='例如 src/main.js';field.setAttribute('aria-label','项目内的相对路径');
    search.textContent='添加路径';
    form.after(row('浏览项目目录','folder-open',()=>browse('')),
      element('p','quiet','可选择主机返回的文件或目录，也可直接输入相对路径。'));
    root.onchange=()=>{reset();field.value=''}
  }
  if(db.hostProjects?.length)showRoots(db.hostProjects);
  else try{const page=await directoryPage(null);if(visible())showRoots(page.projects||[])}catch(err){if(visible())status.textContent=err.message}
}
async function togglePlanMode(){
  const c=current();if(c.archived||c.pending||c.activeTurn)return;
  try{
    if(c.collaborationMode!=='plan'){
      const res=await deviceFetch('/api/capabilities');
      if(!res.ok)throw Error('无法读取当前主机支持的聊天模式');
      if(!(await res.json()).planMode)throw Error('当前主机连接不支持计划模式');
    }
    if(c!==current()||c.pending||c.activeTurn||c.archived)return;
    c.collaborationMode=c.collaborationMode==='plan'?'default':'plan';save();closeDialog();composer();$('prompt').focus()
  }catch(e){toast(e.message)}
}
function positionSidebarMenu(anchor){
  const dialog=$('dialog'),r=anchor.getBoundingClientRect();
  dialog.classList.add('header-menu');
  dialog.style.setProperty('--menu-left',Math.max(8,Math.min(r.left,innerWidth-232))+'px');
  const below=innerHeight-r.bottom-8;
  if(below>=240||below>=r.top){
    dialog.style.setProperty('--menu-top',r.bottom+4+'px')
  }else{
    dialog.style.setProperty('--menu-top','auto');
    dialog.classList.add('sidebar-menu-above');
    dialog.style.setProperty('--sidebar-menu-bottom',innerHeight-r.top+4+'px')
  }
}
function options(c,anchor=null){const body=modal('聊天选项',anchor);if(anchor?.closest('.history-row'))positionSidebarMenu(anchor);body.append(row('新聊天','square-pen',()=>start()),row('选择远程项目','folder-open',()=>remotePicker(true)),row('已归档聊天','message-circle',archives),row('设置','sliders-horizontal',settings));if(c===current()&&!c.archived&&!c.pending&&!c.activeTurn&&(!nativePermissionMode||c.collaborationMode==='plan'))body.append(row(c.collaborationMode==='plan'?'退出计划模式':'启用计划模式','sliders-horizontal',togglePlanMode));if(c===current()&&c.messages?.length)body.append(row('在当前聊天中查找','search',()=>{closeDialog();openThreadFind()}));if(anchor?.closest('.history-row'))body.querySelector('button')?.focus();if(c.archived||(!c.thread&&!c.messages?.length))return;
  if(c.thread&&!c.pending&&!c.activeTurn&&!c.archived){const button=row('归档聊天','folder-open',()=>setArchived(c.thread,true,button));body.append(button)}
  if(c.thread&&Array.isArray(db.pinnedThreads)){
    const pinned=db.pinnedThreads.some(item=>item.thread===c.thread);
    const label=pinned?'取消置顶':c.sectionId?'从当前分组移至置顶':'置顶聊天';
    const control=row(label,'message-circle',async()=>{
      control.disabled=true;
      try{
        const expected=pinned?'01984de2-8f74-7c91-a3b2-5c5e937cf318':c.sectionId||null;
        const res=await deviceFetch('/api/thread-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:c.thread,pinned:!pinned,expected})});
        const data=await res.json();if(!res.ok)throw Error(data.error);
        db.pinnedThreads=data.pinned;c.sectionId=data.sectionId;save();renderSidebarHistory();if(body.contains(control))closeDialog()
      }catch(e){toast(e.message);control.disabled=false}
    });body.append(control)
  }
  if(c.thread&&!c.pending&&c.readState?.revision){
    const state=c.readState,operation=state.firstUnread?'read':'unread';
    const mark=row(operation==='read'?'标为已读':'标为未读','message-circle',async()=>{
      mark.disabled=true;
      try{
        const res=await deviceFetch('/api/read-state',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({thread:c.thread,revision:state.revision,operation})});
        const result=await res.json();
        if(!res.ok&&res.status!==409)throw Error(result.error||'主机未确认已读状态');
        if(!result.readState?.revision)throw Error('主机未返回已读位置');
        c.readState=result.readState;
        for(const items of [db.hostIndex,db.pinnedThreads]){
          const copy=items?.find(item=>item.thread===c.thread);
          if(copy)copy.readState=result.readState
        }
        save();renderSidebarHistory();
        if(!$('activity-view').hidden)void refreshActivity();
        if(body.contains(mark))closeDialog();
        toast(res.status===409?'主机状态已变化，请重新选择。':operation==='read'?'已标为已读':'已标为未读')
      }catch(e){mark.disabled=false;toast(e.message)}
    });body.append(mark)
  }
  if(c.thread&&!c.pending&&c.messages?.length)body.append(row('从此对话创建分支','square-pen',()=>forkChat(c)));
  body.append(row('重命名','pencil',()=>renameChat(c)));
  if(c.messages?.length)body.append(row('导出 Markdown','download',()=>downloadTranscript(c)))
}
function downloadTranscript(c){
  const content=c.messages.map(exportMessage).join('\n\n');
  const url=URL.createObjectURL(new Blob([content],{type:'text/markdown;charset=utf-8'}));const a=element('a');a.download=c.title.replace(/[\\/:*?"<>|]/g,'_')+'.md';a.href=url;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);closeDialog()
}
function anchorHeaderMenu(button){
  const dialog=$('dialog'),rect=button.getBoundingClientRect();
  dialog.classList.add('header-menu');
  dialog.style.setProperty('--menu-left',Math.max(8,Math.min(rect.right-224,innerWidth-232))+'px');
  dialog.style.setProperty('--menu-top',rect.bottom+5+'px');
  const body=$('dialog-body');
  body.onkeydown??=event=>{
    const buttons=Array.from(body.querySelectorAll('button:not(:disabled)'));
    const index=buttons.indexOf(document.activeElement);
    if(!buttons.length)return;
    const next={Home:0,End:buttons.length-1,ArrowDown:(index+1)%buttons.length,ArrowUp:(index-1+buttons.length)%buttons.length}[event.key];
    if(next!==undefined){event.preventDefault();buttons[next].focus()}
  };
  body.querySelector('.modal-row:not(:disabled)')?.focus()
}
$('header-share').onclick=()=>{
  const c=current(),body=modal('分享对话',$('header-share'));
  const copy=row('复制 Markdown','copy',async()=>{
    try{await copyText(c.messages.map(exportMessage).join('\n\n'));if(body.contains(copy))closeDialog();toast('已复制对话')}
    catch{toast('浏览器未允许复制')}
  });body.append(copy,row('导出 Markdown','download',()=>downloadTranscript(c)));
  anchorHeaderMenu($('header-share'))
};
async function forkChat(c,lastTurn){
  const body=modal('创建对话分支'),status=element('p','quiet','正在等待主机创建分支…');body.append(status);
  const key=lastTurn||'end';c.forkRequests??={};
  const request=c.forkRequests[key]??=(lastTurn?null:c.forkRequest)||crypto.randomUUID();save();
  try{
    const res=await deviceFetch('/api/thread-fork',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:c.thread,request,lastTurn})});
    const result=await res.json();if(!res.ok)throw Error(result.error);
    if(!lastTurn)delete c.forkRequest;delete c.forkRequests[key];save();
    if(body.contains(status)&&$('dialog').open)await loadRemoteChat({thread:result.thread,title:c.title+' · 分支',updated:Date.now()/1000})
  }catch(e){if(body.contains(status)){status.textContent=e.message;body.append(row('核对分支结果','server',()=>forkChat(c,lastTurn)))}}
}
const quotaButton=document.querySelector('#app-rail [data-action="account-usage"]');
let quotaRequest,quotaCheckedAt=0,quotaHostReady=false;
function renderQuotaRing(groups){
  const windows=groups.find(group=>group.name.toLowerCase()==='codex')?.windows||[];
  const weekly=windows.find(w=>w.windowDurationMins===10080);
  const short=windows.find(w=>w.windowDurationMins===300);
  const ring=document.createElementNS('http://www.w3.org/2000/svg','svg');
  ring.setAttribute('viewBox','2.5 2.5 27 27');ring.setAttribute('aria-hidden','true');
  function path(d,cls){
    const p=document.createElementNS(ring.namespaceURI,'path');
    p.setAttribute('d',d);p.setAttribute('class',cls);ring.append(p);return p
  }
  const labels=[];
  function segment(d,win,label){
    path(d,'quota-track');
    if(!win||!Number.isFinite(win.usedPercent)||win.resetsAt&&win.resetsAt*1000<=Date.now())return;
    const used=Math.max(0,Math.min(100,win.usedPercent));
    labels.push(label+'剩余 '+Math.round(100-used)+'%');
    if(used===100)return;
    const fill=path(d,'quota-fill');
    fill.setAttribute('pathLength','100');fill.setAttribute('stroke-dasharray','100');
    fill.setAttribute('stroke-dashoffset',String(used))
  }
  if(weekly&&short){
    segment('M6.4244 7.9652 A12.5 12.5 0 0 1 25.5756 7.9652',short,'5 小时');
    segment('M3.6899 13.8294 A12.5 12.5 0 1 0 28.3101 13.8294',weekly,'本周')
  }else segment('M16 3.5 A12.5 12.5 0 1 1 16 28.5 A12.5 12.5 0 1 1 16 3.5',weekly||short,weekly?'本周':'5 小时');
  path('M16 10.5 21.5 16 16 21.5 10.5 16Z','quota-symbol');
  quotaButton.replaceChildren(ring);
  quotaButton.title=['账号用量',...labels].join(' · ');
  quotaButton.setAttribute('aria-description',labels.join('，'))
}
async function readQuota(){
  if(!quotaRequest)quotaRequest=(async()=>{
    const res=await deviceFetch('/api/account-usage',{method:'POST'}),data=await res.json();
    if(!res.ok)throw Error(data.error);
    renderQuotaRing(data.groups);quotaCheckedAt=Date.now();return data
  })().finally(()=>{quotaRequest=null});
  return quotaRequest
}
function refreshQuotaRing(){
  if(quotaHostReady&&!mobile.matches&&document.visibilityState==='visible'&&Date.now()-quotaCheckedAt>=300000)
    void readQuota().catch(()=>renderQuotaRing([]))
}
renderQuotaRing([]);
document.addEventListener('visibilitychange',refreshQuotaRing);
mobile.addEventListener('change',refreshQuotaRing);
setInterval(refreshQuotaRing,300000);
async function accountUsage(){
  const body=modal('账号用量'),status=element('p','quiet',('正在读取 '+receiverName+' 的用量…'));body.append(status);
  try{
    const data=await readQuota();
    if(!body.contains(status))return;
    status.textContent=data.groups.length?'':'主机没有返回用量窗口';
    for(const group of data.groups){
      body.append(element('h3','',group.name));
      for(const w of group.windows){
        const mins=w.windowDurationMins;
        const duration=mins>0?(mins%1440===0?mins/1440+' 天':mins%60===0?mins/60+' 小时':mins+' 分钟'):'当前窗口';
        body.append(element('p','',duration+' · 已用 '+w.usedPercent+'%'));
        const meter=element('progress','quota-meter');meter.max=100;meter.value=w.usedPercent;meter.setAttribute('aria-label',group.name+' '+duration);body.append(meter);
        if(Number.isFinite(w.resetsAt))body.append(element('p','quiet','重置时间 '+new Date(w.resetsAt*1000).toLocaleString()))
      }
    }
  }catch(e){if(body.contains(status))status.textContent=e.message}
  if(body.contains(status))body.append(row('刷新用量','server',accountUsage))
}

let activityRevision=0;
function activeThreadView(){
  const panel=$('activity-view'),open=panel.hidden;
  panel.hidden=!open;
  document.querySelector('#side .history').hidden=open;
  const button=document.querySelector('[data-action="active-threads"]');
  button.setAttribute('aria-pressed',String(open));
  button.title=open?'关闭活动视图':'活动视图';
  if(open)refreshActivity();else activityRevision++
}
let hostActivity=[],activityRowsKey,activityNotice='';
function hostWaitLabel(flags){
  if(flags?.includes('waitingOnApproval'))return '等待审批';
  if(flags?.includes('waitingOnUserInput'))return '等待回复';
  return null
}
function renderActivity(){
  if($('activity-view').hidden)return;
  const entries=new Map();
  for(const item of hostActivity){
    const flags=item.flags||[];
    const label=hostWaitLabel(flags)||(item.active===false&&item.unread?'未读':'进行中');
    entries.set(item.thread,{title:item.title,label,open:()=>loadRemoteChat({...item,shared:true})})
  }
  for(const c of db.chats){
    if(c.archived||!(c.pending||c.activeTurn))continue;
    const key=c.thread||c.id,requests=Object.values(c.inputRequests||{}).flat();
    const approval=requests.some(q=>q?.fileReview||q?.commandReview);
    const label=approval?'等待审批':requests.length?'等待回复':c.activeTurn&&c.externalWait||entries.get(key)?.label||'进行中';
    entries.set(key,{title:c.title||'新聊天',label,open:()=>openCachedChat(c)})
  }
  const rows=$('activity-rows'),key=JSON.stringify([...entries].map(([id,r])=>[id,r.title,r.label]));
  if(key!==activityRowsKey){
    rows.replaceChildren(...[...entries.values()].map(r=>row(r.title,'message-circle',r.open,r.label)));
    activityRowsKey=key
  }
  $('activity-status').textContent=activityNotice||(rows.childElementCount?'':'当前没有活动任务。')
}
async function refreshActivity(){
  const revision=++activityRevision;
  activityNotice='正在读取主机活动…';renderActivity();
  try{
    const res=await deviceFetch('/api/active-threads',{method:'POST'}),data=await res.json();
    if(revision!==activityRevision)return;
    if(!res.ok)throw Error(data.error||'活动读取失败');
    hostActivity=data.items;activityRowsKey=null;activityNotice=''
  }catch(e){if(revision!==activityRevision)return;activityNotice=e.message}
  renderActivity()
}

const routeLabels={LAN:'局域网直连',P2P:'点对点直连',TURN:'TURN 中继',Relay:'服务器中继',Disconnected:'SDK 未确认路径'};
function firstTextTiming(job){
  const total=job.observedTextAt-job.created;
  if(!Number.isSafeInteger(job.observedTextAt)||!Number.isSafeInteger(job.created)||total<0)return null;
  const host=job.hostFirstTextMs;
  const timing={total,host:Number.isSafeInteger(host)&&host>=0?host:null,route:job.firstTextReader?.mode||null};
  if(Number.isSafeInteger(job.runtimeReadyAt)&&job.runtimeReadyAt>=job.created&&job.runtimeReadyAt<=job.observedTextAt)
    timing.prepare=job.runtimeReadyAt-job.created;
  if(Number.isSafeInteger(job.observedStartAt)&&job.observedStartAt>=job.created&&job.observedStartAt<=job.observedTextAt){
    timing.startAck=job.observedStartAt-job.created;
    timing.afterAck=job.observedTextAt-job.observedStartAt
  }
  const threadMs=job.hostSetupMs?.thread;
  if(Number.isSafeInteger(threadMs)&&threadMs>=0)timing.openThread=threadMs;
  const reader=job.firstTextReader;
  if(Number.isSafeInteger(reader?.attempt)&&reader.attempt>1){
    timing.readRetries=reader.attempt-1;
    const recovery=job.lastFollowRecovery;
    if(recovery?.attempt===reader.attempt&&[recovery.waitMs,recovery.openMs].every(ms=>Number.isSafeInteger(ms)&&ms>=0)){
      timing.retryWait=recovery.waitMs;timing.reopen=recovery.openMs
    }
    if(Number.isSafeInteger(reader.openedAt)&&Number.isSafeInteger(job.hostFirstTextAt)&&reader.openedAt>job.hostFirstTextAt)
      timing.lateReader=reader.openedAt-job.hostFirstTextAt
  }
  const clock=job.hostClock,forwarded=job.hostFirstTextForwardedAt;
  if(Number.isSafeInteger(forwarded)&&Number.isSafeInteger(job.hostFirstTextAt)&&forwarded>=job.hostFirstTextAt){
    timing.hostRead=forwarded-job.hostFirstTextAt;
    if(clock&&[clock.sentAt,clock.receivedAt,clock.hostAt].every(Number.isSafeInteger)&&clock.sentAt<=clock.receivedAt&&forwarded>=clock.hostAt){
      const aligned=job.observedTextAt-forwarded+clock.hostAt;
      if(aligned>=clock.sentAt)timing.returnRange=[Math.max(0,aligned-clock.receivedAt),aligned-clock.sentAt]
    }
  }
  return timing
}
function showFirstTextTiming(body,timing){
  if(!timing)return;
  const seconds=ms=>(Math.round(ms/10)/100).toFixed(2)+' 秒';
  body.append(element('h3','','最近有正文的网页轮次'),
    element('p','quiet','接收端受理到收到首段正文 · '+seconds(timing.total)));
  if(timing.startAck!=null&&timing.afterAck!=null)body.append(
    element('p','quiet','接收端受理到确认轮次启动 · '+seconds(timing.startAck)),
    element('p','quiet','确认轮次启动到收到首段正文 · '+seconds(timing.afterAck)));
  if(timing.prepare!=null)body.append(element('p','quiet','接收端等待辅助程序就绪 · '+seconds(timing.prepare)));
  if(timing.openThread!=null)body.append(element('p','quiet','主机打开聊天 · '+seconds(timing.openThread)));
  if(timing.host!==null)body.append(element('p','quiet','主机启动轮次到首段正文 · '+seconds(timing.host)));
  if(timing.hostRead!=null)body.append(element('p','quiet','主机适配器收到首段到转发程序读出 · '+timing.hostRead+' 毫秒'));
  if(timing.returnRange)body.append(element('p','quiet','主机读出到接收端收到 · 约 '+timing.returnRange.join('–')+' 毫秒（含转发处理）'));
  if(timing.readRetries)body.append(element('p','quiet','收到首段前重试读取 · '+timing.readRetries+' 次'));
  if(timing.retryWait!=null)body.append(
    element('p','quiet','记录读取失败到开始重试 · '+seconds(timing.retryWait)),
    element('p','quiet','开始重试到主机读取命令就绪 · '+seconds(timing.reopen)));
  if(timing.lateReader!=null)body.append(element('p','quiet','主机已有首段正文到重新开始读取 · '+seconds(timing.lateReader)));
  if(timing.route)body.append(element('p','quiet','首段正文返回路径 · '+(routeLabels[timing.route]||timing.route)))
}
async function connectionView(){
  const thread=current().thread;
  const body=modal('当前连接'),status=element('p','quiet',('正在通过 ds-harness-remote 检查 '+receiverName+'…'));
  status.setAttribute('role','status');body.append(row('主机会话','server',()=>remotePicker(false)),status);
  body.append(row('切换设备','server',()=>location.assign('/devices')));
  showFirstTextTiming(body,current().firstTextTiming);
  try{
    const res=await deviceFetch('/api/connection',{method:'POST'}),data=await res.json();
    const closed=data.lastDisconnect;
    if(body.contains(status)&&Number.isSafeInteger(closed?.at)){
      const reason=closed.reason==='unclassified'?'原因未知':closed.reason;
      const detail=[new Date(closed.at).toLocaleString(),reason,closed.code,closed.wsCode].filter(Boolean).join(' · ');
      body.append(element('p','quiet','上次主机连接断开 · '+detail))
    }
    if(!res.ok)throw Error(data.error||'连接检查失败');
    const name=element('bdi','',deviceScope?receiverName:data.host);
    if(deviceScope)name.setAttribute('data-receiver-name','');
    status.replaceChildren(name,' 已响应 · '+new Date(data.checkedAt).toLocaleTimeString())
    if(body.contains(status)){
      if(data.mode){body.append(element('p','quiet','本次检查的传输路径 · '+(routeLabels[data.mode]||data.mode)))}
      body.append(element('p','quiet','主机 Codex App Server · '+(data.appServerReady?'已响应':'未确认响应')));
      body.append(element('p','quiet','Remote 原生 Codex 接口 · '+(data.nativeCodex?'主机已提供':'主机未提供')))
      if(thread&&data.appServerReady){
        const activity=element('p','quiet','正在读取共享服务中的会话状态…');body.append(activity);
        try{
          const response=await deviceFetch('/api/thread-activity/'+thread,{method:'POST'}),snapshot=await response.json();
          if(!response.ok)throw Error(snapshot.error||'主机未返回会话状态');
          const states={active:'活动中',idle:'空闲',notLoaded:'未加载',systemError:'异常'};
          const turns={inProgress:'执行中',completed:'已完成',interrupted:'已停止',failed:'失败'};
          activity.textContent='共享服务中的当前会话 · '+(states[snapshot.state]||'未知')+
            (snapshot.turnStatus?' · 最近轮次'+(turns[snapshot.turnStatus]||snapshot.turnStatus):'');
          if(snapshot.state==='notLoaded')activity.textContent+='。可读取已保存的历史；原版窗口的实时状态尚未确认。'
        }catch{
          activity.textContent='当前会话状态暂时无法读取，可重新检查。'
        }
      }
    }
  }catch(e){status.textContent=e.message||'本地服务暂时无法访问'}
  if(body.contains(status))body.append(row('重新检查','server',connectionView))
}
function showPluginDestination(open,destination='plugins'){
  const page=$('plugin-page');
  page.hidden=!open;
  $('layout').classList.toggle('plugins-open',open);
  syncWorkWidth();
  for(const button of $('app-rail').querySelectorAll('[data-action="home"],[data-action="plugins"],[data-action="scheduled"],[data-action="settings"]')){
    if(button.dataset.action===(open?destination:'home'))button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current')
  }
  page.replaceChildren()
}
function restoreDestination(destination){
  if(destination==='plugins')pluginsView(true);
  if(destination==='scheduled')scheduledView(true);
  if(destination==='settings')settings(true)
}
function openSidePage(destination,title,restore){
  closeDialog();
  const entry=deviceHistoryEntry(browserHistory.state);
  if(!restore&&entry?.destination===destination)return;
  if(!restore&&entry){
    navEnd=entry.index+1;
    browserHistory.pushState({codexChat:{...entry,index:navEnd,destination}},'');
    pageStorage.setItem('codex-nav-end',String(navEnd))
  }
  const index=deviceHistoryEntry(browserHistory.state)?.index||0;
  $('chat-back').disabled=index<=0;$('chat-forward').disabled=index>=navEnd;
  if($('plugin-page').hidden)rememberReadingPosition();
  showPluginDestination(true,destination);
  $('layout').classList.remove('drawer');
  const body=$('plugin-page');
  body.append(btn('返回对话','chevron-down',()=>select(current()),'icon back-to-chat'),element('h1','',title));
  body.setAttribute('aria-label',title);
  return body
}
function scheduleDescription(rule){
  if(!rule)return '';
  const clauses=String(rule).replace(/^RRULE:/i,'').toUpperCase().split(';').map(c=>c.split('='));
  const units={MINUTELY:'分钟',HOURLY:'小时',DAILY:'天',WEEKLY:'周',MONTHLY:'个月',YEARLY:'年'};
  const weekdays={MO:'一',TU:'二',WE:'三',TH:'四',FR:'五',SA:'六',SU:'日'};
  const fields=Object.fromEntries(clauses),unit=units[fields.FREQ],interval=Number(fields.INTERVAL||1);
  if(!unit||!Number.isSafeInteger(interval)||interval<1||clauses.some(([k,v])=>!v||!['FREQ','INTERVAL','BYDAY','BYHOUR','BYMINUTE'].includes(k)))return '自定义周期';
  const parts=['每 '+interval+' '+unit];
  if(fields.BYDAY){
    const days=fields.BYDAY.split(',');
    if(days.some(d=>!weekdays[d]))return '自定义周期';
    parts.push(days.map(d=>'周'+weekdays[d]).join('、'))
  }
  if(fields.BYHOUR||fields.BYMINUTE){
    const hours=fields.BYHOUR?.split(','),minutes=fields.BYMINUTE?.split(',');
    if(hours?.length>24||minutes?.length>60||hours?.some(h=>!/^\d{1,2}$/.test(h)||Number(h)>23)||minutes?.some(m=>!/^\d{1,2}$/.test(m)||Number(m)>59))return '自定义周期';
    if(hours&&minutes)parts.push(hours.flatMap(h=>minutes.map(m=>h.padStart(2,'0')+':'+m.padStart(2,'0'))).join('、'));
    else if(hours)parts.push(hours.join('、')+' 时');
    else parts.push('第 '+minutes.join('、')+' 分钟')
  }
  return parts.join(' · ')
}
function scheduleTime(value){
  if(!Number.isSafeInteger(value)||value<=0)return '';
  const date=new Date(value);
  return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{dateStyle:'medium',timeStyle:'long'}):''
}
function shortScheduleTime(value,now=new Date()){
  if(!scheduleTime(value))return '';
  const date=new Date(value),tomorrow=new Date(now);
  tomorrow.setDate(tomorrow.getDate()+1);
  const day=date.toDateString()===now.toDateString()?'今天':date.toDateString()===tomorrow.toDateString()?'明天':'';
  const time=date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
  return (day||date.toLocaleDateString('zh-CN',{year:date.getFullYear()===now.getFullYear()?undefined:'numeric',month:'short',day:'numeric'}))+' '+time
}
function scheduleHistory(entry,id){
  const rows=element('div','schedule-runs'),status=element('p','quiet'),more=element('button','modal-row','查看运行记录');
  status.setAttribute('role','status');entry.append(rows,status,more);
  let cursor=null;
  more.onclick=async()=>{
    more.disabled=true;status.textContent='正在读取运行记录…';
    try{
      const res=await deviceFetch('/api/scheduled-local/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,cursor})});
      const data=await res.json();if(!res.ok)throw Error(data.error||'运行记录读取失败');
      if(!entry.isConnected)return;
      for(const run of data.runs){
        const state={IN_PROGRESS:'运行中',PENDING:'等待中',ACCEPTED:'已接受',ARCHIVED:'已归档',PENDING_REVIEW:'待查看',FAILED:'失败',COMPLETED:'已完成'}[run.status]||run.status;
        const info=[scheduleTime(run.created),state].filter(Boolean).join(' · ');
        const title=run.title||'定时任务运行';
        rows.append(row(title,'message-circle',()=>loadRemoteChat({thread:run.thread,title,updated:run.created/1000}),info))
      }
      cursor=data.cursor;more.hidden=!cursor;more.textContent='加载更早的记录';
      status.textContent=rows.childElementCount?'':'主机尚无运行记录。'
    }catch(e){status.textContent=e.message}
    finally{more.disabled=false}
  }
}
async function scheduledView(restore=false){
  const body=openSidePage('scheduled','定时任务',restore);
  if(!body)return;
  const status=element('p','quiet',('正在读取 '+receiverName+' 的本地定时任务…')),list=element('div','schedule-list');
  const refresh=element('button','modal-row','刷新本地任务');
  const toolbar=element('div','schedule-toolbar'),search=element('input','field');
  search.type='search';search.maxLength=256;search.placeholder='搜索';search.setAttribute('aria-label','搜索定时任务');
  const filter=element('select','field'),sort=element('select','field');
  filter.setAttribute('aria-label','按状态筛选');sort.setAttribute('aria-label','排序方式');
  for(const [control,choices] of [[filter,[['','全部状态'],['ACTIVE','已启用'],['PAUSED','已暂停']]],[sort,[['','默认排序'],['next','下次运行'],['name','名称']]]]){
    for(const [value,label] of choices)control.add(new Option(label,value))
  }
  toolbar.append(search,filter,sort);
  const head=element('div','schedule-head');
  for(const title of ['任务','下次运行','计划'])head.append(element('span','',title));
  const empty=element('p','quiet','没有符合条件的任务');empty.hidden=true;
  status.setAttribute('role','status');body.append(toolbar,status,list,empty,refresh);
  let entries=[];
  function applyFilters(){
    const query=search.value.trim().toLocaleLowerCase();
    const ordered=entries.slice();
    if(sort.value==='name')ordered.sort((a,b)=>a.task.name.localeCompare(b.task.name,'zh-CN'));
    if(sort.value==='next'){
      const next=t=>t.status==='ACTIVE'&&t.nextRunAt>0?t.nextRunAt:Infinity;
      ordered.sort((a,b)=>next(a.task)-next(b.task))
    }
    let count=0;
    for(const {task,entry} of ordered){
      const state=task.status==='DISABLED'?'PAUSED':task.status;
      entry.hidden=!!(filter.value&&filter.value!==state)||!task.name.toLocaleLowerCase().includes(query);
      if(!entry.hidden)count++;
      list.append(entry)
    }
    empty.hidden=!entries.length||count>0;head.hidden=!count
  }
  search.oninput=applyFilters;filter.onchange=applyFilters;sort.onchange=applyFilters;
  async function load(){
    refresh.disabled=true;
    try{
      const res=await deviceFetch('/api/scheduled-local',{method:'POST'}),data=await res.json();
      if(!res.ok)throw Error(data.error||'定时任务读取失败');
      if(!body.contains(list))return;
      entries=[];list.replaceChildren(head);
      for(const task of data.tasks){
        const entry=element('details','plugin-entry'),summary=element('summary','schedule-row');
        const title=element('span','schedule-name');title.append(icon('scheduled'),element('span','',task.name));
        const time=task.status==='ACTIVE'?shortScheduleTime(task.nextRunAt):'';
        const next=element('span','schedule-next',time||({PAUSED:'已暂停',DISABLED:'已暂停'}[task.status])||'—');
        if(time)next.title=scheduleTime(task.nextRunAt);
        const freq=/(?:^|[:;])FREQ=(\w+)/i.exec(task.rrule||'')?.[1]?.toUpperCase();
        const frequency={MINUTELY:'每分钟',HOURLY:'每小时',DAILY:'每天',WEEKLY:'每周',MONTHLY:'每月',YEARLY:'每年'}[freq]||(task.rrule?'自定义':'—');
        summary.append(title,next,element('span','schedule-frequency',frequency));
        entry.append(summary);
        const schedule=scheduleDescription(task.rrule);
        if(schedule)entry.append(element('p','quiet',schedule));
        for(const [label,value] of [['上次运行',task.lastRunAt],['下次运行',task.status==='ACTIVE'?task.nextRunAt:null]]){
          const time=scheduleTime(value);if(time)entry.append(element('p','quiet',label+' · '+time))
        }
        entry.append(element('p','schedule-prompt',task.prompt));entries.push({task,entry});
        if(data.databaseAvailable)scheduleHistory(entry,task.id)
      }
      applyFilters();
      status.textContent=data.tasks.length?(''+receiverName+' 的本地定时任务'):(''+receiverName+' 当前没有可显示的本地定时任务。');
      if(data.skipped)status.textContent+=' 有 '+data.skipped+' 项配置无法读取。'
    }catch(e){status.textContent=e.message}
    finally{refresh.disabled=false}
  }
  refresh.onclick=load;await load()
}
async function pluginDetails(plugin){
  const body=modal(plugin.name),status=element('p','quiet','正在读取插件详情…');
  const identity=element('p','quiet',plugin.market+' · '+plugin.catalogName);
  const description=element('p','',plugin.description||'');description.hidden=!plugin.description;
  status.setAttribute('role','status');body.append(identity,description,status);
  try{
    const response=await deviceFetch('/api/plugins/detail',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({market:plugin.market,catalogName:plugin.catalogName})});
    const detail=await response.json();
    if(!body.contains(status)||!$('dialog').open)return;
    if(!response.ok)throw Error(detail.error||'无法读取插件详情');
    identity.textContent=[detail.market,detail.catalogName,detail.version].filter(Boolean).join(' · ');
    description.textContent=detail.description||plugin.description||'';description.hidden=!description.textContent;
    status.textContent=detail.installed?(detail.enabled?'已启用':'已停用'):'未安装';
    for(const line of [detail.developer&&'开发者 · '+detail.developer,
      detail.skills?.length&&'技能 · '+detail.skills.join('、'),
      detail.mcpServers?.length&&'MCP 服务 · '+detail.mcpServers.join('、')]){
      if(line)body.append(element('p','',line))
    }
    if(detail.detailAvailable===false)body.append(element('p','quiet','当前显示主机目录信息，扩展详情暂不可用。'));
  }catch(error){
    if(!body.contains(status)||!$('dialog').open)return;
    status.textContent=error.message;body.append(row('重试','server',()=>pluginDetails(plugin)))
  }
}
function pluginsView(restore=false){
  const body=openSidePage('plugins','插件',restore);
  if(!body)return;
  const status=element('p','quiet'),search=element('input','field'),results=element('div','results');
  search.type='search';search.maxLength=180;search.placeholder='搜索插件';search.setAttribute('aria-label','搜索插件');
  status.setAttribute('role','status');body.append(search,status,results);
  let revision=0,timer;
  async function load(version,section=null){
    if(version!==revision||!body.contains(status))return;
    const group=section?.installed??null,offset=section?.count||0;
    if(section)section.more.disabled=true;
    else status.textContent=('正在读取 '+receiverName+' 的插件…');
    try{
      const response=await deviceFetch('/api/plugins/page',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({query:search.value.trim(),group,offset})}),data=await response.json();
      if(version!==revision||!body.contains(status))return;
      if(!response.ok)throw Error(data.error||'插件目录读取失败');
      status.textContent=data.partial?'部分插件来源暂时无法读取。':'';
      for(const page of data.groups){
        if(!page.total&&!section)continue;
        const part=section||{installed:page.installed,count:0,root:element('section')};
        if(!section){part.root.append(element('h3','plugin-heading',page.installed?'已安装':'可用插件'));results.append(part.root)}
        part.more?.remove();
        for(const plugin of page.entries){
          const item=element('div','plugin-entry'),title=element('strong','',plugin.name);
          if(plugin.catalogName){
            const open=element('button','plugin-detail-trigger');open.type='button';open.setAttribute('aria-haspopup','dialog');
            open.append(title);open.onclick=()=>pluginDetails(plugin);item.append(open)
          }else item.append(title);
          if(plugin.market){
            const label=plugin.sameDisplayName&&plugin.catalogName?plugin.market+' · '+plugin.catalogName:plugin.market;
            const source=element('small','quiet',label);
            source.title=plugin.catalogName?plugin.catalogName+' @ '+plugin.market:'插件来源';item.append(source)
          }
          if(page.installed)item.append(element('small','quiet',plugin.enabled?'已启用':'已停用'));
          if(plugin.description)item.append(element('p','quiet',plugin.description));part.root.append(item)
        }
        part.count+=page.entries.length;
        if(page.entries.length&&part.count<page.total){
          part.more=row('显示更多（剩余 '+(page.total-part.count)+'）','chevron-down',()=>load(version,part));part.root.append(part.more)
        }
      }
      if(!results.childElementCount)status.textContent=search.value.trim()?'没有匹配的插件':'主机目录为空'
    }catch(e){
      if(version!==revision||!body.contains(status))return;
      status.textContent=e.message;
      if(section)section.more.disabled=false;
      else results.replaceChildren(row('重试','server',()=>{results.replaceChildren();load(version)}))
    }
  }
  search.oninput=()=>{++revision;clearTimeout(timer);results.replaceChildren();status.textContent='正在搜索…';const version=revision;timer=setTimeout(()=>load(version),300)};
  load(revision);search.focus()
}
let drawerOpener;
function dismissWorkbenchOverlay(){
  if(!document.dispatchEvent(new Event('workbench-back',{cancelable:true})))return true;
  const flyout=document.querySelector('.speed-flyout');
  if(flyout?.hidePopover&&flyout.matches(':popover-open')){
    flyout.hidePopover();flyout.parentElement.querySelector('.speed-trigger')?.focus();return true
  }
  if($('dialog').open){closeDialog();return true}
  if(!$('file-mentions').hidden){closeMentions();return true}
  if($('layout').classList.contains('drawer')){toggleSidebar();return true}
  if(!$('thread-find').hidden){$('find-close').click();return true}
  return false
}
function toggleSidebar(){
  const layout=$('layout');
  if(mobile.matches||layout.classList.contains('compact-review')){
    if(layout.classList.toggle('drawer')){
      drawerOpener=document.activeElement;
      $('side').querySelector('button[data-action="new"]')?.focus({preventScroll:true})
    }else if(drawerOpener?.isConnected)drawerOpener.focus({preventScroll:true});
    return
  }
  db.collapsed=!db.collapsed;layout.classList.toggle('collapsed',db.collapsed);save()
}
function action(name,trigger){switch(name){case 'scheduled':scheduledView();break;case 'plugins':pluginsView();break;case 'home':db.collapsed=false;$('layout').classList.remove('collapsed');save();select(current());break;case 'new':start();break;case 'search':search();break;case 'close':closeDialog();break;case 'options':options(current(),trigger?.id==='header-options'?trigger:null);break;case 'settings':settings();break;case 'attach':attachmentMenu();break;case 'project':remotePicker(true);break;case 'permissions':permissionView();break;case 'account-usage':accountUsage();break;case 'usage':usageView();break;case 'plan-mode':void togglePlanMode();break;case 'models':modelPicker();break;case 'active-threads':activeThreadView();break;case 'refresh-activity':refreshActivity();break;case 'remote':remotePicker(false);break;case 'connection':connectionView();break;case 'sidebar':toggleSidebar();break}}
document.addEventListener('click',e=>{const hit=e.target.closest('[data-action]');if(hit){action(hit.dataset.action,hit);if(hit.id==='header-options')anchorHeaderMenu(hit)}});
function isDialogBackdrop(event){
  const dialog=$('dialog');
  if(event.target!==dialog)return false;
  const r=dialog.getBoundingClientRect();
  return event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom
}
let backdropPointer=null;
$('dialog').addEventListener('pointerdown',event=>{
  backdropPointer=event.isPrimary&&event.button===0&&isDialogBackdrop(event)?event.pointerId:null
});
$('dialog').addEventListener('pointercancel',()=>{backdropPointer=null});
$('dialog').onclick=event=>{
  const startedOutside=backdropPointer!==null&&(event.pointerId===undefined||event.pointerId===backdropPointer);
  backdropPointer=null;
  if(!startedOutside||!isDialogBackdrop(event))return;
  const modelMenu=$('dialog').classList.contains('model-menu');
  closeDialog();
  if(modelMenu&&document.elementFromPoint(event.clientX,event.clientY)===$('prompt'))$('prompt').focus({preventScroll:true})
};
function sidebarNeighbor(delta){
  const rows=Array.from(document.querySelectorAll('.history-row'));
  const selected=rows.findIndex(row=>row.classList.contains('active'));
  const index=selected>=0?selected+delta:delta>0?0:rows.length-1;
  rows[index]?.querySelector('button')?.click()
}
const commands=[
  {name:'在当前聊天中查找',icon:'search',keys:['f'],run:openThreadFind},
  {name:'添加本地文件',icon:'file-text',keys:['u'],run:()=>{closeDialog();$('file').click()}},
  {name:'已归档聊天',icon:'message-circle',keys:[],run:archives},
  {name:'新聊天',icon:'square-pen',keys:['n','shift+o'],run:start},
  {name:'搜索聊天',icon:'search',keys:[],run:search},
  {name:'切换项目侧栏',icon:'panel-left',keys:['b','shift+s'],run:()=>action('sidebar')},
  {name:'后退',icon:'chevron-down',keys:['['],run:()=>$('chat-back').click()},
  {name:'前进',icon:'chevron-down',keys:[']'],run:()=>$('chat-forward').click()},
  {name:'上一个侧栏对话',icon:'message-circle',keys:['alt+[','alt+arrowleft'],run:()=>sidebarNeighbor(-1)},
  {name:'下一个侧栏对话',icon:'message-circle',keys:['alt+]','alt+arrowright'],run:()=>sidebarNeighbor(1)},
  {name:'重命名聊天',icon:'square-pen',keys:['alt+r'],run:()=>renameChat(current())}
];
function openThreadFind(){
  const bar=$('thread-find'),input=$('find-text'),root=$('messages');
  if(!bar.hidden){input.focus();input.select();return}
  const previous=document.activeElement,selection=window.getSelection()?.toString();
  bar.hidden=false;if(selection&&selection.length<=256)input.value=selection;
  let ranges=[],active=0,frame=0;
  function render(reveal){
    const range=ranges[active];
    $('find-count').textContent=input.value?(range?(active+1)+' / '+ranges.length:'0 个结果'):'';
    $('find-prev').disabled=$('find-next').disabled=ranges.length<2;
    if(window.CSS?.highlights){
      const highlights=new Highlight();for(const hit of ranges)highlights.add(hit);
      CSS.highlights.set('thread-hits',highlights);
      CSS.highlights.set('thread-active',new Highlight(...(range?[range]:[])))
    }
    if(!range||!reveal)return;
    const target=range.startContainer.parentElement;
    const slot=target.closest('[data-turn-hidden]');
    if(slot)root.querySelector('button[aria-controls~="'+CSS.escape(slot.id)+'"]')?.click();
    target.closest('.user-text.truncated')?.querySelector('.user-text-toggle')?.click();
    const timeline=target.closest('details.timeline');if(timeline)timeline.open=true;
    const output=target.closest('pre');
    if(output){
      const match=range.getBoundingClientRect(),bounds=output.getBoundingClientRect();
      if(match.top<bounds.top||match.bottom>bounds.bottom)
        output.scrollTop+=match.top-bounds.top-output.clientHeight/2+match.height/2;
      if(match.left<bounds.left||match.right>bounds.right)
        output.scrollLeft+=match.left-bounds.left-output.clientWidth/2+Math.min(match.width,output.clientWidth)/2
    }
    const pane=$('scroller'),box=range.getBoundingClientRect(),viewport=pane.getBoundingClientRect();
    pane.scrollTop+=box.top-viewport.top-viewport.height/2+box.height/2
  }
  function collect(reveal){
    const query=input.value;ranges=[];
    if(query){
      const pattern=new RegExp(Array.from(query,ch=>'\\u{'+ch.codePointAt(0).toString(16)+'}').join(''),'giu');
      for(const body of root.querySelectorAll('.user-text-viewport,.answer,.live-answer,.timeline-line code,.command-output:not([hidden]),.turn-plan > p,.plan-steps li > span:last-child')){
        const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);
        let node;
        const blocks=new Map();
        while((node=walker.nextNode())){
          if(node.parentElement.closest('button,script,style,[aria-hidden=true]'))continue;
          const block=node.parentElement.closest('p,li,pre,td,th,h1,h2,h3,h4,h5,h6,blockquote')||body;
          if(!blocks.has(block))blocks.set(block,[]);
          blocks.get(block).push(node)
        }
        for(const nodes of blocks.values()){
          let offset=0,index=0;
          for(const match of nodes.map(n=>n.data).join('').matchAll(pattern)){
            while(offset+nodes[index].length<=match.index)offset+=nodes[index++].length;
            const range=new Range();range.setStart(nodes[index],match.index-offset);
            const end=match.index+match[0].length;
            while(offset+nodes[index].length<end)offset+=nodes[index++].length;
            range.setEnd(nodes[index],end-offset);ranges.push(range)
          }
        }
      }
    }
    active=Math.max(0,Math.min(active,ranges.length-1));render(reveal)
  }
  const observer=new MutationObserver(()=>{
    if(!frame)frame=requestAnimationFrame(()=>{frame=0;collect(false)})
  });
  observer.observe(root,{childList:true,subtree:true,characterData:true});
  const move=step=>{if(ranges.length){active=(active+step+ranges.length)%ranges.length;render(true)}};
  function close(restore=true){
    observer.disconnect();cancelAnimationFrame(frame);document.removeEventListener('chat-selected',onSwitch);
    bar.hidden=true;input.value='';CSS.highlights?.delete('thread-hits');CSS.highlights?.delete('thread-active');
    if(restore&&previous?.isConnected)previous.focus({preventScroll:true})
  }
  const onSwitch=()=>close(false);document.addEventListener('chat-selected',onSwitch);
  input.oninput=()=>{active=0;collect(true)};
  bar.onkeydown=e=>{
    if(isCompositionKey(e))return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close()}
    else if(e.target===input&&e.key==='Enter'){e.preventDefault();move(e.shiftKey?-1:1)}
  };
  $('find-prev').onclick=()=>move(-1);$('find-next').onclick=()=>move(1);$('find-close').onclick=()=>close();
  collect(true);input.focus();input.select()
}
function commandMenu(){
  const body=modal('命令菜单'),field=element('input','field'),results=element('div','results');
  field.placeholder='查找命令…';field.setAttribute('aria-label','查找命令');body.append(field,results);
  function render(){
    results.replaceChildren();
    for(const cmd of commands.filter(c=>c.name.includes(field.value.trim()))){
      const shortcut=cmd.keys[0];
      const prefix=navigator.platform.startsWith('Mac')?'⌘':'Ctrl+';
      results.append(row(cmd.name,cmd.icon,()=>{closeDialog();cmd.run()},shortcut?prefix+shortcut.split('+').map(part=>part[0].toUpperCase()+part.slice(1)).join('+'):''))
    }
    if(!results.children.length)results.append(element('p','quiet','没有匹配的命令'))
  }
  field.oninput=render;
  body.onkeydown=e=>{
    if(!body.contains(field)||isCompositionKey(e))return;
    const buttons=Array.from(results.querySelectorAll('button'));if(!buttons.length)return;
    const index=buttons.indexOf(document.activeElement);
    if(e.key==='Enter'&&index<0){e.preventDefault();buttons[0].click()}
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();const next=index<0?(e.key==='ArrowDown'?0:buttons.length-1):index+(e.key==='ArrowDown'?1:-1);
      buttons[(next+buttons.length)%buttons.length].focus()
    }
  };
  render();field.focus()
}
function setupDesktopMenus(){
  const bar=$('desktop-menus');
  const groups=[
    ['文件',[['新窗口',()=>window.open(location.pathname+'#new-window','_blank','noopener,popup')],['新聊天',start],['选择项目',()=>action('project')]]],
    ['编辑',[['撤销',()=>editDraft('undo')],['重做',()=>editDraft('redo')],['全选输入内容',()=>{$('prompt').focus();$('prompt').select()}],['设置',settings]]],
    ['视图',[['命令菜单',commandMenu],['切换项目侧栏',()=>action('sidebar')],['搜索聊天',search]]],
    ['帮助',[['Codex 连接信息',connectionView]]]
  ];
  function editDraft(command){$('prompt').focus();document.execCommand(command)}
  let active=null;
  function close(restore=false){
    if(!active)return;
    const {trigger,panel}=active;
    active=null;panel.remove();trigger.setAttribute('aria-expanded','false');
    if(restore)trigger.focus()
  }
  function open(trigger,entries){
    close();
    const panel=element('div','desktop-menu-popup');panel.setAttribute('role','menu');
    panel.setAttribute('aria-label',trigger.textContent);
    for(const [name,run] of entries){
      const item=element('button','',name);item.type='button';item.setAttribute('role','menuitem');
      item.onclick=()=>{close(true);run()};panel.append(item)
    }
    trigger.parentElement.append(panel);trigger.setAttribute('aria-expanded','true');
    active={trigger,panel};panel.firstElementChild.focus()
  }
  for(const [name,entries] of groups){
    const group=element('div','desktop-menu-group'),trigger=element('button','',name);
    trigger.type='button';trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
    group.append(trigger);bar.append(group);
    trigger.onclick=()=>active?.trigger===trigger?close(true):open(trigger,entries);
    trigger.onpointerenter=()=>{if(active&&active.trigger!==trigger)open(trigger,entries)};
    trigger.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();open(trigger,entries)}}
  }
  bar.addEventListener('keydown',e=>{
    if(!active||e.defaultPrevented)return;
    const {panel,trigger}=active;
    const items=Array.from(panel.children),index=items.indexOf(document.activeElement);
    if(e.key==='Escape'){e.preventDefault();close(true)}
    if(['ArrowDown','ArrowUp'].includes(e.key)){
      e.preventDefault();items[(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length].focus()
    }
    if(['ArrowRight','ArrowLeft'].includes(e.key)){
      e.preventDefault();const groups=Array.from(bar.children),idx=groups.indexOf(trigger.parentElement);
      groups[(idx+(e.key==='ArrowRight'?1:-1)+groups.length)%groups.length].firstElementChild.click()
    }
  });
  document.addEventListener('pointerdown',e=>{if(!bar.contains(e.target))close()});
  document.addEventListener('focusin',e=>{if(!bar.contains(e.target))close()});
  mobile.addEventListener('change',()=>close())
}
setupDesktopMenus();
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!e.defaultPrevented&&!$('dialog').open&&$('layout').classList.contains('drawer')){
    e.preventDefault();toggleSidebar();return
  }
  if(e.defaultPrevented||e.isComposing||e.getModifierState('AltGraph')||!(e.ctrlKey||e.metaKey))return;
  const key=(e.altKey?'alt+':'')+(e.shiftKey?'shift+':'')+e.key.toLowerCase();
  if(key==='k'||key==='shift+p'){e.preventDefault();if(!e.repeat)commandMenu();return}
  if($('dialog').open)return;
  const command=commands.find(cmd=>cmd.keys.includes(key));
  if(command){e.preventDefault();if(!e.repeat||key.startsWith('alt+arrow'))command.run()}
});
$('file').onchange=async()=>{
  const input=$('file'),batch=Array.from(input.files);input.value='';
  await addTextFiles(batch)
};
const composeBox=$('composer');
composeBox.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault()});
composeBox.addEventListener('drop',e=>{
  if(!e.dataTransfer.types.includes('Files'))return;
  e.preventDefault();void addTextFiles(Array.from(e.dataTransfer.files))
});
const maxImageBytes=256*1024;
function draftImageBytes(files){
  let bytes=0;
  for(const {url} of files){
    if(!url)continue;
    const length=url.length-url.indexOf(',')-1;
    bytes+=Math.floor(length*3/4)-(url.endsWith('==')?2:url.endsWith('=')?1:0)
  }
  return bytes
}
const isDraftImage=file=>['image/png','image/jpeg','image/webp'].includes(file.type);
function imageDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);
    reader.readAsDataURL(file)
  })
}
function storedImageFile(attachment){
  const comma=attachment.url.indexOf(','),header=attachment.url.slice(0,comma);
  const type=/^data:(image\/(?:png|jpeg|webp));base64$/.exec(header)?.[1];
  if(!type)throw Error('无法读取草稿中的图片');
  const bytes=Uint8Array.from(atob(attachment.url.slice(comma+1)),ch=>ch.charCodeAt(0));
  return new File([bytes],attachment.name,{type})
}
async function fitDraftImage(file,budget){
  if(file.size<=budget)return file;
  const bitmap=await createImageBitmap(file);
  try{
    const canvas=document.createElement('canvas');
    const longest=Math.max(bitmap.width,bitmap.height),minScale=Math.min(1,320/longest);
    let scale=Math.min(1,2560/longest);
    while(true){
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.9));
      if(!blob)throw Error('设备无法转换这张图片');
      if(blob.size<=budget){
        const extension=blob.type==='image/png'?'png':'webp';
        return new File([blob],file.name.replace(/\.[^.]*$/,'')+'.'+extension,{type:blob.type})
      }
      if(Math.max(canvas.width,canvas.height)<=320)throw Error('剩余空间不足，请移除部分图片');
      scale=Math.max(minScale,scale*Math.min(.8,Math.sqrt(budget/blob.size)*.95))
    }
  }finally{bitmap.close()}
}
function offerImageCopies(chat,batch=null){
  const original=chat.files;
  const body=modal('图片超过附件大小限制');
  const status=element('p','quiet','图片合计最多 256 KiB。可以缩小静态副本加入草稿，动图仅保留第一帧。');
  const confirm=row(batch?'压缩后加入草稿':'压缩草稿中的图片','image',async()=>{
    confirm.disabled=true;status.textContent='正在处理图片…';
    try{
      const files=batch||original.map(f=>f.url?storedImageFile(f):f);
      const images=files.filter(isDraftImage).sort((a,b)=>a.size-b.size),copies=new Map();
      let remaining=maxImageBytes-(batch?draftImageBytes(chat.files):0);
      for(const [i,file] of images.entries()){
        if(current()!==chat||!body.contains(confirm)||!$('dialog').open)return;
        const budget=Math.floor(remaining/(images.length-i));
        if(budget<=0)throw Error('剩余空间不足，请移除部分图片');
        const copy=await fitDraftImage(file,budget);
        remaining-=copy.size;copies.set(file,copy)
      }
      if(current()!==chat||!body.contains(confirm)||!$('dialog').open)return;
      if(batch){
        closeDialog();await addTextFiles(files.map(file=>copies.get(file)||file),false)
      }else{
        const updated=await Promise.all(files.map(async(file,i)=>{
          const copy=copies.get(file);
          return copy&&copy!==file?{name:copy.name,size:copy.size,url:await imageDataUrl(copy)}:original[i]
        }));
        if(current()!==chat||!body.contains(confirm)||!$('dialog').open)return;
        if(chat.files!==original)throw Error('附件已变化，请重新检查草稿');
        chat.files=updated;save();closeDialog();composer()
      }
    }catch(error){status.textContent=error.message||'无法处理图片';confirm.disabled=false}
  });
  body.append(status,confirm,row('取消','x',closeDialog))
}
async function addTextFiles(batch,offerCopies=true){
  const c=current();
  if(!batch.length)return;
  readingFiles.set(c,(readingFiles.get(c)||0)+1);resize();
  try{
    const imageFile=isDraftImage;
    if(batch.filter(imageFile).reduce((sum,f)=>sum+f.size,0)+draftImageBytes(c.files)>maxImageBytes){
      if(offerCopies&&draftImageBytes(c.files)<maxImageBytes){offerImageCopies(c,batch);return}
      throw Error('图片合计最多 256 KiB')
    }
    if(batch.some(f=>!imageFile(f)&&f.size>14500))throw Error('单个文本附件最多 14500 字节');
    if(batch.filter(f=>!imageFile(f)).reduce((total,f)=>total+f.size,0)>16000)throw Error('正文与附件合计最多 16 KB');
    const added=[];
    for(const f of batch){
      if(imageFile(f)){const url=await imageDataUrl(f);added.push({name:f.name,size:f.size,url});continue}
      const text=await f.text();if(text.includes('\0'))throw Error('仅支持文本文件');
      added.push({name:f.name,text})
    }
    const files=c.files.concat(added);
    if(draftImageBytes(files)>maxImageBytes)throw Error('图片合计最多 256 KiB');
    if(new TextEncoder().encode(promptWithFiles(c.draft.trim(),files)).length>16000)throw Error('正文与附件合计最多 16 KB');
    c.files=files;save()
  }catch(err){toast(err.message||'读取附件失败')}
  finally{
    const left=readingFiles.get(c)-1;if(left)readingFiles.set(c,left);else readingFiles.delete(c);
    if(c===current())composer()
  }
}
$('prompt').addEventListener('paste',event=>{
  const files=Array.from(event.clipboardData?.files||[]).filter(file=>['image/png','image/jpeg','image/webp'].includes(file.type));
  if(!files.length)return;
  event.preventDefault();
  const input=event.currentTarget,text=event.clipboardData.getData('text/plain');
  if(input.disabled||input.readOnly)return;
  if(text){
    input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');
    input.dispatchEvent(new Event('input',{bubbles:true}))
  }
  void addTextFiles(files)
});
const promptBox=$('prompt');
function fitEditorViewport(){
  const layout=$('layout'),height=window.visualViewport?.height||window.innerHeight;
  const compact=document.activeElement===promptBox&&height<=420;
  layout.classList.toggle('short-editor',compact);
  if(compact)layout.style.setProperty('--editor-viewport',height+'px');
  else layout.style.removeProperty('--editor-viewport')
}
promptBox.addEventListener('focus',fitEditorViewport);
promptBox.addEventListener('blur',()=>requestAnimationFrame(fitEditorViewport));
window.visualViewport?.addEventListener('resize',fitEditorViewport);
window.addEventListener('resize',fitEditorViewport);
let composingPrompt=false,enterKeyDown=false;
const mentionBox=$('file-mentions'),mentionList=$('mention-list');
let mention=null,mentionTimer,queuedMention=null,mentionReading=false;
function closeMentions(){
  clearTimeout(mentionTimer);queuedMention=null;mention=null;
  mentionBox.hidden=true;
  if(mentionBox.parentElement===document.body)$('composer').prepend(mentionBox);
  mentionBox.classList.remove('command-suggestions');mentionList.replaceChildren();promptBox.removeAttribute('aria-activedescendant');
  promptBox.removeAttribute('aria-controls');promptBox.removeAttribute('aria-autocomplete')
}
function mentionContext(){
  const c=current(),end=promptBox.selectionEnd;
  if(document.activeElement!==promptBox||composingPrompt||c.archived||!c.cwd||end!==promptBox.selectionStart)return null;
  const match=/(?:^|[\s（(])@([^\s@]{1,180})$/u.exec(promptBox.value.slice(0,end));if(!match)return null;
  const roots=(db.hostProjects||[]).flatMap(project=>project.roots);
  const root=projectRootFor(c.cwd,roots);
  return root?{chat:c.id,root,query:match[1],start:end-match[1].length-1,end}:null
}
function modelCommandRange(){
  const end=promptBox.selectionEnd,value=promptBox.value;
  if(document.activeElement!==promptBox||composingPrompt||current().archived||
    promptBox.selectionStart!==end||(end<value.length&&!/\s/u.test(value[end])))return null;
  const match=/(?:^|\s)(\/[a-z]*)$/i.exec(value.slice(0,end));
  return match&&'/model'.startsWith(match[1].toLowerCase())?{start:end-match[1].length,end}:null
}
function openCommandModels(range){
  closeMentions();promptBox.setRangeText('',range.start,range.end,'start');
  promptBox.dispatchEvent(new Event('input',{bubbles:true}));
  const chat=current(),draft=promptBox.value;
  const restoreCaret=()=>{
    if(current()===chat&&promptBox.value===draft&&!$('dialog').open){
      promptBox.focus();promptBox.setSelectionRange(range.start,range.start)
    }
  };
  void modelPicker(false,true);
  $('dialog').addEventListener('close',restoreCaret,{once:true})
}
function chooseMention(index){
  if(mention?.command){
    const range=modelCommandRange();
    if(mention.chat!==current().id||!range){closeMentions();return}
    openCommandModels(range);return
  }
  const context=mentionContext(),item=mention?.files[index];
  if(!item||!context||context.chat!==mention.chat||context.root!==mention.root||context.start!==mention.start||context.query!==mention.query){closeMentions();return}
  const path=projectEntryPath(mention.root,item.path);
  const token=/\s/u.test(path)?(isWindowsRoot(mention.root)?'"'+path+'"':JSON.stringify(path)):path;
  // The lookup uses the prefix at the caret, but accepting replaces the entire filename.
  const afterCaret=promptBox.value.slice(context.end);
  const tail=/^[\p{L}\p{N}\p{M}_./\\-]*/u.exec(afterCaret)[0].replace(/\.+$/u,'');
  const end=context.end+tail.length,suffix=promptBox.value.slice(end);
  const space=!suffix||!/^[\s\p{P}]/u.test(suffix)?' ':'';
  promptBox.setRangeText(token+space,context.start,end,'end');closeMentions();
  promptBox.dispatchEvent(new Event('input',{bubbles:true}))
}
function highlightMention(i){
  mention.index=i;for(const [n,button] of [...mentionList.children].entries())button.setAttribute('aria-selected',String(n===i));
  const active=mentionList.children[i];if(active){promptBox.setAttribute('aria-activedescendant',active.id);active.scrollIntoView({block:'nearest'})}
}
async function readMentions(request){
  if(mentionReading){queuedMention=request;return}mentionReading=true;
  try{
    let files;
    if(await nativePermissions()){
      if(mention!==request)return;
      const path=request.query.replaceAll('\\','/'),slash=path.lastIndexOf('/');
      const folder=slash<0?'':path.slice(0,slash),term=path.slice(slash+1).toLowerCase();
      if(path.startsWith('/')||folder.split('/').some(part=>part==='..'||part==='.'))throw Error('请输入项目内的相对路径');
      const c=current(),data=await projectDirectory(request.root,folder,c.cwd===request.root?c.thread:null);
      files=[...(data.files||[]),...data.folders].filter(name=>name.toLowerCase().includes(term)).map(name=>({path:folder?folder+'/'+name:name}));
      if(!files.length&&mention===request){request.loading=false;$('mention-status').textContent=data.truncated?'当前目录仅返回了部分条目':'当前目录没有匹配项，可输入子目录路径';return}
    }else files=await searchProjectFiles(request.root,request.query);
    if(mention!==request)return;
    request.files=files.slice(0,12);request.loading=false;
    $('mention-status').textContent=request.files.length?'':'没有匹配的项目文件';
    for(const [i,file] of request.files.entries()){
      const button=element('button','mention-option',file.path);button.type='button';button.tabIndex=-1;
      button.id='mention-option-'+i;button.setAttribute('role','option');
      button.onmousedown=e=>e.preventDefault();button.onclick=()=>chooseMention(i);mentionList.append(button)
    }
    if(request.files.length)highlightMention(0)
  }catch(err){if(mention===request){request.loading=false;$('mention-status').textContent=err.message}}
  finally{mentionReading=false;const next=queuedMention;queuedMention=null;if(next&&next===mention)void readMentions(next)}
}
function updateMentions(){
  if(modelCommandRange()){
    closeMentions();mention={command:true,chat:current().id,files:[],index:0};
    document.body.append(mentionBox);mentionBox.classList.add('command-suggestions');
    mentionBox.hidden=false;positionCommandMenu(mentionBox);mentionList.setAttribute('aria-label','命令');
    promptBox.setAttribute('aria-controls','mention-list');promptBox.setAttribute('aria-autocomplete','list');
    $('mention-status').textContent='';
    const button=element('button','mention-option','/model　选择模型');button.type='button';button.tabIndex=-1;
    button.id='model-command-option';button.setAttribute('role','option');button.onmousedown=e=>e.preventDefault();
    button.onclick=()=>chooseMention(0);mentionList.append(button);highlightMention(0);return
  }
  mentionList.setAttribute('aria-label','主机项目文件');
  const ctx=mentionContext();if(!ctx){closeMentions();return}
  if(mention&&mention.chat===ctx.chat&&mention.root===ctx.root&&mention.start===ctx.start&&mention.query===ctx.query)return;
  closeMentions();const request=mention={...ctx,files:[],loading:true,index:0};
  mentionBox.hidden=false;promptBox.setAttribute('aria-controls','mention-list');promptBox.setAttribute('aria-autocomplete','list');
  $('mention-status').textContent='正在查找项目文件…';mentionTimer=setTimeout(()=>readMentions(request),220)
}
document.addEventListener('chat-selected',closeMentions);
promptBox.addEventListener('click',updateMentions);
promptBox.addEventListener('keyup',e=>{
  if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)&&!e.isComposing)updateMentions()
});
promptBox.addEventListener('compositionstart',()=>{composingPrompt=true;closeMentions()});
promptBox.addEventListener('compositionend',()=>{composingPrompt=false;updateMentions()});
promptBox.onblur=()=>{enterKeyDown=false;composingPrompt=false;closeMentions()};
promptBox.oninput=()=>{
  const chat=current();chat.draft=promptBox.value;
  try{persistDraft(chat)}catch{storageFull()}
  updateEnterHint();resize();updateMentions()
};
function acceptSuggestion(event){
  if(!mention||!(mention.command||mention.files.length||mention.loading))return false;
  event.preventDefault();
  if(!event.repeat&&(mention.command||mention.files.length))chooseMention(mention.index);
  return true
}
promptBox.onkeydown=e=>{
  if(mention&&!e.isComposing&&!composingPrompt&&e.keyCode!==229){
    if(e.key==='Escape'){e.preventDefault();closeMentions();return}
    if(['ArrowDown','ArrowUp'].includes(e.key)&&mention.files.length){
      e.preventDefault();highlightMention((mention.index+(e.key==='ArrowDown'?1:-1)+mention.files.length)%mention.files.length);return
    }
    if(e.key==='Enter'&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!promptBox.hasAttribute('data-android-ime')&&acceptSuggestion(e))return;
    if(['ArrowLeft','ArrowRight','Home','End','Tab'].includes(e.key))closeMentions()
  }
  if(e.key!=='Enter')return;
  enterKeyDown=true;
  if(e.defaultPrevented||e.isComposing||composingPrompt||e.keyCode===229||e.shiftKey||e.altKey)return;
  if(!e.ctrlKey&&!e.metaKey&&!sendsWithEnter(promptBox.value))return;
  e.preventDefault();if(!e.repeat)$('composer').requestSubmit()
};
promptBox.onkeyup=e=>{if(e.key==='Enter'||e.keyCode===229)enterKeyDown=false};
// Some software keyboards deliver the editor action without a keyboard event.
promptBox.addEventListener('beforeinput',e=>{
  if(!e.cancelable||e.defaultPrevented||enterKeyDown||e.isComposing||composingPrompt)return;
  if(e.inputType!=='insertLineBreak'&&e.inputType!=='insertParagraph')return;
  if(promptBox.hasAttribute('data-android-ime'))return;
  if(acceptSuggestion(e))return;
  if(sendsWithEnter(promptBox.value)){
    e.preventDefault();$('composer').requestSubmit()
  }
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function waitForConnectionRetry(ms){
  return new Promise(resolve=>{
    const timer=setTimeout(finish,ms);
    window.addEventListener('online',finish);
    function finish(event){
      clearTimeout(timer);window.removeEventListener('online',finish);
      resolve(event?.type==='online')
    }
  })
}
function streamText(job){
  const parts=job.parts||[],progress=job.progress||{};
  const completed=progress.completedItem!==undefined?progress.completedItem===progress.activeItem:parts.at(-1)===progress.message;
  return [...parts,...(progress.message&&!completed?[progress.message]:[])].join('\n\n')
}
const pendingSteerReceipts=new WeakMap();
function addSupplement(c,message,fromReceipt=false){
  const pending=pendingSteerReceipts.get(c);
  if(!fromReceipt&&pending&&message.turn===pending.turn&&message.clientId===pending.request)pending.controller.abort();
  const saved=c.steerRequest;
  if(!fromReceipt&&!pending&&saved&&message.turn===saved.turn&&message.clientId===saved.request){
    const images=c.files.filter(file=>file.url).map(file=>file.url);
    if(promptWithFiles(c.draft.trim(),c.files)===saved.text&&JSON.stringify(images)===JSON.stringify(saved.images||[])){
      c.draft='';c.files=[]
    }
    delete c.steerRequest;save();if(current()===c)composer()
  }
  const existing=c.messages.find(m=>m.clientId===message.clientId);
  if(existing){
    const text=fromReceipt?existing.text:message.text??existing.text;
    const replaceImages=message.images?.length&&(!fromReceipt||!existing.images?.length)&&
      (message.images.length!==existing.images?.length||message.images.some((image,i)=>image!==existing.images[i]));
    if(text!==existing.text||replaceImages){
      const updated={...existing,text,images:replaceImages?message.images:existing.images};
      c.messages=c.messages.map(row=>row===existing?updated:row)
    }
    return
  }
  c.messages.push({role:'user',turn:message.turn,clientId:message.clientId,text:message.text,images:message.images})
}
async function* eventSnapshots(id){
  const source=new EventSource(devicePath+'/api/turn/'+id+'/events');
  let snapshot,closed=false,wake;
  let lastActivity=performance.now();
  const activity=()=>{lastActivity=performance.now()};
  const watchdog=setInterval(()=>{if(performance.now()-lastActivity>=45000)closeStream()},5000);
  source.addEventListener?.('heartbeat',activity);
  function closeStream(){closed=true;source.close();wake?.()}
  function resume(){if(!document.hidden)closeStream()}
  document.addEventListener('visibilitychange',resume);
  window.addEventListener('offline',closeStream);
  source.onmessage=e=>{
    if(closed)return;
    try{
      const next=JSON.parse(e.data);
      if(next?.id!==id){closeStream();return}
      activity();
      snapshot=next;wake?.()
    }catch{closeStream()}
  };
  source.onerror=closeStream;
  try{
    while(!closed||snapshot){
      if(!snapshot){await new Promise(resolve=>{wake=resolve});continue}
      const next=snapshot;snapshot=null;yield next
    }
  }finally{
    clearInterval(watchdog);
    document.removeEventListener('visibilitychange',resume);
    window.removeEventListener('offline',closeStream);
    source.close()
  }
}
async function* turnUpdates(id){
  const canStream=typeof EventSource==='function';
  let nextStream=0,retryDelay=1000;
  let misses=0;
  for(;;){
    if(canStream&&Date.now()>=nextStream){
      for await(const snapshot of eventSnapshots(id)){
        retryDelay=1000;misses=0;yield snapshot
      }
      nextStream=Date.now()+retryDelay;retryDelay=Math.min(retryDelay*2,15000)
    }
    let job;
    try{
      const res=await deviceFetch('/api/turn/'+id,{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(res.ok){
        const snapshot=await res.json();
        if(snapshot?.id===id){job=snapshot;misses=0}
      }
      else if(await submissionMissing(res)&&++misses>3)job={status:'error',error:'找不到本轮提交记录，请重新发送。'}
    }catch{}
    yield job||null;
    const delay=canStream?Math.max(0,Math.min(1000,nextStream-Date.now())):job?180:1000;
    if(job)await sleep(delay);
    else if(await waitForConnectionRetry(delay)){nextStream=0;retryDelay=1000}
  }
}
async function refreshLegacyTurn(c,id,turn){
  try{
    const history=await threadApi({thread:c.thread});
    const first=c.messages.findIndex(m=>m.submissionId===id);
    const rows=history.messages.filter(m=>m.turn===turn);
    if(first<0||c.pending||c.parent!==id||rows[0]?.role!=='user'||rows.length<2)return;
    c.messages=c.messages.slice(0,first).concat(rows);save();
    if(current()===c)messages(false)
  }catch{/* The cached reply remains available when the host is offline. */}
}
function commitOrderedMessages(c,rows){
  const users=new Set(rows.filter(m=>m.clientId));c.messages=c.messages.filter(m=>!users.has(m)).concat(rows)
}
function restoreUnsent(c,id){
  const entry=c.outbox;
  if(entry?.id!==id)return;
  c.messages=c.messages.filter(m=>m.submissionId!==id);
  const later=c.draft;
  c.draft=[entry.draft,later].filter(Boolean).join('\n');
  if(later&&entry.draft){
    const offset=c.draft.length-later.length;
    if(current()===c&&promptBox.value===later){
      const {selectionStart,selectionEnd,selectionDirection}=promptBox;
      promptBox.value=c.draft;
      promptBox.setSelectionRange(selectionStart+offset,selectionEnd+offset,selectionDirection)
    }else if(current()!==c){
      const selection=draftSelections.get(c);
      if(selection){selection.start+=offset;selection.end+=offset}
    }
  }
  c.files=entry.files.concat(c.files);
  delete c.outbox
}
async function submissionMissing(response){
  if(response.status===404)return true;
  // Earlier receiver versions reported a missing state file as HTTP 400.
  return response.status===400&&(await response.json()).error==='无法找到这轮对话'
}
async function confirmSubmission(c,id,firstAttempt){
  const entry=c.outbox;
  if(!entry||entry.id!==id||entry.confirmed)return true;
  const {draft,files,options}=entry;
  const payload=JSON.stringify({...options,expectedThread:options.expectedThread??c.thread??null,id,prompt:promptWithFiles(draft.trim(),files),images:files.filter(f=>f.url).map(f=>f.url)});
  let delay=500;
  while(c.pending===id){
    try{
      let accepted=false;
      if(!firstAttempt){
        const existing=await deviceFetch('/api/turn/'+id,{cache:'no-store',signal:AbortSignal.timeout(10000)});
        if(existing.ok){
          const job=await existing.json();
          if(job.id!==id)throw Error('提交回执不匹配');
          accepted=true
        }else if(!await submissionMissing(existing))throw Error('暂时无法核对提交状态')
      }
      if(!accepted){
        const res=await deviceFetch('/api/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:payload,signal:AbortSignal.timeout(15000)});
        const data=await res.json();
        if(data.code==='REMOTE_NOT_PAIRED')$('receiver-setup').hidden=false;
        else if(!res.ok&&res.status>=500)throw Error('接收端暂时不可用');
        if(c.pending!==id)return false;
        if(!res.ok){
          c.pending=null;c.error=data.error||'提交失败';restoreUnsent(c,id);
          save();renderSidebarHistory();if(current()===c){composer();messages()}return false
        }
        if(data.id!==id)throw Error('提交回执不匹配')
      }
      if(c.pending!==id)return false;
      entry.confirmed=true;save();return true
    }catch{
      firstAttempt=false;c.phase='正在核对提交状态…';if(current()===c)messages(false);
      const online=await waitForConnectionRetry(delay);
      delay=online?500:Math.min(delay*2,8000)
    }
  }
  return false
}
let renderedModelLabel;
const observedChats=new WeakMap();
async function poll(c,firstAttempt=false){
  const id=c.pending;if(!id||observedChats.get(c)===id)return;
  observedChats.set(c,id);
  try{if(!await confirmSubmission(c,id,firstAttempt))return;
    let lastView='';for await(const j of turnUpdates(id)){
    if(c.pending!==id)break;
    if(!j){
      if(c.phase!=='正在重新连接…'){lastView='';c.phase='正在重新连接…';if(current()===c)messages(false)}
      continue
    }
    if(j.observedTextAt!=null&&c.firstTextTiming?.job!==id){
      const timing=firstTextTiming(j);if(timing)c.firstTextTiming={job:id,...timing}
    }
    if(Object.hasOwn(j,'threadServiceTier'))c.threadServiceTier=j.threadServiceTier;
    const nextRequests=j.status==='waiting'?j.inputRequests||{}:{};
    for(const token of Object.keys(c.inputRequests||{})){
      if(!Object.hasOwn(nextRequests,token))try{pageStorage.removeItem(questionDraftKey(c,token))}catch{}
    }
    c.turn=j.turn||null;c.inputRequests=nextRequests;if(current()===c)pendingQuestions(c);
    if(Object.hasOwn(j,'goal')){c.goal=j.goal;if(current()===c)renderGoal(c)}
    for(const message of j.supplements||[])addSupplement(c,message);
    const ordered=Array.isArray(j.order)?orderedMessages(c,j):null;
    if(ordered)orderedSnapshots.set(c,ordered);else orderedSnapshots.delete(c);
    if(j.thread)c.thread=j.thread;if(j.permissions)c.permissions=j.permissions;if(j.usage){c.usage=j.usage;if(!j.effective&&current()===c)renderContextUsage(c.usage)}if(j.effective){c.effective=j.effective;c.threadConfig=j.effective;if(c.selectionDuringTurn!==id)c.selectedForNext=false;if(current()===c)modelLabel(c)}if(j.status==='done'||j.status==='interrupted'){if(ordered?.length){
      commitOrderedMessages(c,ordered);
      if(j.status==='interrupted')c.messages.push({role:'status',turn:j.turn,status:'interrupted'})
    }else c.messages.push({role:'assistant',turn:j.turn,text:j.answer||'',items:j.progress?.items||[],interrupted:j.status==='interrupted'});
      if(Number.isSafeInteger(j.turnDurationMs)&&j.turnDurationMs>=0){
        const final=c.messages.findLast(m=>m.turn===j.turn&&(m.role==='assistant'||m.role==='status'));
        if(final)final.turnDurationMs=j.turnDurationMs
      }
      c.parent=id;c.thread=j.thread;c.pending=null;c.error=null}
    else if(j.status==='error'){if(ordered?.length)commitOrderedMessages(c,ordered);c.pending=null;c.receiptUnknown=j.receiptUnknown===true;c.error=j.error||'远端执行失败';
      if(!j.turn&&(j.notSubmitted||/already has an active writer/i.test(c.error))){
        restoreUnsent(c,id);
        c.error=j.notSubmitted?(''+receiverName+' 离线。消息未发送，恢复连接后可重新发送。'):'主机上的另一个 Codex 实例正在写入此会话。消息未发送。';
        if(current()===c)composer()
      }}else {c.items=j.progress?.items||[];c.preview=streamText(j);const labels={command_execution:'正在执行命令…',mcp_tool_call:'正在调用工具…',web_search:'正在搜索…',file_change:'正在处理文件…'};c.phase=j.reconnecting?(j.lastFollowFailure?.code==='REMOTE_HOST_OFFLINE'?(''+receiverName+' 离线，正在等待恢复…'):('正在重新连接 '+receiverName+'…')):j.status==='preparing'?('正在连接 '+receiverName+'…'):labels[j.progress?.item]||(j.progress?.started?'正在处理任务…':'正在启动 Codex…')}
    if(c.outbox?.id===id&&(j.turn||!c.pending))delete c.outbox;
    const content=ordered??[c.preview,c.items,j.stepPlan,j.proposedPlans];
    const view=JSON.stringify([c.pending,c.turn,c.phase,content,c.error,c.messages.length,c.messages.at(-1)?.images?.length]);
    if(view!==lastView){lastView=view;if(!c.pending)save();if(current()===c)messages(false)}
    if(!$('activity-view').hidden){
      if(c.pending)renderActivity();
      else{hostActivity=hostActivity.filter(item=>item.thread!==c.thread);void refreshActivity()}
    }
    if(!c.pending){
      orderedSnapshots.delete(c);if(current()===c)modelLabel(c);
      if(!ordered&&j.turn&&c.parent===id&&(j.parts?.length>1||j.progress?.items?.length))void refreshLegacyTurn(c,id,j.turn);
      break
    }
  }}finally{if(observedChats.get(c)===id)observedChats.delete(c)}
}
async function steer(c){
  const draft=c.draft.trim(),files=c.files,id=c.pending||c.thread,turn=c.pending?c.turn:c.activeTurn;
  if(!turn||!id||c.steering||readingFiles.has(c)||(!draft&&!files.length))return;
  if(draftImageBytes(files)>maxImageBytes){offerImageCopies(c);return}
  const images=files.filter(f=>f.url).map(f=>f.url);
  const text=promptWithFiles(draft,files);
  if(new TextEncoder().encode(text).length>16000){toast('单条消息最多 16 KB');return}
  if(c.steerRequest?.text!==text||c.steerRequest?.turn!==turn||JSON.stringify(c.steerRequest?.images||[])!==JSON.stringify(images))c.steerRequest={text,turn,images,request:crypto.randomUUID()};
  const payload=c.steerRequest,controller=new AbortController();
  pendingSteerReceipts.set(c,{turn,request:payload.request,controller});
  save();c.steering=true;resize();
  document.dispatchEvent(new CustomEvent('draft-submitted',{detail:c.id}));
  try{
    try{
      const r=await deviceFetch((c.pending?'/api/steer/':'/api/thread-steer/')+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
      const data=await r.json();if(!r.ok||data.turn!==turn)throw Error(data.error||'主机未确认补充要求')
    }catch(error){if(!controller.signal.aborted)throw error}
    addSupplement(c,{turn,clientId:payload.request,text:payload.text,images:payload.images},true);
    if(c.draft.trim()===draft)c.draft='';c.files=c.files.filter(f=>!files.includes(f));
    delete c.steerRequest
  }catch(e){toast(e.message)}finally{pendingSteerReceipts.delete(c);delete c.steering;save();if(current()===c){composer();messages(false)}}
}
$('steer').onclick=()=>steer(current());
$('composer').onsubmit=async e=>{e.preventDefault();const c=current(),submittedDraft=c.draft,text=submittedDraft.trim(),files=c.files;if(c.historyMissing||c.archived||!$('receiver-setup').hidden)return;if(submittedDraft.toLowerCase()==='/model'){openCommandModels({start:0,end:submittedDraft.length});return}if(c.pending||c.activeTurn){await steer(c);return}if(readingFiles.has(c)||(!text&&!files.length))return;
  if(draftImageBytes(files)>maxImageBytes){offerImageCopies(c);return}
  const prompt=promptWithFiles(text,files);if(new TextEncoder().encode(prompt).length>16000){toast('单条消息最多 16 KB');return}
  let native;
  try{native=await nativePermissions()}catch(error){toast(error.message);return}
  if(current()!==c||c.pending||c.activeTurn||c.archived||c.draft!==submittedDraft||c.files!==files||readingFiles.has(c))return;
  if(native&&(c.collaborationMode==='plan'||turnModelOptions(c).serviceTier)){
    const body=modal('调整聊天设置');
    body.append(element('p','','当前主机连接仅支持普通聊天，并沿用主机速度。草稿已保留。'),
      row('使用普通聊天并沿用主机速度','check',()=>{
        if(c!==current())return;
        c.collaborationMode='default';delete c.speedChoice;save();closeDialog();composer();$('prompt').focus()
      }));
    return
  }
  if(native&&!supportsNativePermission(c)){
    void permissionView(true);return
  }
  document.dispatchEvent(new CustomEvent('draft-submitted',{detail:c.id}));
  const id=crypto.randomUUID();delete c.receiptUnknown;delete c.selectionDuringTurn;c.pending=id;c.turn=null;c.stopping=false;c.preview='';c.items=[];c.phase='正在发送…';c.error=null;const visible=[text,...files.map(f=>'📎 '+f.name)].filter(Boolean).join('\n');if(!c.messages.length)c.title=(text||files[0].name).slice(0,45);const images=files.filter(f=>f.url).map(f=>f.url);c.outbox={id,draft:submittedDraft,files,options:{approvalPolicy:c.approvalPolicy||"never",expectedThread:c.thread||null,parent:c.parent,cwd:c.cwd||null,projectId:c.projectId||null,sandbox:c.sandbox||'read-only',collaborationMode:c.collaborationMode||null,...turnModelOptions(c)}};const optimistic={role:'user',text:visible,images,submissionId:id};c.messages.push(optimistic);c.files=[];c.draft='';c.updated=Date.now();save();renderSidebarHistory();composer();messages();
  await poll(c,true)
};
let firstDirectoryRequest, directoryHeadRequest, lastDirectorySignature, lastDirectoryCheck=0;
function readDirectoryHead(){
  if(!directoryHeadRequest){
    lastDirectoryCheck=Date.now();
    directoryHeadRequest=threadApi({}).finally(()=>{directoryHeadRequest=null})
  }
  return directoryHeadRequest
}
async function checkDirectoryHead(pushed=false){
  if(document.visibilityState!=='visible'||!lastDirectorySignature||firstDirectoryRequest||
     directoryRequests.size||pendingProjectLoads.size||(pushed!==true&&Date.now()-lastDirectoryCheck<10000))return;
  try{
    const page=await readDirectoryHead();
    if(!firstDirectoryRequest&&!directoryRequests.size&&!pendingProjectLoads.size&&
       document.visibilityState==='visible'&&JSON.stringify(page)!==lastDirectorySignature){
      await directoryPage(null,page)
    }
  }catch{/* Keep the loaded directory available until the next foreground check. */}
}
const renamesDuringReads=new Set();
let directoryEvents,directoryWake,seenDirectoryRevision;
function syncDirectoryEvents(){
  if(document.visibilityState!=='visible'){
    directoryEvents?.close();directoryEvents=null;clearTimeout(directoryWake);return
  }
  if(directoryEvents||typeof EventSource!=='function')return;
  directoryEvents=new EventSource(devicePath+'/api/directory-events');
  directoryEvents.addEventListener('device-name',event=>{
    const name=JSON.parse(event.data);
    if(typeof name!=='string'||!name||receiverName===name)return;
    receiverName=name;
    document.querySelector('meta[name="receiver-name"]').content=name;
    renderReceiverName()
  });
  directoryEvents.addEventListener('device-access-lost',leaveRevokedDevice);
  directoryEvents.addEventListener('thread-name',event=>{
    let rename;
    try{rename=JSON.parse(event.data)}catch{return}
    if(!rename||typeof rename.thread!=='string'||typeof rename.title!=='string')return;
    for(const changes of renamesDuringReads)changes.set(rename.thread,rename.title);
    let changed=false;
    for(const list of [db.chats,db.hostIndex,db.pinnedThreads]){
      for(const item of list||[])if(item.thread===rename.thread&&item.title!==rename.title){
        item.title=rename.title;changed=true
      }
    }
    if(!changed)return;
    if(current()?.thread===rename.thread&&$('plugin-page').hidden)renderChatTitle(current());
    renderSidebarHistory();save()
  });
  directoryEvents.onmessage=event=>{
    const missed=seenDirectoryRevision&&seenDirectoryRevision!==event.lastEventId;
    seenDirectoryRevision=event.lastEventId;
    if(event.data!=='changed'&&!missed)return;
    clearTimeout(directoryWake);
    directoryWake=setTimeout(async()=>{
      try{
        await Promise.allSettled([firstDirectoryRequest,directoryHeadRequest,...directoryRequests.values(),...pendingProjectLoads]);
        await checkDirectoryHead(true)
      }catch{/* The periodic directory check remains available after disconnects. */}
    },50)
  }
}
const directoryRequests=new Map();
let directoryPreviewRevision=0;
function applyDirectoryPage(page,append,restoring=false){

  const index=new Map((append||restoring?db.hostIndex||[]:[]).map(item=>[item.thread,item]));
  for(const item of page.items){
    index.set(item.thread,item);
    const chat=db.chats.find(c=>c.thread===item.thread);
    if(chat){chat.archived=false;chat.title=item.title;chat.cwd=item.cwd;chat.projectId=item.projectId;if(item.readState)chat.readState=item.readState}
  }
  if(current()&&$('plugin-page').hidden)renderChatTitle(current());
  if(!append&&Array.isArray(page.pinned))db.pinnedThreads=page.pinned;
  if(!append&&Array.isArray(page.projects)){db.hostProjects=page.projects;renderProjectName(current())}
  db.hostIndex=[...index.values()];
  if(!restoring)db.directoryCursor=page.cursor||null;
  save();renderSidebarHistory();
  if(restoring){directoryPreviewRevision++;$('directory-status').textContent='正在恢复更多会话…';return}
  $('directory-next').hidden=!db.directoryCursor;$('directory-status').replaceChildren()
}
function directoryPage(cursor,head){
  if(cursor){
    if(!directoryRequests.has(cursor))directoryRequests.set(cursor,threadApi({cursor}).then(page=>{
      if(db.directoryCursor===cursor){
        db.directoryPageCount=(db.directoryPageCount||1)+1;applyDirectoryPage(page,true)
      }
      return page
    }).finally(()=>directoryRequests.delete(cursor)));
    return directoryRequests.get(cursor)
  }
  if(!firstDirectoryRequest)firstDirectoryRequest=(head?Promise.resolve(head):readDirectoryHead()).then(async page=>{
    const signature=JSON.stringify(page);
    const desired=db.directoryPageCount||1,visited=new Set();
    if((desired>1&&page.cursor)||Object.keys(db.projectPageCounts||{}).length)applyDirectoryPage(page,false,true);
    let count=1;
    while(count<desired&&page.cursor){
      if(visited.has(page.cursor))throw Error('主机返回了重复的目录游标');
      visited.add(page.cursor);
      const next=await threadApi({cursor:page.cursor});
      page={...page,items:page.items.concat(next.items),cursor:next.cursor};
      count++
    }
    await Promise.allSettled([...pendingProjectLoads]);
    const projectItems=[],restored=new Map();
    for(const [source,depth] of Object.entries(db.projectPageCounts||{})){
      if(!isProjectPath(source)&&Array.isArray(page.projects)&&!page.projects.some(project=>project.id===source))continue;
      const state={more:true,cursor:null,count:0};
      while(state.more&&state.count<depth){
        const {items,...next}=await fetchProjectPage(source,state);
        projectItems.push(...items);Object.assign(state,next);state.count++
      }
      restored.set(source,state)
    }
    projectPages.clear();for(const [source,state] of restored)projectPages.set(source,state);
    db.projectPageCounts=Object.fromEntries([...restored].map(([source,state])=>[source,state.count]));
    db.directoryPageCount=count;
    const merged={...page,items:[...projectItems,...page.items]};
    applyDirectoryPage(merged,false);lastDirectorySignature=signature;return merged
  }).finally(()=>{firstDirectoryRequest=null});
  return firstDirectoryRequest
}
async function syncArchiveFlags(chats){
  const revisions=chats.map(c=>{
    const next=(archiveChanges.get(c.thread)||0)+1;
    archiveChanges.set(c.thread,next);return next
  });
  const result=await archiveApi({ids:chats.map(c=>c.thread)});
  for(const [i,c] of chats.entries()){
    if(archiveChanges.get(c.thread)!==revisions[i])continue;
    c.archived=result.ids.includes(c.thread);
    if(c.archived){
      db.hostIndex=db.hostIndex?.filter(item=>item.thread!==c.thread);
      db.pinnedThreads=db.pinnedThreads?.filter(item=>item.thread!==c.thread)
    }
    if(c===current())archiveComposer(c)
  }
}
document.addEventListener('visibilitychange',()=>{
  syncThreadWatch();
  const c=current();
  if(c?.activeTurn&&!c.pending){
    if(document.visibilityState==='visible')void followExternalTurn(c,selectionRevision,true);
    else externalFollowers.get(c)?.wake?.()
  }
  if(document.visibilityState==='visible'&&c?.thread&&!c.pending){
    void refreshCurrentHistory(c);
    void syncArchiveFlags([c]).then(()=>{save();renderSidebarHistory()}).catch(()=>{})
  }
});
async function refreshSidebar(){
  const previousPreview=directoryPreviewRevision;
  const status=$('directory-status');status.replaceChildren();
  if(!db.hostIndex?.length)status.textContent='正在读取主机项目…';
  try{
    const page=await directoryPage(null),shown=new Set(page.items.map(t=>t.thread));
    const older=db.chats.filter(c=>c.thread&&!shown.has(c.thread));
    for(let i=0;i<older.length;i+=30){
      const batch=older.slice(i,i+30);await syncArchiveFlags(batch)
    }
    $('receiver-setup').hidden=true;resize();quotaHostReady=true;refreshQuotaRing();
    save();archiveComposer(current());renderSidebarHistory();status.replaceChildren()
  }
  catch(e){
    if(e.code==='REMOTE_NOT_PAIRED')$('receiver-setup').hidden=false;
    else if(e.code==='REMOTE_HOST_ABSENT'||e.code==='REMOTE_HOST_OFFLINE')$('receiver-setup').hidden=true;
    resize();
    if(!$('receiver-setup').hidden&&$('retry-pairing').disabled)$('pairing-status').textContent='尚未检测到设备授权';
    status.textContent=directoryPreviewRevision!==previousPreview?'已显示最新首页，部分会话未能刷新。':db.hostIndex?.length?'主机目录未更新。':e.message;
    status.append(row('重试','server',refreshSidebar))
  }
}
async function receiverAuthorized(){
  if(firstDirectoryRequest){
    try{await firstDirectoryRequest}catch{await refreshSidebar()}
    return
  }
  if(!lastDirectorySignature||!$('receiver-setup').hidden)await refreshSidebar()
}
$('retry-pairing').onclick=async()=>{
  const button=$('retry-pairing');button.disabled=true;$('pairing-status').textContent='正在连接…';
  try{await refreshSidebar()}finally{button.disabled=false}
};
if('serviceWorker' in navigator)navigator.serviceWorker.register('/receiver-worker.js').catch(()=>{});
$('directory-next').onclick=async()=>{
  const more=$('directory-next');more.disabled=true;
  try{if(firstDirectoryRequest)await firstDirectoryRequest;if(db.directoryCursor)await directoryPage(db.directoryCursor)}
  catch(e){$('directory-status').textContent=e.message}
  finally{more.disabled=false}
};
async function threadApi(args,signal){
  const renames=new Map();renamesDuringReads.add(renames);
  try{
    const r=await deviceFetch('/api/threads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal});
    const data=await r.json();
    if(!r.ok)throw Object.assign(Error(data.error||'读取失败'),{code:data.code});
    if(args.thread&&(data.thread!==args.thread||!Array.isArray(data.messages)))throw Error('返回的聊天记录与所选会话不匹配，请重新读取');
    if(renames.size){
      if(renames.has(args.thread))data.name=renames.get(args.thread);
      for(const list of [data.items,data.pinned]){
        for(const item of list||[])if(renames.has(item.thread))item.title=renames.get(item.thread)
      }
    }
    return data
  }finally{renamesDuringReads.delete(renames)}
}
async function remotePicker(projects){
  const body=modal(projects?'选择远程项目':(''+receiverName+' 的会话'),projects?document.querySelector('[data-action=project]'):null),panel=element('div','results'),status=element('p','quiet','正在读取 Codex 会话目录…');body.append(status,panel);
  if(projects&&menuAnchor)$('dialog').classList.add('composer-menu');
  const seen=new Set();
  const search=projects?element('input','field'):null;
  const empty=element('p','quiet','已加载的项目中没有匹配项。');
  function filterProjects(){
    if(!search)return;
    const query=search.value.trim().toLocaleLowerCase();
    const choices=Array.from(panel.querySelectorAll('[data-project-option]'));
    for(const choice of choices)choice.hidden=!choice.textContent.toLocaleLowerCase().includes(query);
    empty.hidden=!query||choices.some(choice=>!choice.hidden)
  }
  if(search){
    search.type='search';search.placeholder='搜索项目';search.setAttribute('aria-label',search.placeholder);
    empty.hidden=true;empty.setAttribute('role','status');body.prepend(search);body.append(empty);
    search.oninput=filterProjects;
    body.onkeydown=event=>{
      if(isCompositionKey(event)||!['ArrowDown','ArrowUp','Enter'].includes(event.key))return;
      const choices=Array.from(panel.querySelectorAll('button:not([hidden]):not(:disabled)'));
      if(event.key==='Enter'){
        if(event.target===search){event.preventDefault();choices.find(button=>button.hasAttribute('data-project-option'))?.click()}
        return
      }
      if(!choices.length)return;
      event.preventDefault();const i=choices.indexOf(event.target);
      choices[(event.key==='ArrowDown'?i+1:i<0?choices.length-1:i-1+choices.length)%choices.length].focus()
    };
    if(!matchMedia('(pointer:coarse)').matches)search.focus()
  }
  function appendItems(items){
      for(const item of items){
        if(projects){const id=hostProject(item.cwd,item.projectId)?.id||null,key=JSON.stringify([id,item.cwd]);if(!item.cwd||seen.has(key))continue;seen.add(key);
          const choice=row(projectName(item.cwd,id),'folder-open',()=>chooseProject(item.cwd,id),item.cwd);
          choice.dataset.projectOption=key;panel.append(choice);continue}
        panel.append(row(item.title,'message-circle',()=>loadRemoteChat(item)))
      }
  }
  const roots=()=>(db.hostProjects||[]).flatMap(p=>p.roots.map(cwd=>({cwd,projectId:p.id})));
  if(projects)appendItems(roots());
  if(db.hostIndex?.length){appendItems(db.hostIndex);status.textContent='已显示上次读取的目录，正在刷新…'}
  filterProjects();
  async function load(cursor){
    try{
      const page=await directoryPage(cursor);if(!body.contains(panel))return;
      status.textContent=projects?(current().thread||current().messages.length?'选择项目将打开一条新任务。':'选择此草稿的工作目录。'):'选择会话以读取主机上的历史记录。';
      const focusedKey=panel.contains(document.activeElement)?document.activeElement.dataset.projectOption:null;
      if(!cursor){panel.replaceChildren();seen.clear();if(projects)appendItems(roots())}
      appendItems(page.items);filterProjects();
      if(!cursor&&focusedKey){const match=Array.from(panel.children).find(el=>el.dataset.projectOption===focusedKey&&!el.hidden);(match||search)?.focus()}
      if(page.cursor){const more=row('加载更多','chevron-down',()=>{more.remove();load(page.cursor)});panel.append(more)}
      if(!panel.children.length)status.textContent='此主机没有返回会话。'
    }catch(e){
      if(!body.contains(panel))return;
      status.textContent=panel.children.length?'刷新失败，当前目录仍可浏览。':'读取失败：'+e.message;
      const retry=row('重试','server',()=>{retry.remove();load(cursor)});panel.append(retry)
    }
  }
  await load(null)
}

$('send').addEventListener('click',async e=>{
  const c=current(),turn=c.pending?c.turn:c.activeTurn;if(!turn||c.stopping===turn)return;
  e.preventDefault();const path=c.pending?'/api/interrupt/'+c.pending:'/api/thread-interrupt/'+c.thread+'/'+turn;
  c.stopping=turn;resize();
  try{const res=await deviceFetch(path,{method:'POST'});const data=await res.json();
    if(res.status===409&&path.startsWith('/api/thread-interrupt/')){
      const check=await deviceFetch('/api/thread-activity/'+c.thread,{method:'POST'});
      const snapshot=check.ok?await check.json():null;
      if(snapshot?.turn===turn&&snapshot.turnStatus==='interrupted'){
        toast('该轮次已停止');
        if(c.activeTurn===turn&&!c.pending){
          c.activeTurn=null;c.externalWait=null;c.stopping=false;save();
          if(c===current()){composer();messages(false);await refreshCurrentHistory(c,true)}
        }
        return
      }
    }
    if(!res.ok)throw Error(data.error);toast('主机已接收停止请求')
  }catch(e){toast(e.message);c.stopping=false}
  if(c===current())resize()
});
function effortName(value){return Object.hasOwn(effortNames,value)?effortNames[value]:value||''}
function ordinaryEfforts(model){return model?.efforts.filter(e=>Object.hasOwn(effortNames,e)&&e!=='persistent')||[]}
function effortOnModelChange(model,currentEffort){
  const steps=ordinaryEfforts(model);
  const preferred=currentEffort==='persistent'?Object.keys(effortNames).findLast(e=>model.efforts.includes(e)):currentEffort;
  return steps.includes(preferred)?preferred:steps.includes(model.defaultEffort)?model.defaultEffort:steps[0]||null
}
function composerModel(c){
  if(c.selectedForNext&&c.model)return {model:c.model,effort:c.effort};
  const inherited=c.threadConfig||c.effective;
  if(inherited)return inherited;
  if(c.model)return {model:c.model,effort:c.effort};
  return db.projectModelDefaults?.[c.cwd||'']?.defaults||{}
}
function turnModelOptions(c){
  const config=composerModel(c);
  const serviceTier=c.speedChoice?.model===config.model?c.speedChoice?.id||null:null;
  // A resumed thread inherits the host configuration until the user overrides it.
  const override=c.selectedForNext||serviceTier||(!c.threadConfig&&!c.effective&&c.model);
  return {model:override?config.model||null:null,effort:override?config.effort||null:null,serviceTier}
}
function projectCatalog(cwd){
  if(projectCatalogs.has(cwd))return projectCatalogs.get(cwd);
  const cached=db.modelCatalog?.cwd===cwd?db.modelCatalog:undefined;
  const stored=readStoredObject(chatStorage.getItem(catalogPrefix+cwd));
  const hasStored=stored?.cwd===cwd&&Array.isArray(stored.models)&&stored.models.length>0;
  const catalog=hasStored&&(!cached||(stored.updated||0)>=(cached.updated||0))?stored:cached;
  if(!catalog)return;
  projectCatalogs.set(cwd,catalog);
  if(catalog.defaults&&!(db.projectModelDefaults?.[cwd]?.updated>=catalog.updated)){
    (db.projectModelDefaults||={})[cwd]={defaults:catalog.defaults,updated:catalog.updated}
  }
  return catalog
}
function persistProjectCatalog(catalog){
  const name=catalogPrefix+catalog.cwd;
  try{
    const prior=chatStorage.keys().filter(k=>k!==name&&k.startsWith(catalogPrefix));
    if(prior.length>=8){
      const dates=prior.map(k=>[k,readStoredObject(chatStorage.getItem(k))?.updated||0]);
      dates.sort((a,b)=>a[1]-b[1]);
      for(const [old] of dates.slice(0,prior.length-7))chatStorage.removeItem(old)
    }
    chatStorage.setItem(name,JSON.stringify(catalog))
  }catch{/* In-memory catalogs remain usable when browser storage is full. */}
}
function catalogNeedsRefresh(cwd){
  const catalog=projectCatalog(cwd);
  const cutoff=Date.now()-300000;
  return !catalog?.models?.length||!(catalog.updated>cutoff)||
    !(db.projectModelDefaults?.[cwd]?.updated>cutoff)
}
function resumeModelCatalog(event){
  const c=current();
  if(!c||document.hidden||!$('receiver-setup').hidden)return;
  const cwd=c.cwd||'';
  if(event.type==='online')catalogRetryAfter.delete(cwd);
  if(Date.now()<(catalogRetryAfter.get(cwd)||0))return;
  const retry=document.querySelector('dialog.model-menu[open] [data-retry-catalog]');
  if(retry){
    if(catalogNeedsRefresh(cwd))retry.click();
    else void modelPicker(false,$('dialog').classList.contains('model-command-menu'))
  }else if(!catalogRequests.has(cwd)&&catalogNeedsRefresh(cwd))modelLabel(c)
}
window.addEventListener('online',resumeModelCatalog);
document.addEventListener('visibilitychange',resumeModelCatalog);
function fetchModelCatalog(cwd=''){
  if(catalogRequests.has(cwd))return catalogRequests.get(cwd);
  const request=(async()=>{
    const signal=AbortSignal.timeout(45000);
    const res=await deviceFetch('/api/models'+(cwd?'?cwd='+encodeURIComponent(cwd):''),{method:'POST',signal}),fresh=await res.json();
    if(!res.ok||!fresh.models?.length)throw Error(fresh.error||'主机没有返回模型');
    const catalog={cwd,defaults:fresh.defaults,models:fresh.models,recentConfigurations:fresh.recentConfigurations||[],updated:Date.now()};
    projectCatalogs.set(cwd,catalog);persistProjectCatalog(catalog);
    if((current()?.cwd||'')===cwd)db.modelCatalog=catalog;
    const defaults=fresh.defaults;
    if(defaults?.model){
      for(const c of db.chats){
        if((c.cwd||'')!==cwd||!c.selectedForNext||!followsProjectDefault(c))continue;
        c.model=defaults.model;c.effort=defaults.effort||null;
        c.modelName=fresh.models.find(m=>m.id===c.model)?.name||c.model;
        c.pickerChoice={mode:'default',model:c.model,effort:c.effort}
      }
    }
    (db.projectModelDefaults||={})[cwd]={defaults:fresh.defaults,updated:Date.now()};save();
    catalogRetryAfter.delete(cwd);modelLabel(current());return catalog
  })().catch(error=>{
    catalogRetryAfter.set(cwd,Date.now()+30000);
    if(error.name==='TimeoutError')throw Error('等待主机模型目录超时');
    throw error
  })
    .finally(()=>{catalogRequests.delete(cwd)});
  catalogRequests.set(cwd,request);return request
}
function tierIcon(id){return id==='ultrafast'?'speed-ultrafast':id==='priority'?'speed-fast':'speed'}
function displayedSpeed(c,model){
  const id=c.speedChoice?.model===model?.id?c.speedChoice?.id:
    c.thread?c.threadServiceTier:db.projectModelDefaults?.[c.cwd||'']?.defaults?.serviceTier;
  return model?.serviceTiers?.find(tier=>tier.id===id)
}
function modelLabel(c){
  renderContextUsage(c.usage);
  const {model,effort}=composerModel(c);
  const cwd=c.cwd||'';
  const entry=projectCatalog(cwd)?.models?.find(entry=>entry.id===model);
  if(catalogNeedsRefresh(cwd)&&!catalogRequests.has(cwd)&&Date.now()>=(catalogRetryAfter.get(cwd)||0))
    void fetchModelCatalog(cwd).catch(()=>{});
  const name=entry?.name||(c.model===model&&c.modelName)||model;
  const display=name?.replace(/^gpt-6\.2-(astra|sol)$/i,(_,family)=>'GPT-6.2 '+(family.toLowerCase()==='sol'?'Sol':'Astra'))||'主机默认';
  const strength=effortName(effort),label=$('model-label');
  const speed=displayedSpeed(c,entry);
  const signature=JSON.stringify([display,strength,speed?.id,speed?.name]);
  if(signature===renderedModelLabel)return;
  renderedModelLabel=signature;
  label.replaceChildren(element('span','model-trigger-name',display));
  if(strength)label.append(element('span','model-strength',' '+strength));
  if(speed&&speed.id!=='default'){
    const indicator=icon(tierIcon(speed.id));indicator.classList.add('model-speed-icon');label.prepend(indicator)
  }
  const description=[label.textContent,speed?.name].filter(Boolean).join(' · ');
  $('model-picker').title=description;
  $('model-picker').setAttribute('aria-description',description);
  $('model-picker').disabled=false
}
function positionCommandMenu(panel){
  const rect=$('composer').getBoundingClientRect(),view=window.visualViewport;
  const left=view?.offsetLeft||0,top=view?.offsetTop||0,width=view?.width||innerWidth,height=view?.height||innerHeight;
  const aboveGap=8,belowGap=4,viewportMargin=12,minimumHeight=160;
  const visibleTop=top+viewportMargin,visibleBottom=top+height-viewportMargin;
  const aboveEdge=Math.min(rect.top-aboveGap,visibleBottom);
  const belowEdge=Math.max(rect.bottom+belowGap,visibleTop);
  const above=Math.max(0,aboveEdge-Math.max(46+viewportMargin,visibleTop));
  const below=Math.max(0,visibleBottom-belowEdge);
  const down=below>=minimumHeight||below>=above;
  const size=Math.min(rect.width,width-16);
  panel.style.setProperty('--command-x',Math.max(left+8,Math.min(rect.left,left+width-size-8))+'px');
  panel.style.setProperty('--command-width',size+'px');
  panel.style.setProperty('--command-top',down?belowEdge+'px':'auto');
  panel.style.setProperty('--command-bottom',down?'auto':innerHeight-aboveEdge+'px');
  panel.style.setProperty('--command-room',(down?below:above)+'px');
}
function modelViewportConstrained(view){
  return !!view&&(view.scale>1.01||view.height<innerHeight-1||view.width<document.documentElement.clientWidth-1||view.offsetTop>1||view.offsetLeft>1)
}
function positionModelMenu(){
  const dialog=$('dialog');
  if(!dialog.open||!dialog.classList.contains('model-menu'))return;
  if(dialog.classList.contains('model-command-menu')){
    positionCommandMenu(dialog);
    return
  }
  const anchor=$('model-picker').getBoundingClientRect();
  const view=window.visualViewport,zoomed=modelViewportConstrained(view);
  dialog.classList.toggle('model-zoomed',zoomed);
  if(zoomed){
    const left=view.offsetLeft+8,right=view.offsetLeft+view.width-8;
    const top=view.offsetTop+8,bottom=view.offsetTop+view.height-8;
    const edge=Math.max(top,Math.min(anchor.top-6,bottom));
    const below=Math.min(bottom,Math.max(top,anchor.bottom+6));
    const down=edge-top<120&&bottom-below>edge-top;
    dialog.style.setProperty('--zoom-width',Math.max(0,right-left)+'px');
    const menuRight=Math.min(right,Math.max(left+dialog.offsetWidth,anchor.right));
    dialog.style.setProperty('--zoom-right',innerWidth-menuRight+'px');
    dialog.style.setProperty('--zoom-top',down?below+'px':'auto');
    dialog.style.setProperty('--zoom-bottom',down?'auto':innerHeight-edge+'px');
    dialog.style.setProperty('--zoom-room',(down?bottom-below:edge-top)+'px');
    return
  }
  dialog.style.setProperty('--picker-right',Math.max(8,innerWidth-anchor.right)+'px');
  dialog.style.setProperty('--picker-bottom',Math.max(8,innerHeight-anchor.top+6)+'px')
}
function positionSpeedMenu(menu){
  const trigger=menu.parentElement.querySelector('.speed-trigger');
  const view=window.visualViewport;
  const left=(view?.offsetLeft||0)+8,top=(view?.offsetTop||0)+8;
  const width=Math.max(0,(view?.width??innerWidth)-16);
  const height=Math.max(0,(view?.height??innerHeight)-16);
  menu.style.maxWidth=width+'px';menu.style.maxHeight=height+'px';
  const anchor=trigger.getBoundingClientRect(),box=menu.getBoundingClientRect();
  const side=anchor.left-left>=box.width+4?anchor.left-box.width-4:anchor.right+4;
  menu.style.left=Math.max(left,Math.min(side,left+width-box.width))+'px';
  menu.style.top=Math.max(top,Math.min(anchor.top,top+height-box.height))+'px'
}
const modelAnchorSupported=CSS.supports('position-area','top span-left');
function repositionModelMenus(){
  if(mention?.command)positionCommandMenu(mentionBox);
  if(!$('dialog').open||!$('dialog').classList.contains('model-menu'))return;
  if(!modelAnchorSupported||modelViewportConstrained(window.visualViewport)||$('dialog').matches('.model-command-menu,.model-zoomed'))positionModelMenu();
  const speed=$('dialog').querySelector('.speed-flyout');
  if(speed?.matches(':popover-open'))positionSpeedMenu(speed)
}
let modelTransitionFrame=0;
function followLayoutTransition(){
  if(modelTransitionFrame||(!mention?.command&&!$('dialog').open))return;
  modelTransitionFrame=requestAnimationFrame(()=>{
    modelTransitionFrame=0;repositionModelMenus();
    if(document.getAnimations().some(animation=>animation instanceof CSSTransition&&animation.playState==='running'))
      followLayoutTransition()
  })
}
document.addEventListener('transitionrun',followLayoutTransition);
document.addEventListener('transitionend',repositionModelMenus);
function resizeModelMenus(){
  repositionModelMenus();
  const row=document.activeElement;
  if(!row?.matches('dialog.model-menu [role="menuitemradio"]'))return;
  requestAnimationFrame(()=>{
    if(row!==document.activeElement||!row.isConnected)return;
    const menu=row.closest('dialog').getBoundingClientRect(),box=row.getBoundingClientRect();
    if(box.top<menu.top||box.bottom>menu.bottom)row.scrollIntoView({block:'nearest',inline:'nearest'})
  })
}
window.addEventListener('resize',resizeModelMenus);
window.visualViewport?.addEventListener('resize',resizeModelMenus);
window.visualViewport?.addEventListener('scroll',repositionModelMenus);
document.addEventListener('scroll',repositionModelMenus,true);
new ResizeObserver(repositionModelMenus).observe($('composer'));
async function modelPicker(force=false,openList=false){
  const c=current(),dialog=$('dialog');
  const retrying=force&&dialog.open&&dialog.classList.contains('model-menu');
  const body=retrying?$('dialog-body'):modal('模型与推理强度',$('model-picker'));
  const panel=element('div','results'),status=element('p','quiet',('正在读取 '+receiverName+' 的模型目录…'));
  status.setAttribute('role','status');
  if(retrying)body.replaceChildren();
  delete $('model-picker').dataset.view;
  dialog.classList.add('model-menu');dialog.classList.toggle('model-command-menu',openList);$('model-picker').setAttribute('aria-expanded','true');
  positionModelMenu();
  body.append(status,panel);
  try{
    const projectKey=c.cwd||'';
    let data=projectCatalog(projectKey);
    let stale=false;
    let projectDefaults=db.projectModelDefaults?.[projectKey];
    let background;
    if(force||catalogNeedsRefresh(projectKey)){
      if(data?.models?.length&&!force){
        stale=true;background=fetchModelCatalog(projectKey)
      }else{
        data=await fetchModelCatalog(projectKey);projectDefaults=db.projectModelDefaults?.[projectKey]
      }
    }
    if(!body.contains(panel))return;
    function explicitlySelected(modelId){
      if(!modelId)return false;
      if(c.pickerChoice?.model===modelId)return c.pickerChoice.mode==='model';
      return !!projectDefaults?.defaults?.model&&modelId!==projectDefaults.defaults.model
    }
    const recentKey=key+'.recentModels';
    function activeConfiguration(){
      const {model,effort}=composerModel(c);
      return {model,effort:effort||null,tier:c.speedChoice?.model===model?c.speedChoice.id:null}
    }
    function recentConfigurations(){
      try{const rows=JSON.parse(chatStorage.getItem(recentKey)||'[]');return Array.isArray(rows)?rows.filter(row=>typeof row?.model==='string'):[]}catch{return []}
    }
    function sameConfiguration(a,b){return a.model===b.model&&a.effort===b.effort&&a.tier===b.tier}
    function rememberConfiguration(){
      const active=activeConfiguration();
      const recent=recentConfigurations().filter(item=>!sameConfiguration(item,active));
      try{chatStorage.setItem(recentKey,JSON.stringify([active,...recent].slice(0,3)))}catch{storageFull()}
    }
    function finishChoice(model){
      if(openList){closeDialog();promptBox.focus();return}
      simple(model);panel.querySelector('.model-view-toggle')?.focus()
    }
    function resetToDefault(){
      const defaults=projectDefaults?.defaults;
      if(!defaults?.model||stale){toast('请刷新项目配置后再恢复默认模型');return}
      delete c.speedChoice;
      c.pickerChoice={mode:'default',model:defaults.model,effort:defaults.effort||null};c.selectionDuringTurn=c.pending;c.selectedForNext=true;c.model=defaults.model;c.effort=defaults.effort||null;
      c.modelName=data.models.find(m=>m.id===defaults.model)?.name||defaults.model;
      rememberConfiguration();save();modelLabel(c);finishChoice(data.models.find(m=>m.id===defaults.model))
    }
    function startingHeight(switching){
      if(!switching||matchMedia('(prefers-reduced-motion: reduce)').matches)return 0;
      const height=dialog.getBoundingClientRect().height;
      for(const animation of dialog.getAnimations())if(animation.id==='model-view-size')animation.cancel();
      return height
    }
    function resizeView(from){
      if(!from)return;
      const to=dialog.getBoundingClientRect().height;
      if(Math.abs(from-to)<1)return;
      dialog.animate([{height:from+'px'},{height:to+'px'}],{
        id:'model-view-size',duration:320,easing:'cubic-bezier(.19,1,.22,1)'
      })
    }
    function animateViewEntry(node,distance,delay){
      if(!node||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      const timing={delay,fill:'backwards'};
      node.animate([{opacity:0},{opacity:1}],{...timing,duration:200,easing:'cubic-bezier(.23,1,.32,1)'});
      node.animate([{translate:'0 '+distance+'px'},{translate:'0 0'}],{...timing,duration:320,easing:'cubic-bezier(.19,1,.22,1)'})
    }
    function simple(model){
      const fromList=panel.getAttribute('role')==='menu'&&!openList;
      const height=startingHeight(fromList);
      if(fromList)for(const animation of panel.getAnimations())animation.cancel();
      panel.removeAttribute('role');panel.removeAttribute('aria-label');panel.onkeydown=null;panel.replaceChildren();status.textContent='';
      const toggle=btn('选择模型','chevron-down',list,'modal-row model-view-toggle');
      const name=element('span','model-view-name',model?.name||composerModel(c).model||'默认');
      const effort=element('span','model-view-effort');
      toggle.dataset.explicit=String(explicitlySelected(model?.id));
      $('model-picker').dataset.view='simple';
      $('model-picker').querySelector('.model-open-label').textContent=toggle.dataset.explicit==='true'?'选择推理强度':'选择模型';
      toggle.prepend(effort,name);
      const header=element('div','model-view-header');header.append(toggle);panel.append(header);
      if(fromList)animateViewEntry(header,-10,56);
      if(!nativePermissionMode&&model?.serviceTiers?.length){
        const tiers=[{id:'',name:'沿用主机设置'},{id:'default',name:'标准'},...model.serviceTiers.filter(t=>t.id!=='default')];
        const selected=tiers.find(t=>c.speedChoice?.model===model.id&&t.id===c.speedChoice.id)||tiers[0];
        const menu=element('div','speed-flyout');menu.popover='auto';menu.setAttribute('role','menu');menu.setAttribute('aria-label','速度');
        const speed=displayedSpeed(c,model),speedId=selected.id||speed?.id;
        if(!selected.id&&speed)selected.description=speed.name;
        const trigger=btn(['速度',selected.name,selected.description&&!selected.id?selected.description:null].filter(Boolean).join(' · '),tierIcon(speedId),openSpeed,'icon speed-trigger');
        trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
        trigger.dataset.fast=String(!!speedId&&speedId!=='default');
        header.append(trigger,menu);
        function openSpeed(){
          if(menu.matches(':popover-open')){menu.hidePopover();return}
          menu.showPopover();
          positionSpeedMenu(menu);
          menu.querySelector('[aria-checked=true]').focus()
        }
        menu.ontoggle=()=>trigger.setAttribute('aria-expanded',String(menu.matches(':popover-open')));
        for(const tier of tiers){
          const item=element('button','modal-row');item.type='button';item.setAttribute('role','menuitemradio');
          item.setAttribute('aria-label',tier.name);item.setAttribute('aria-checked',String(tier===selected));
          const label=element('span','',tier.name);item.append(label);
          if(tier.description){label.append(element('span','model-default-description',tier.description));item.setAttribute('aria-description',tier.description)}
          if(tier===selected)item.append(icon('check'));
          item.onclick=()=>{
            if(tier.id){
              c.speedChoice={model:model.id,id:tier.id};
              c.effort=composerModel(c).effort||model.defaultEffort;c.model=model.id;c.modelName=model.name;
              c.selectedForNext=true;c.selectionDuringTurn=c.pending
            }else delete c.speedChoice;
            menu.hidePopover();rememberConfiguration();save();modelLabel(c);simple(model);panel.querySelector('.speed-trigger').focus()
          };
          menu.append(item)
        }
        trigger.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();openSpeed()}};
        menu.onkeydown=e=>{
          const options=Array.from(menu.children),i=options.indexOf(document.activeElement);
          if(e.key==='Escape'||e.key==='ArrowLeft'){e.preventDefault();e.stopPropagation();menu.hidePopover();trigger.focus();return}
          const next={ArrowDown:(i+1)%options.length,ArrowUp:(i+options.length-1)%options.length,Home:0,End:options.length-1}[e.key];
          if(next!==undefined){e.preventDefault();options[next].focus()}
        }
      }
      if(explicitlySelected(model?.id)&&projectDefaults?.defaults?.model){
        const reset=btn('重置为默认','reset-model',resetToDefault,'icon model-reset');
        reset.dataset.projectDefault='';reset.disabled=stale;header.append(reset)
      }
      const steps=ordinaryEfforts(model);
      if(!steps.length){resizeView(height);return}
      const currentEffort=composerModel(c).effort||model.defaultEffort;
      const selected=steps.indexOf(steps.includes(currentEffort)?currentEffort:'medium');
      const slider=element('input','effort-slider');
      slider.type='range';slider.id='effort-slider';slider.min=0;slider.max=steps.length-1;slider.step=1;slider.value=String(Math.max(0,selected));
      slider.setAttribute('aria-label','强度');
      const control=element('div','effort-control'),ticks=element('div','effort-ticks'),hint=element('span','effort-hint');
      ticks.setAttribute('aria-hidden','true');for(const step of steps)ticks.append(element('i'));
      const usageReminder=element('p','effort-usage-reminder','使用额度消耗更快');
      hint.id='effort-hint';hint.textContent='使用左右方向键调整强度';
      slider.setAttribute('aria-describedby',hint.id);slider.setAttribute('aria-keyshortcuts','ArrowLeft ArrowRight');
      slider.onkeydown=event=>{
        if(event.key!=='Enter'||event.isComposing)return;
        event.preventDefault();event.stopPropagation();closeDialog();
        $('model-picker').focus()
      };
      slider.disabled=steps.length<2;
      function update(){
        const index=Number(slider.value),name=effortName(steps[index]);
        const fraction=index/Math.max(1,steps.length-1);
        ticks.style.setProperty('--selected-width','calc('+fraction*100+'% + '+(14-28*fraction)+'px)');
        Array.from(ticks.children).forEach((tick,i)=>{tick.dataset.selected=String(i<=index)});
        usageReminder.hidden=steps[index]!=='ultra'||slider.disabled;
        slider.setAttribute('aria-valuetext',name+'，第 '+(index+1)+' 项，共 '+steps.length+' 项。'+(usageReminder.hidden?'':usageReminder.textContent));
        effort.textContent=name;toggle.title='选择模型 · '+model.name+' · '+name
      }
      let committed=slider.value;
      slider.oninput=update;
      slider.onpointercancel=()=>{slider.value=committed;update()};
      slider.onchange=()=>{
        if(slider.value===committed)return;
        committed=slider.value;update();
        c.selectionDuringTurn=c.pending;c.selectedForNext=true;c.model=model.id;
        c.modelName=model.name;c.effort=steps[Number(committed)];rememberConfiguration();save();modelLabel(c)
      };
      update();control.append(ticks,slider);panel.append(control,hint,usageReminder);
      if(fromList)animateViewEntry(control,-10,40);
      resizeView(height)
    }
    function list(){
      $('model-picker').dataset.view='list';
      const fromSlider=!!panel.querySelector('.model-view-header')&&!openList;
      const height=startingHeight(fromSlider);
      panel.replaceChildren();status.textContent='选择模型';
      const config=composerModel(c),selected=config.model,defaults=projectDefaults?.defaults;
      const matchesDefault=!!defaults?.model&&selected===defaults.model&&!explicitlySelected(selected);
      panel.setAttribute('role','menu');panel.setAttribute('aria-label','选择模型');
      function option(name,run,checked,description,retirementAt){
        const button=element('button','modal-row');button.type='button';button.setAttribute('aria-label',name);
        button.onclick=()=>{
          if(!checked){run();return}
          finishChoice(data.models.find(model=>model.id===selected))
        };
        const label=element('span','model-option-label');
        const title=element('span','model-option-name',name);
        title.title=name;label.append(title);
        button.append(label);if(checked&&!openList)button.append(icon('check'));
        const end=Number.isSafeInteger(retirementAt)?new Date(retirementAt*1000):null;
        const retirement=end&&Number.isFinite(end.getTime())?'将于'+end.toLocaleDateString('zh-CN',{month:'long',day:'numeric',timeZone:'UTC'})+'下线':'';
        if(retirement||description){
          label.append(element('span','model-default-description',retirement||description));
          button.setAttribute('aria-description',[retirement,description].filter(Boolean).join(' · '));
          if(retirement&&description)button.title=description
        }
        button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(checked));
        panel.append(button);return button
      }
      const defaultDescription=defaults?.model?'项目默认 · '+(data.models.find(m=>m.id===defaults.model)?.name||defaults.model):'';
      const reset=option('默认',resetToDefault,matchesDefault,defaultDescription);
      reset.dataset.projectDefault='';
      if(matchesDefault&&(config.effort!==defaults?.effort||c.speedChoice))reset.onclick=resetToDefault;
      reset.disabled=stale||!defaults?.model;
      function choose(model,effort,tier){
        if(tier)c.speedChoice={model:model.id,id:tier};else delete c.speedChoice;
        c.effort=effort;c.pickerChoice={mode:'model',model:model.id};
        c.selectionDuringTurn=c.pending;c.selectedForNext=true;c.model=model.id;c.modelName=model.name;
        rememberConfiguration();save();modelLabel(c);finishChoice(model)
      }
      if(openList){
        reset.remove();
        const active=activeConfiguration(),shown=[];
        const fallback=data.models.filter(m=>m.id!==active.model).map(m=>({model:m.id,effort:m.defaultEffort,tier:null}));
        for(const cfg of [...recentConfigurations(),...(data.recentConfigurations||[]),active,...fallback]){
          const model=data.models.find(m=>m.id===cfg.model);
          if(!model||(nativePermissionMode&&cfg.tier)||(cfg.effort&&!model.efforts.includes(cfg.effort))||
             (cfg.tier&&cfg.tier!=='default'&&!model.serviceTiers?.some(t=>t.id===cfg.tier))||
             shown.some(other=>sameConfiguration(other,cfg)))continue;
          shown.push(cfg);
          const tierName=cfg.tier==='default'?'标准':model.serviceTiers?.find(t=>t.id===cfg.tier)?.name;
          const description=effortName(cfg.effort);
          const item=option(model.name,()=>choose(model,cfg.effort,cfg.tier),sameConfiguration(cfg,active),description);
          item.dataset.recent='';item.prepend(element('kbd','recent-key',String(shown.length)));
          if(tierName){
            item.append(element('small','recent-tier',tierName));
            item.setAttribute('aria-description',[description,tierName].filter(Boolean).join(' · '))
          }
          if(shown.length===3)break
        }
      }
      for(const model of data.models){
        const item=option(model.name,()=>{
          const active=activeConfiguration();
          choose(model,effortOnModelChange(model,active.effort),active.model===model.id?active.tier:null)
        },!matchesDefault&&model.id===selected,model.description,model.retirementAt);
        item.dataset.modelId=model.id
      }
      const visibleOptions=()=>Array.from(panel.querySelectorAll('button:enabled:not([hidden])'));
      const enabled=visibleOptions();
      let search;
      if(openList){
        search=element('input','model-command-search');search.type='text';
        search.placeholder='搜索模型';search.setAttribute('aria-label','搜索模型');
        const summary=element('span','model-command-summary');summary.setAttribute('role','status');
        status.replaceChildren(search,summary);
        search.oninput=()=>{
          const terms=search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
          let count=0;
          for(const row of panel.children){
            const label=[row.getAttribute('aria-label'),row.dataset.modelId||''].join(' ').toLowerCase();
            row.hidden=terms.length?row.hasAttribute('data-recent')||!terms.every(term=>label.includes(term)):!row.hasAttribute('data-recent');
            if(!row.hidden)count++
          }
          summary.textContent=terms.length?(count?'匹配的模型':'没有匹配的模型'):'最近使用的模型'
        };
        search.onkeydown=e=>{
          if(isCompositionKey(e))return;
          const rows=visibleOptions();
          if(!search.value&&!e.repeat&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&/^[1-3]$/.test(e.key)){
            const shortcut=rows[Number(e.key)-1];
            if(shortcut){e.preventDefault();shortcut.click();return}
          }
          if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='Enter'){
            e.preventDefault();const row=e.key==='ArrowUp'?rows.at(-1):rows[0];
            if(e.key==='Enter')row?.click();else row?.focus()
          }
        };
        search.oninput();search.focus()
      }else {
        (enabled.find(item=>item.getAttribute('aria-checked')==='true')||enabled[0])?.focus();
        if(fromSlider)animateViewEntry(panel,10,40);
        resizeView(height)
      }
      panel.onkeydown=e=>{
        const enabled=visibleOptions();
        const i=enabled.indexOf(document.activeElement);
        if(i<0)return;
        if(search&&((i===0&&(e.key==='ArrowUp'||(e.key==='Tab'&&e.shiftKey)))||(i===enabled.length-1&&e.key==='Tab'&&!e.shiftKey))){
          e.preventDefault();search.focus();return
        }
        const forward=(i+1)%enabled.length,backward=(i+enabled.length-1)%enabled.length;
        const next={ArrowDown:forward,ArrowUp:backward,Tab:e.shiftKey?backward:forward,Home:0,End:enabled.length-1}[e.key];
        if(next!==undefined){
          e.preventDefault();e.stopPropagation();
          for(const motion of dialog.getAnimations())if(motion.id==='model-view-size')motion.finish();
          for(const motion of panel.getAnimations())motion.finish();
          enabled[next].focus();
          enabled[next].scrollIntoView({block:'nearest',inline:'nearest'})
        }
      }

    }
    function showCurrent(){
      const selected=composerModel(c).model;
      simple(selected?data.models.find(m=>m.id===selected):data.models.find(m=>m.isDefault));
      if(dialog.open){
        const initial=panel.querySelector('.effort-slider:enabled')||panel.querySelector('.model-view-toggle');
        initial?.focus({preventScroll:true})
      }
    }
    if(openList)list();else showCurrent();
    if(background){
      const note=element('p','quiet','正在更新主机模型目录…');note.setAttribute('role','status');panel.after(note);
      let interacted=false;
      const track=()=>{interacted=true};
      for(const type of ['pointerdown','keydown','focusin','input'])body.addEventListener(type,track,true);
      async function refresh(request,manual=false){
        try{
          const fresh=await request;
          if(!dialog.open||!body.contains(panel))return;
          const defaults=db.projectModelDefaults?.[projectKey];
          const editing=panel.contains(document.activeElement)||status.contains(document.activeElement);
          if(!interacted||(manual&&!editing)){
            const query=status.querySelector('.model-command-search')?.value;
            const listing=$('model-picker').dataset.view==='list';
            data=fresh;projectDefaults=defaults;stale=false;
            if(listing||openList){
              list();
              if(query){
                const field=status.querySelector('.model-command-search');
                field.value=query;field.dispatchEvent(new Event('input'))
              }
            }else showCurrent();
            note.remove()
          }else{
            const changed=JSON.stringify([data.models,data.recentConfigurations,projectDefaults?.defaults])!==JSON.stringify([fresh.models,fresh.recentConfigurations,defaults?.defaults]);
            if(changed)note.textContent='主机目录已更新，重新打开可查看。';
            else{stale=false;note.remove();const reset=panel.querySelector('[data-project-default]');if(reset)reset.disabled=!defaults?.defaults?.model}
          }
        }catch{
          if(!dialog.open||!body.contains(panel))return;
          note.textContent='主机目录暂时无法更新，显示上次读取的模型。';
          const retry=element('button','mode','重试更新');retry.type='button';retry.dataset.retryCatalog='';
          retry.onclick=event=>{
            if(retry.disabled)return;
            interacted=true;retry.disabled=true;retry.textContent='正在更新…';
            void refresh(fetchModelCatalog(projectKey),event.isTrusted)
          };
          note.append(retry)
        }
      }
      try{await refresh(background)}
      finally{for(const type of ['pointerdown','keydown','focusin','input'])body.removeEventListener(type,track,true)}
    }
  }catch(e){
    if(!dialog.open||!body.contains(panel))return;
    status.textContent='无法加载模型：'+e.message;
    const retry=row('重试加载模型','server',()=>modelPicker(true,openList));
    retry.dataset.retryCatalog='';
    panel.append(retry);retry.focus({preventScroll:true})
  }
}

const permissionNames=new Map([['read-only','只读'],['workspace-write','工作区写入'],['danger-full-access','完全访问']]);
function supportsNativePermission(c){
  return c.sandbox==='remote-workspace'||c.sandbox==='danger-full-access'&&c.approvalPolicy!=='untrusted'
}
function updatePermissionLabel(c){
  const next=nativePermissionMode&&!supportsNativePermission(c)?'选择任务权限':c.sandbox==='remote-workspace'?'工作区写入（按需审批）':permissionNames.get(c.sandbox)||'只读';
  const running=!!(c.pending||c.activeTurn),label=$('sandbox-label');
  const visible=running?'下轮 · '+next:next;
  label.classList.toggle('full-access',c.sandbox==='danger-full-access');
  if(label.textContent!==visible)label.textContent=visible;
  const hint='下一轮权限 · '+next;
  if(label.parentElement.title!==hint)label.parentElement.title=hint;
  const report=$('active-turn-policy');
  if(!report)return;
  const turn=c.pending?c.turn:c.activeTurn;
  const policy=turn&&c.permissions?.turn===turn?c.permissions.requested:null;
  const sandbox=policy?.sandboxPolicy?.type;
  const currentMode=({workspaceWrite:'工作区写入',readOnly:'只读',dangerFullAccess:'完全访问'})[sandbox]||sandbox;
  const text=!running?'':currentMode?'当前轮次已启动 · '+currentMode+' / '+policy.approvalPolicy:'当前轮次权限尚未回报';
  if(report.textContent!==text)report.textContent=text;
  if(report.hidden!==!running)report.hidden=!running
}
async function permissionView(beforeSend=false){
  const c=current(),body=modal('任务权限',document.querySelector('#composer [data-action=permissions]'));
  if(menuAnchor)$('dialog').classList.add('composer-menu');
  const activeReport=element('p','quiet');activeReport.id='active-turn-policy';activeReport.setAttribute('role','status');
  body.append(activeReport,element('div','preference-label','下一轮权限'));updatePermissionLabel(c);
  const selected=c.sandbox||'read-only';
  const loading=element('p','quiet','正在读取主机权限…');body.append(loading);
  let native;
  try{native=await nativePermissions()}catch(error){
    if(body.contains(loading))loading.textContent=error.message;
    return
  }
  if(!body.contains(loading)||!$('dialog').open||current()!==c)return;
  loading.remove();
  if(native){
    if(beforeSend)body.append(element('p','quiet','请为这台主机选择任务权限，再发送草稿。'));
    for(const [mode,label] of [['remote-workspace','工作区写入（按需审批）'],['danger-full-access','完全访问']]){
      const checked=selected===mode&&(mode==='remote-workspace'||c.approvalPolicy!=='untrusted');
      const pick=row(label,'shield',()=>{
        c.sandbox=mode;c.approvalPolicy='never';save();closeDialog();composer()
      },checked?'✓':'');
      pick.setAttribute('aria-pressed',String(checked));body.append(pick)
    }
    return
  }
  for(const [mode,label] of permissionNames){
    const pick=row(label,'shield',async()=>{
      if(mode==='danger-full-access'){
        try{
          const response=await deviceFetch('/api/capabilities');
          if(!response.ok||!(await response.json()).fullAccess)throw Error('当前接收端版本不支持完全访问');
        }catch(e){if(body.contains(activeReport)&&$('dialog').open)toast(e.message);return}
        if(current()!==c||!$('dialog').open||!body.contains(activeReport))return;
      }
      c.sandbox=mode;save();closeDialog();composer()
    },selected===mode?'✓':'');
    pick.setAttribute('aria-pressed',String(selected===mode));body.append(pick)
  }
  const ask=c.approvalPolicy==='untrusted';
  body.append(row('命令与文件审批','shield',async()=>{
    try{
      const r=await deviceFetch('/api/capabilities');
      if(!r.ok||!(await r.json()).commandApproval)throw Error('当前接收端版本不支持命令审批');
      if(current()!==c||!$('dialog').open||!body.contains(activeReport))return;
      c.approvalPolicy=ask?'never':'untrusted';save();permissionView()
    }catch(e){toast(e.message)}
  },ask?'询问':'关闭'));
  body.append(element('p','quiet','设置从下一轮生效。启用审批后，主机会对需要确认的命令或文件修改发出请求。'));
  if(c.permissions?.requested){
    const policy=c.permissions.requested;
    if(!(c.pending||c.activeTurn)||c.permissions.turn!==(c.pending?c.turn:c.activeTurn))
      body.append(element('p','quiet','最近已启动轮次 · '+policy.sandboxPolicy.type+' / '+policy.approvalPolicy));
    if(c.permissions.threadSandbox&&typeof c.permissions.threadApproval==='string')
      body.append(element('p','quiet','主机报告的会话设置 · '+c.permissions.threadSandbox+' / '+c.permissions.threadApproval))
  }
}
function contextRemaining(usage){
  if(!Number.isFinite(usage?.total)||usage.total<0||!Number.isFinite(usage.contextWindow)||usage.contextWindow<=0)return null;
  return 100-100*(Math.min(usage.total,usage.contextWindow)/usage.contextWindow)
}
function renderContextUsage(u){
  const button=$('usage-button'),remaining=contextRemaining(u);
  button.hidden=!u;
  button.toggleAttribute('data-measured',remaining!==null);
  button.style.setProperty('--context-used',(remaining===null?0:100-remaining)+'%');
  const summary=remaining===null?'查看上下文用量':'上下文剩余 '+Math.round(remaining)+'%';
  button.title=summary;button.setAttribute('aria-description',summary);
  const detail=$('context-usage-detail');
  if(!detail||!$('dialog').open)return;
  const rows=[];
  if(remaining!==null){
    const used=Math.min(u.total,u.contextWindow).toLocaleString('zh-CN');
    rows.push(summary+'（已用 '+used+' / '+u.contextWindow.toLocaleString('zh-CN')+' tokens）')
  }
  for(const [label,value] of [['最近一次输入',u?.input],['最近一次输出',u?.output],['模型上下文上限',u?.contextWindow]]){
    if(Number.isFinite(value))rows.push(label+'：'+value.toLocaleString('zh-CN')+' tokens')
  }
  if(!rows.length)rows.push('主机尚未返回上下文用量');
  if(detail.textContent!==rows.join(''))detail.replaceChildren(...rows.map(text=>element('p','',text)))
}
function usageView(){
  const u=current().usage;if(!u)return;
  const detail=element('div');detail.id='context-usage-detail';modal('上下文用量').append(detail);
  renderContextUsage(u)
}

function renameChat(c){
  const body=modal('重命名聊天'),field=element('input','field'),status=element('p','quiet');
  $('dialog').classList.add('rename-dialog');
  const cancel=element('button','','取消'),actions=element('div','rename-actions');
  cancel.type='button';cancel.onclick=closeDialog;
  field.value=c.title;field.maxLength=120;field.placeholder='添加标题…';field.setAttribute('aria-label','聊天标题');
  const submit=element('button','','保存');submit.type='button';
  submit.onclick=async()=>{
    const name=field.value.trim();if(!name||submit.disabled)return;
    submit.disabled=true;field.disabled=true;cancel.disabled=true;
    try{
      if(c.thread){
        status.textContent=('正在同步到 '+receiverName+'…');
        const res=await deviceFetch('/api/thread-name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:c.thread,name})});
        const record=await res.json();if(!res.ok)throw Error(record.error||'重命名失败');c.title=record.name;
        for(const list of [db.chats,db.hostIndex,db.pinnedThreads]){const copy=list?.find(item=>item.thread===c.thread);if(copy)copy.title=record.name}
      }else if(c.parent||c.pending){throw Error('请从“主机会话”打开此任务后重命名。')}
      else{c.title=name}
      save();renderSidebarHistory();if(body.contains(field))closeDialog();if(current()===c)messages(false)
    }catch(e){status.textContent=e.message;submit.disabled=false;field.disabled=false;cancel.disabled=false}
  };
  field.onkeydown=e=>{if(e.key==='Enter'&&!isCompositionKey(e))submit.click()};
  status.setAttribute('role','status');actions.append(cancel,submit);
  body.append(element('p','quiet','保持简短且易于识别'),field,status,actions);
  field.oninput=()=>{submit.disabled=!field.value.trim()};field.oninput();field.focus();field.select()
}

const loadedVersion=document.querySelector('meta[name="client-version"]')?.content;
let checkingClientVersion=false;
async function checkClientVersion(){
  if(!loadedVersion||document.visibilityState!=='visible'||checkingClientVersion||!$('client-update').hidden)return;
  checkingClientVersion=true;
  try{
    const res=await deviceFetch('/api/client-version',{cache:'no-store'});
    if(!res.ok)return;
    const {version}=await res.json();
    if(/^[a-f0-9]{16}$/.test(version)&&version!==loadedVersion)$('client-update').hidden=false
  }catch{/* Check again when the local receiver is available. */}
  finally{checkingClientVersion=false}
}
$('client-update').querySelector('button').onclick=()=>location.reload();
document.addEventListener('visibilitychange',checkClientVersion);
window.addEventListener('pageshow',e=>{if(e.persisted)void checkClientVersion()});
setInterval(checkClientVersion,60000);

{
  const symbol=document.querySelector('.home-symbol'),motion=symbol.querySelector('.home-motion');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let spin=null,rotation=0;
  symbol.addEventListener('pointerenter',event=>{
    if(event.pointerType==='touch'||reduced.matches||symbol.dataset.motion)return;
    const name=Math.random()<.5?'hello':'loader',frames=name==='hello'?373:721,start=performance.now();
    symbol.dataset.motion=name;
    function draw(now){
      const frame=Math.max(0,Math.floor((now-start)*.03));
      if(frame*2>=frames||reduced.matches||!symbol.getClientRects().length){delete symbol.dataset.motion;return}
      motion.style.maskPosition=(-56*(frame%16))+'px '+(-56*Math.floor(frame/16))+'px';
      requestAnimationFrame(draw)
    }
    draw(start)
  });
  symbol.addEventListener('pointerup',event=>{
    if(event.button!==0||reduced.matches)return;
    const from=getComputedStyle(symbol).transform;
    spin?.cancel();rotation-=360;
    spin=symbol.animate([{transform:from==='none'?'rotate(0deg)':from},
      {transform:'rotate('+rotation+'deg) scale(1.18)',offset:.65},
      {transform:'rotate('+rotation+'deg)'}],{duration:550,easing:'ease-out'});
    rotation%=360
  })
}

theme();$('layout').classList.toggle('collapsed',!!db.collapsed);
if(location.hash==='#new-window'){
  browserHistory.replaceState(null,'',location.pathname+location.search);
  const chat=newChat();db.chats.push(chat);select(chat);$('prompt').focus()
}else {
  void openCachedChat(db.chats.find(chat=>chat.id===deviceHistoryEntry(browserHistory.state)?.id)||current()||db.chats[0],true)
}
restoreDestination(deviceHistoryEntry(browserHistory.state)?.destination);
for(const c of db.chats)if(c.pending)void poll(c);
void refreshSidebar();
syncDirectoryEvents();
document.addEventListener('visibilitychange',syncDirectoryEvents);
setInterval(checkDirectoryHead,30000);
document.addEventListener('visibilitychange',checkDirectoryHead);
window.addEventListener('focus',checkDirectoryHead);
setTimeout(checkForegroundTurn,12000);
