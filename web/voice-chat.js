(()=>{
  const button=$('voice-chat'),send=$('send');
  let active=null,available=false;
  const mute=document.createElement('button');
  mute.type='button';mute.id='voice-mute';mute.className='icon';mute.hidden=true;
  mute.append(icon('mic'));$('dictate').after(mute);
  mute.onclick=()=>{
    if(!active?.stream)return;
    active.muted=!active.muted;
    for(const track of active.stream.getAudioTracks())track.enabled=!active.muted;
    render()
  };
  const captions=document.createElement('section');
  captions.id='voice-captions';captions.hidden=true;captions.setAttribute('aria-label','通话字幕');
  $('composer').before(captions);
  function addCaption(session,event){
    if(active!==session)return;
    let message;
    try{message=JSON.parse(event.data)}catch{return}
    const role=message?.type==='input_transcript.added'?'你':message?.type==='output_transcript.added'?'Codex':null;
    const item=message?.item;
    if(!role||typeof item?.text!=='string'||!item.text||typeof item.id!=='string'||session.seen.has(item.id))return;
    session.seen.add(item.id);
    if(session.seen.size>512)session.seen.delete(session.seen.values().next().value);
    if(session.speaker!==role){
      session.speaker=role;
      const line=document.createElement('div'),label=document.createElement('strong');
      label.textContent=role;session.line=document.createElement('span');line.append(label,session.line);
      captions.append(line);if(captions.children.length>2)captions.firstElementChild.remove()
    }
    session.line.append(document.createTextNode(item.text));
    if(session.line.textContent.length>2048)session.line.textContent=session.line.textContent.slice(-2048);
    captions.hidden=false;captions.scrollTop=captions.scrollHeight
  }
  function render(){
    const c=current();
    const empty=!$('prompt').value.trim()&&!c.files.length&&!readingFiles.get(c);
    const idle=available&&!c.historyMissing&&!c.archived&&!c.pending&&!c.activeTurn&&$('receiver-setup').hidden&&empty;
    button.hidden=!active&&!idle;
    $('dictate').hidden=!!active;mute.hidden=!active;mute.disabled=!active?.stream;
    mute.setAttribute('aria-pressed',String(!!active?.muted));
    mute.setAttribute('aria-label','通话麦克风静音');
    mute.title=active?.muted?'取消麦克风静音':'将麦克风静音';
    send.hidden=!button.hidden&&empty&&!c.pending&&!c.activeTurn;
    button.setAttribute('aria-pressed',String(!!active));
    button.title=button.ariaLabel=active?(active.connected?'结束语音聊天':'取消语音连接'):'开始语音聊天'
  }
  window.updateVoiceControl=render;
  $('composer').addEventListener('submit',e=>{
    if(active&&!active.thread){e.preventDefault();e.stopImmediatePropagation();toast('正在创建语音聊天')}
  },true);
  async function request(action,session,extra={},signal){
    const response=await deviceFetch('/api/voice/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:session.id,...extra}),signal});
    const data=await response.json();
    if(!response.ok)throw Error(data.error||'语音连接失败');
    return data
  }
  function stop(s){
    if(active!==s)return;
    active=null;captions.hidden=true;captions.replaceChildren();s.abort.abort();clearTimeout(s.renew);clearTimeout(s.leaseTimer);clearTimeout(s.connectTimer);
    s.stream?.getTracks().forEach(t=>t.stop());s.pc?.close();s.player?.remove();render();
    if(s.submitted)void request('stop',s,{},AbortSignal.timeout(20000)).catch(()=>{})
  }
  function resetLeaseTimer(s){
    clearTimeout(s.leaseTimer);
    s.leaseTimer=setTimeout(()=>{
      if(active===s){stop(s);toast('语音连接已中断')}
    },40000)
  }
  async function renew(s){
    if(active!==s)return;
    try{
      await request('heartbeat',s,{},s.abort.signal);
      if(active===s)resetLeaseTimer(s)
    }catch{/* Retry until the last confirmed lease expires. */}
    if(active===s)s.renew=setTimeout(()=>renew(s),8000)
  }
  button.onclick=async()=>{
    if(active){stop(active);return}
    const s={seen:new Set(),id:crypto.randomUUID(),chat:current().id,thread:current().thread,abort:new AbortController()};
    const c=current();
    const setup=s.thread?null:{cwd:c.cwd||null,projectId:c.projectId||null,sandbox:c.sandbox||'read-only',approvalPolicy:c.approvalPolicy||'never',...turnModelOptions(c)};
    document.dispatchEvent(new Event('voice-chat-starting'));
    active=s;render();
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(active!==s){stream.getTracks().forEach(t=>t.stop());return}
      s.stream=stream;render();
      s.connectTimer=setTimeout(()=>{if(active===s){stop(s);toast('语音连接超时')}},90000);
      const pc=s.pc=new RTCPeerConnection();
      stream.getTracks().forEach(t=>pc.addTrack(t,stream));
      const player=s.player=document.createElement('audio');player.autoplay=true;player.hidden=true;document.body.append(player);
      pc.ontrack=e=>{player.srcObject=new MediaStream([e.track]);void player.play().catch(()=>{if(active===s){stop(s);toast('无法播放语音回复')}})};
      const channel=pc.createDataChannel('oai-events');
      channel.onmessage=e=>addCaption(s,e);
      channel.onopen=()=>{if(active===s){s.connected=true;clearTimeout(s.connectTimer);render()}};
      channel.onclose=()=>{if(active===s)stop(s)};
      pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'&&active===s){stop(s);toast('语音连接已中断')}};
      await pc.setLocalDescription(await pc.createOffer());
      if(active!==s)return;
      s.submitted=true;
      await request('start',s,{thread:s.thread||null,setup,sdp:pc.localDescription.sdp},s.abort.signal);
      if(active!==s)return;
      resetLeaseTimer(s);
      void renew(s);
      while(active===s){
        const state=await request('status',s,{},s.abort.signal);
        if(active!==s)return;
        if(!s.thread&&state.thread){
          s.thread=state.thread;c.thread=state.thread;save();renderSidebarHistory();composer();messages()
        }
        if(state.state==='ready'){await pc.setRemoteDescription({type:'answer',sdp:state.sdp});return}
        if(state.state==='closed'||state.state==='failed')throw Error(state.error||'主机已结束语音聊天');
        await new Promise(r=>setTimeout(r,600))
      }
    }catch(e){
      if(active!==s)return;
      const captureErrors={
        NotAllowedError:'麦克风权限未开启',
        NotFoundError:'未找到麦克风，请检查设备连接',
        NotReadableError:'无法启动麦克风，请检查录音设备后重试'
      };
      const message=(!s.stream&&captureErrors[e.name])||e.message;
      stop(s);toast(message)
    }
  };
  document.addEventListener('chat-selected',e=>{if(active&&e.detail!==active.chat)stop(active)});
  window.addEventListener('pagehide',()=>{if(active)stop(active)});
  if(window.RTCPeerConnection&&navigator.mediaDevices?.getUserMedia)
    deviceFetch('/api/capabilities').then(r=>r.json()).then(v=>{available=v.voiceChat===true;render()}).catch(()=>{});
})();
