interface DirectoryListing { folders: string[]; files?: string[]; truncated?: boolean }
interface SearchPage {files: string[]; more?: boolean; partial?: boolean; skipped?: boolean}

export async function* searchDirectoryFiles(query: string, signal: AbortSignal,
  list: (path: string) => Promise<DirectoryListing>): AsyncGenerator<SearchPage> {
  const segments=query.replace(/\\/g,'/').replace(/^\.\//,'').split('/');
  const needle=segments.pop()!.toLocaleLowerCase();
  if (segments.some(part=>!part||part==='.'||part==='..'||part.includes(':'))) throw Error('请输入项目内的路径');
  const queue=[segments.join('/')];
  const excluded=new Set(['.git','node_modules','__pycache__','.gradle']);
  const join=(dir:string,name:string)=>dir ? dir+'/'+name : name;
  let partial=false,skipped=false;
  while (queue.length) {
    const files:string[]=[];
    for (let count=0; count<12 && queue.length;) {
      if(signal.aborted)return;
      const wave=queue.splice(0,Math.min(2,12-count));
      const listings=await Promise.all(wave.map(list));
      if(signal.aborted)return;
      count+=wave.length;
      for (const [i,data] of listings.entries()) {
        const dir=wave[i];
        partial ||= !!data.truncated || !data.files;
        for(const name of data.files||[]) {
          if (name.toLocaleLowerCase().includes(needle)) files.push(join(dir,name));
        }
        // With a path prefix the caller is looking inside that particular directory.
        if (!segments.length) for (const name of data.folders) {
          if (excluded.has(name)) skipped=true;
          else queue.push(join(dir,name));
        }
      }
      if (files.length) break;
    }
    yield {files,more:queue.length>0,partial,skipped};
  }
}

interface TabSearchOptions {
  tools: {title: string; open(): void}[];
  files(query: string, signal: AbortSignal): AsyncGenerator<SearchPage>;
  address(value: string): URL | undefined;
  openFile(path: string): void;
  openAddress(url: string): void;
}
export function mountNewTabSearch(panel: HTMLElement, options: TabSearchOptions) {
  const input=document.createElement('input'),list=document.createElement('div'),status=document.createElement('p');
  const more=document.createElement('button'),form=document.createElement('form');
  input.type='text';input.placeholder='搜索文件或输入 URL';input.setAttribute('aria-label',input.placeholder);
  input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-controls','panel-search-results');input.setAttribute('aria-expanded','false');
  input.enterKeyHint='go';input.autocomplete='off';input.spellcheck=false;input.maxLength=2048;
  list.id='panel-search-results';list.setAttribute('role','listbox');list.setAttribute('aria-label','搜索结果');
  status.setAttribute('role','status');status.className='quiet';
  more.type='button';more.textContent='继续搜索';more.hidden=true;
  form.append(input);panel.replaceChildren(form,list,status,more);
  let timer:number | undefined,controller=new AbortController(),composing=false,openFirst=false;
  let pages: AsyncGenerator<SearchPage> | undefined,active=-1;
  function stop(){
    clearTimeout(timer);controller.abort();pages=undefined;
  }
  function highlight(index:number) {
    const rows=Array.from(list.children);
    active=index;
    rows.forEach((row,i)=>row.setAttribute('aria-selected',String(i===index)));
    if (rows[index]) {
      input.setAttribute('aria-activedescendant',rows[index].id);
      rows[index].scrollIntoView({block:'nearest'});
    } else input.removeAttribute('aria-activedescendant');
  }
  function option(label:string,open:()=>void){
    const button=document.createElement('button');button.type='button';button.setAttribute('role','option');
    button.id='panel-search-option-'+list.childElementCount;button.setAttribute('aria-selected','false');
    button.textContent=label;button.title=label;button.onclick=open;list.append(button);
    input.setAttribute('aria-expanded','true');
  }
  async function load() {
    if(!pages)return;
    const search=controller.signal;
    more.hidden=true;status.textContent='正在搜索文件…';
    try {
      const {value}=await pages.next();
      if(search.aborted||!value)return;
      for (const path of value.files) option(path,()=>options.openFile(path));
      more.hidden=!value.more;
      const notes=[];
      if(value.more)notes.push('还有目录未搜索');
      else if(!list.childElementCount)notes.push('未找到匹配文件');
      if(value.partial)notes.push('主机仅返回了部分条目');
      if(value.skipped)notes.push('依赖和内部目录可输入路径搜索');
      status.textContent=notes.join('。');
      if(openFirst&&list.childElementCount){openFirst=false;(list.firstElementChild as HTMLButtonElement).click()}
    } catch(error){
      if(!search.aborted)status.textContent=error instanceof Error?error.message:'读取项目文件失败';
    }
  }
  function changed(){
    stop();controller=new AbortController();active=-1;openFirst=false;
    list.replaceChildren();input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');
    status.textContent='';more.hidden=true;
    const text=input.value.trim();
    if(!text||composing)return;
    const url=options.address(text.includes('://')?text:'http://'+text);
    if(url){option(url.href,()=>options.openAddress(url.href));return}
    if(text.includes('://')){status.textContent='请输入主机上的 HTTP 回环地址，例如 localhost:3000。';return}
    for(const tool of options.tools){
      if(tool.title.toLocaleLowerCase().startsWith(text.toLocaleLowerCase()))option(tool.title,tool.open);
    }
    pages=options.files(text,controller.signal);timer=window.setTimeout(load,250);
  }
  input.addEventListener('compositionstart',()=>{composing=true;changed()});
  input.addEventListener('compositionend',()=>{composing=false;changed()});
  input.oninput=changed;
  input.onkeydown=event=>{
    if(composing||event.isComposing||event.keyCode===229)return;
    const count=list.childElementCount;
    if(count&&(event.key==='ArrowDown'||event.key==='ArrowUp')){
      event.preventDefault();highlight(event.key==='ArrowDown'?(active+1)%count:(active<0?count-1:(active+count-1)%count));
    }
    if(event.key==='Escape'&&input.value){event.preventDefault();input.value='';changed()}
  };
  form.onsubmit=event=>{
    event.preventDefault();
    if(composing)return;
    const choice=list.children[Math.max(0,active)] as HTMLButtonElement | undefined;
    if(choice)choice.click();else if(pages)openFirst=true;
  };
  more.onclick=()=>void load();
  return stop;
}
