(()=>{
  interface Session {
    chat: string; before: string; start: number; end: number;
    parts: Float32Array[]; samples: number; abort: AbortController;
    edit?: { value: string; start: number; end: number; type: string } | null;
    stream?: MediaStream; ctx?: AudioContext; node?: AudioWorkletNode;
    limit?: number; recognition?: LocalRecognition; deferredText?: string;
    finishing?: boolean; cancelled?: boolean;
  }
  const button=document.querySelector<HTMLButtonElement>('#dictate')!;
  const prompt=document.querySelector<HTMLTextAreaElement>('#prompt')!;
  const errorMessage=(error: unknown)=>error instanceof Error?error.message:String(error);
  const cancelButton=document.createElement('button');
  cancelButton.type='button';cancelButton.className='mode';cancelButton.hidden=true;
  cancelButton.textContent='取消';cancelButton.setAttribute('aria-label','取消听写');
  cancelButton.onclick=()=>cancel();button.before(cancelButton);
  let active: Session|null=null;
  // Keep the original dictation target aligned with edits elsewhere in the draft.
  function trackEdit(s: Session){
    const next=prompt.value,old=s.before;
    const edit=s.edit;s.edit=null;
    if(next===old)return;
    let left=0,right=0;
    while(left<Math.min(old.length,next.length)&&old[left]===next[left])left++;
    while(right<Math.min(old.length,next.length)-left&&old[old.length-1-right]===next[next.length-1-right])right++;
    if(edit?.value===old){
      let {start,end}=edit;
      if(start===end&&edit.type==='deleteContentBackward')start+=next.length-old.length;
      if(start===end&&edit.type==='deleteContentForward')end+=old.length-next.length;
      const tail=old.length-end;
      if(start>=0&&end<=old.length&&next.length>=start+tail&&
         next.startsWith(old.slice(0,start))&&next.endsWith(old.slice(end))){
        left=start;right=tail
      }
    }
    if(old.length-right<=s.start){
      const delta=next.length-old.length;s.start+=delta;s.end+=delta
    }else if(left<s.end){
      // A manual edit replaced part of the target. Preserve it and insert after the edit.
      s.start=s.end=next.length-right
    }
    s.before=next
  }
  prompt.addEventListener('beforeinput',event=>{
    if(active)active.edit={value:prompt.value,start:prompt.selectionStart,end:prompt.selectionEnd,type:event.inputType}
  });
  prompt.addEventListener('input',()=>{if(active)trackEdit(active)});
  function release(s: Session){
    clearTimeout(s.limit);s.stream?.getTracks().forEach(track=>track.stop());
    s.node?.disconnect();if(s.ctx&&s.ctx.state!=='closed')void s.ctx.close().catch(()=>{})
  }
  function reset(s: Session){
    release(s);if(active!==s)return;
    active=null;button.disabled=false;button.setAttribute('aria-pressed','false');
    cancelButton.hidden=true;
    button.setAttribute('aria-label','中文听写');button.title='中文听写（本机离线识别）'
  }
  function cancel(){if(active){active.cancelled=true;active.abort.abort();const previous=active;reset(previous);previous.recognition?.abort()}}
  function wave(parts: Float32Array[],n: number){
    const buffer=new ArrayBuffer(44+2*n),view=new DataView(buffer);
    const tag=(p: number,text: string)=>Array.from(text,(v,i)=>view.setUint8(p+i,v.charCodeAt(0)));
    tag(0,'RIFF');view.setUint32(4,36+n*2,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);
    view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);
    view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
    tag(36,'data');view.setUint32(40,n*2,true);let i=44;
    for(const chunk of parts)for(const f of chunk){view.setInt16(i,Math.max(-1,Math.min(1,f))*32767,true);i+=2}
    return buffer
  }
  async function finish(s: Session){
    if(active!==s||s.finishing)return;s.finishing=true;release(s);button.disabled=true;
    try{
      if(!s.samples)throw Error('没有录到声音');
      const r=await deviceFetch('/api/dictation',{method:'POST',headers:{'Content-Type':'audio/wav'},body:wave(s.parts,s.samples),signal:s.abort.signal});
      const data=await r.json();if(!r.ok)throw Error(data.error);if(active!==s)return;
      if(typeof data.text!=='string'||!data.text)throw Error('未识别到文字');
      completeText(s,data.text)
    }catch(e){if(!s.cancelled)toast(errorMessage(e));reset(s)}
  }
  function completeText(s: Session,text: string){
    if(active!==s)return;
    if(composingPrompt){clearTimeout(s.limit);s.deferredText=text;return}
    try{insertText(s,text)}finally{reset(s)}
  }
  prompt.addEventListener('compositionend',()=>{
    const s=active;
    const text=s?.deferredText;
    if(s&&text)setTimeout(()=>completeText(s,text),0)
  });
  function insertText(s: Session,text: string){
      const c=current();if(active!==s||c.id!==s.chat)return;
      trackEdit(s);
      const {start,end}=s;
      if(window.ReceiverKeyboard&&document.activeElement!==prompt){
        const previousMode=prompt.inputMode;
        prompt.inputMode='none';
        const restore=()=>{
          prompt.inputMode=previousMode;
          prompt.removeEventListener('pointerdown',restore);
          prompt.removeEventListener('blur',restore)
        };
        prompt.addEventListener('pointerdown',restore);
        prompt.addEventListener('blur',restore);
        prompt.focus({preventScroll:true})
      }
      if(!prompt.hasAttribute('data-android-ime'))prompt.focus({preventScroll:true});
      prompt.setSelectionRange(start,end);
      // Use a native edit when possible so a single undo restores the original selection.
      if(document.activeElement!==prompt||!document.execCommand('insertText',false,text)){
        prompt.setRangeText(text,start,end,'end');
        prompt.dispatchEvent(new Event('input',{bubbles:true}))
      }
  }
  async function browserDictation(s: Session){
    const browser=window as Window & {
      SpeechRecognition?: LocalRecognitionEngine; webkitSpeechRecognition?: LocalRecognitionEngine;
    };
    const Engine=browser.SpeechRecognition||browser.webkitSpeechRecognition;
    const keyboardHint=window.ReceiverKeyboard?.usesDoubaoKeyboard?.()
      ?'当前使用豆包输入法。请点输入框，在豆包键盘上启动语音。':null;
    if(!Engine||!('processLocally' in Engine.prototype)||typeof Engine.available!=='function')
      throw Error(keyboardHint||'此浏览器未提供离线中文听写，可使用键盘语音输入');
    const options: LocalRecognitionOptions={langs:['zh-CN'],processLocally:true,quality:'dictation'};
    let state;
    try{state=await Engine.available(options)}
    catch(error){if(active!==s)return;throw Error(keyboardHint||errorMessage(error))}
    if(active!==s)return;
    if(state!=='available'){
      if(keyboardHint)throw Error(keyboardHint);
      const install=Engine.install?.bind(Engine);
      if(state==='downloadable'&&install){
        const panel=modal('中文听写语言包');
        panel.append(element('p','quiet','设备需要中文语言包才能离线听写。'));
        panel.append(row('安装语言包','download',async()=>{
          closeDialog();
          try{toast(await install(options)?'中文语言包已就绪，点麦克风开始听写':'语言包暂未就绪')}
          catch{toast('未能安装中文听写语言包')}
        }));
        reset(s);return
      }
      if(state==='downloading')throw Error('中文语言包正在下载');
      throw Error('此设备暂不支持离线中文听写')
    }
    const recognition=s.recognition=new Engine();
    recognition.lang='zh-CN';recognition.processLocally=true;recognition.continuous=true;
    recognition.interimResults=false;
    recognition.onstart=()=>{
      if(active===s&&window.ReceiverKeyboard){
        if(document.activeElement===prompt)button.focus({preventScroll:true});
        window.ReceiverKeyboard.hideForDictation()
      }
    };
    let text='';
    recognition.onresult=e=>{
      if(active!==s)return;
      text=Array.from(e.results).filter(result=>result.isFinal).map(result=>result[0].transcript).join('')
    };
    recognition.onerror=e=>{
      if(active!==s)return;
      toast(e.error==='not-allowed'?'麦克风权限未开启':'听写未完成：'+e.error);reset(s)
    };
    recognition.onend=()=>{
      if(active!==s)return;
      if(text)completeText(s,text);else{toast('未识别到文字');reset(s)}
    };
    recognition.start();
    button.setAttribute('aria-pressed','true');button.setAttribute('aria-label','结束听写');button.title='结束听写（Esc 取消）';
    s.limit=window.setTimeout(()=>recognition.stop(),60000)
  }
  button.addEventListener('pointerdown',event=>{
    // Keep an existing IME editing session and selection when tapping the mic.
    if(event.isPrimary&&event.button===0&&prompt.hasAttribute('data-android-ime')&&document.activeElement===prompt)
      event.preventDefault()
  });
  button.onclick=async()=>{
    if(active){if(active.deferredText)return;if(active.recognition)active.recognition.stop();else if(active.node)void finish(active);else cancel();return}
    const s: Session={chat:current().id,before:prompt.value,start:prompt.selectionStart,end:prompt.selectionEnd,parts:[],samples:0,abort:new AbortController()};
    active=s;cancelButton.hidden=!prompt.hasAttribute('data-android-ime');
    try{
      if(button.dataset.engine==='browser'){await browserDictation(s);return}
      const ctx=s.ctx=new AudioContext({sampleRate:16000});
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1}});
      if(active!==s){stream.getTracks().forEach(t=>t.stop());return}s.stream=stream;
      await ctx.audioWorklet.addModule('/voice-capture.js');if(active!==s)return;
      const node=s.node=new AudioWorkletNode(ctx,'voice-capture',{numberOfOutputs:0});
      node.port.onmessage=(e: MessageEvent<Float32Array>)=>{if(active!==s||s.finishing)return;const chunk=e.data.subarray(0,960000-s.samples);s.parts.push(chunk);s.samples+=chunk.length;if(s.samples>=960000)void finish(s)};
      ctx.createMediaStreamSource(stream).connect(node);await ctx.resume();if(active!==s)return;
      button.setAttribute('aria-pressed','true');button.setAttribute('aria-label','结束听写');button.title='结束听写（Esc 取消）';
      s.limit=window.setTimeout(()=>finish(s),60000)
    }catch(e){if(!s.cancelled)toast(e instanceof Error&&e.name==='NotAllowedError'?'麦克风权限未开启':('听写未启动：'+errorMessage(e)));reset(s)}
  };
  document.addEventListener('keydown',e=>{if(active&&e.key==='Escape'&&!e.isComposing&&e.keyCode!==229&&!composingPrompt)cancel()});
  document.addEventListener('voice-chat-starting',cancel);
  document.addEventListener('workbench-back',event=>{
    if(active){event.preventDefault();cancel()}
  });
  window.addEventListener('pagehide',cancel);
  document.addEventListener('draft-submitted',e=>{if(active?.chat===e.detail)cancel()});
  document.addEventListener('chat-selected',e=>{if(active&&active.chat!==e.detail)cancel()});
})();
