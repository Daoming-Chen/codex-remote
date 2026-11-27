interface PreviewBridge {
  show(url: string, generation: number, x: number, y: number, width: number, height: number, viewport: number): void;
  hide(): void;
  dispose(generation: number): void;
}

declare global { interface Window { ReceiverPreview?: PreviewBridge } }

export function hostBrowserAddress(value?: string | null) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && !url.username && !url.password &&
      ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return url;
  } catch { /* A chat link can also point to a project file. */ }
}

let nativeGeneration = 0;
function displayPreview(surface: HTMLElement, url: URL) {
  const bridge = window.ReceiverPreview;
  if (!bridge) {
    const frame = document.createElement('iframe');
    frame.title = '主机网页预览';
    frame.sandbox.add('allow-scripts','allow-forms','allow-same-origin');
    frame.referrerPolicy = 'no-referrer';
    frame.src = url.href;
    surface.append(frame);
    return;
  }
  // Android exposes JS interfaces to every frame in the workbench WebView.
  // Draw the preview in a separate, bridge-free WebView over this placeholder.
  const generation = ++nativeGeneration;
  let last = '';
  let scheduled = 0;
  const resize = new ResizeObserver(queue);
  const changes = new MutationObserver(queue);
  function stop() {
    resize.disconnect(); changes.disconnect();
    document.removeEventListener('scroll',queue,true);
    document.removeEventListener('visibilitychange',queue);
    window.removeEventListener('resize',queue);
    window.removeEventListener('pagehide',hidePage);
    window.removeEventListener('pageshow',queue);
  }
  function leave() {
    stop(); cancelAnimationFrame(scheduled); bridge!.dispose(generation);
  }
  function hidePage(event: PageTransitionEvent) {
    if (event.persisted) { last = ''; bridge!.hide(); }
    else leave();
  }
  function queue() {
    if (!scheduled) scheduled = requestAnimationFrame(sync);
  }
  function sync() {
    scheduled = 0;
    if (generation !== nativeGeneration || !surface.isConnected) { leave(); return; }
    const box = surface.getBoundingClientRect();
    const visible = box.width > 0 && box.height > 0 && !document.hidden &&
      !document.querySelector('dialog[open],#layout.drawer') &&
      surface.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    const bounds = visible ? [box.x, box.y, box.width, box.height, innerWidth].map(Math.round) : [];
    const key = JSON.stringify(bounds);
    if (last !== key) {
      if (visible) bridge!.show(url.href, generation, bounds[0], bounds[1], bounds[2], bounds[3], bounds[4]);
      else bridge!.hide();
      last = key;
    }
  }
  resize.observe(surface);
  changes.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','hidden','class','style']});
  document.addEventListener('scroll',queue,true);
  document.addEventListener('visibilitychange',queue);
  window.addEventListener('resize',queue);
  window.addEventListener('pagehide',hidePage);
  window.addEventListener('pageshow',queue);
  sync();
}

interface BrowserOptions {
  address: string;
  fetch: typeof window.fetch;
  remember: (address: string) => void;
}
export function mountHostBrowser(container: HTMLElement, options: BrowserOptions) {
  const form = document.createElement('form');
  const field = document.createElement('input');
  field.type = 'text';
  field.inputMode = 'url';
  field.placeholder = 'localhost:端口';
  field.setAttribute('aria-label','主机网页地址');
  field.value = options.address;
  const go = document.createElement('button');
  go.textContent = '打开';
  form.append(field, go);
  const status = document.createElement('p');
  status.setAttribute('role','status');
  const ports = document.createElement('div');
  ports.className = 'preview-ports';
  const area = document.createElement('div');
  area.className = 'preview-area';
  container.append(form, status, ports, area);
  let revision = 0;
  async function request(path: string, init?: RequestInit) {
    const response = await options.fetch('/api/web-preview/' + path, init);
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '主机网页预览连接失败');
    return result;
  }
  async function open(address: string) {
    const version = ++revision;
    const target = hostBrowserAddress(address.includes('://') ? address : 'http://' + address);
    if (!target) { status.textContent = '请输入主机上的 HTTP 回环地址，例如 localhost:3000。'; return; }
    field.value = target.href;
    status.textContent = '正在连接主机网页…';
    try {
      const result = await request('open', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({port:Number(target.port || 80)})});
      if (!container.isConnected || revision !== version) return;
      const url = new URL(result.url);
      if (url.protocol !== 'http:' || !/^dsh-[a-f0-9]{48}\.localhost$/.test(url.hostname) || !url.port ||
          url.username || url.password) throw Error('接收端返回的预览地址无效');
      url.pathname = target.pathname;
      url.search = target.search;
      url.hash = target.hash;
      options.remember(target.href);
      status.textContent = '';
      ports.replaceChildren();
      const surface = document.createElement('div');
      surface.className = 'preview-surface';
      area.replaceChildren(surface);
      displayPreview(surface, url);
    } catch (error) {
      if (container.isConnected && revision === version) {
        area.replaceChildren();
        status.textContent = error instanceof Error ? error.message : '网页预览连接失败';
        if (!ports.childElementCount) ports.append(refresh);
      }
    }
  }
  async function discover() {
    const version = ++revision;
    status.textContent = '正在获取主机预览端口…';
    try {
      const result = await request('ports');
      if (!container.isConnected || version !== revision) return;
      status.textContent = result.ports.length ? '选择主机端口' : '请在主机的 Remote 设置中添加网页服务的预览端口。';
      for (const port of result.ports) {
        const button = document.createElement('button');
        button.textContent = 'localhost:' + port;
        button.onclick = () => void open(button.textContent!);
        ports.append(button);
      }
    } catch (error) {
      if (container.isConnected && version === revision) status.textContent = error instanceof Error ? error.message : '无法获取预览端口';
    }
    if (container.isConnected && version === revision) ports.append(refresh);
  }
  const refresh = document.createElement('button');
  refresh.textContent = '刷新端口';
  refresh.onclick = () => { ports.replaceChildren(); void discover(); };
  form.onsubmit = event => { event.preventDefault(); void open(field.value.trim()); };
  if (options.address) void open(options.address);
  else void discover();
}
