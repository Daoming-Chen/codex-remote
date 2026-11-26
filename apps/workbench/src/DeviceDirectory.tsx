import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { isRemoteDevice, type RemoteDevice as Device } from '../../../packages/protocol/devices.js';

declare global {
  interface Window { receiverAuthorized?: () => void }
}
const selectionKey = 'codex-receiver-selected-device';
const devicePath = (device: Device) => '/devices/' + encodeURIComponent(device.scope) + '/';

function DeviceDirectory() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState('正在获取已授权设备…');
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [last, setLast] = useState(() => localStorage.getItem(selectionKey));
  const refresh = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    let first = true;
    let active = false;
    let queued = false;
    let timer: number | undefined;
    const lifetime = new AbortController();
    async function load() {
      window.clearTimeout(timer);
      if (active) { queued = true; return }
      active = true;
      setLoading(true);
      try {
        const response = await fetch('/api/devices', { method: 'POST', signal: lifetime.signal });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.devices) || !data.devices.every(isRemoteDevice)) throw Error(data.error || '无法获取设备');
        const list: Device[] = data.devices;
        const previous = localStorage.getItem(selectionKey);
        const saved = list.find(device => device.deviceId === previous);
        const restore = first;
        first = false;
        setDevices(list);
        setLast(previous);
        setUnavailable(false);
        if (restore && saved?.online === true && location.pathname === '/' && !location.hash) {
          setStatus('正在打开 ' + (saved.name || saved.deviceId) + '…');
          location.replace(devicePath(saved));
          return;
        }
        setStatus(!list.length ? '当前账号暂无已授权设备'
          : previous && !saved ? '上次使用的设备已不在授权列表中。'
          : location.hash === '#directory-unavailable' ? '设备列表已恢复，请重新选择主机。' : '');
      } catch (error) {
        if (lifetime.signal.aborted) return;
        setUnavailable(true);
        setStatus(error instanceof Error ? error.message : '无法获取设备');
      } finally {
        active = false;
        if (!lifetime.signal.aborted) {
          setLoading(false);
          if (queued) { queued = false; void load() }
          else if (!document.hidden) timer = window.setTimeout(load, 15000);
        }
      }
    }
    const stopTimer = () => window.clearTimeout(timer);
    const visibility = () => document.hidden ? stopTimer() : void load();
    const show = (event: PageTransitionEvent) => { if (event.persisted) void load() };
    refresh.current = load;
    window.receiverAuthorized = load;
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pageshow', show);
    window.addEventListener('pagehide', stopTimer);
    void load();
    return () => {
      lifetime.abort(); stopTimer();
      delete window.receiverAuthorized;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('pagehide', stopTimer);
    };
  }, []);

  function select(device: Device) {
    setStatus('正在打开 ' + (device.name || device.deviceId) + '…');
    localStorage.setItem(selectionKey, device.deviceId);
    if (location.pathname === '/') history.replaceState(null, '', '/devices');
    location.assign(devicePath(device));
  }
  const names = new Map<string, number>();
  for (const device of devices) names.set(device.name, (names.get(device.name) || 0) + 1);
  return <>
    <h1>选择 Codex 主机</h1>
    <p id="status" role="status">{status}</p>
    <div id="devices">{devices.map(device =>
      <button key={device.deviceId} disabled={unavailable || device.online === false} onClick={() => select(device)}>
        <span>{device.name || device.deviceId}{(names.get(device.name) || 0) > 1 && <small>{device.deviceId}</small>}</span>
        <small>{unavailable ? '待确认' : (last === device.deviceId ? '上次使用 · ' : '') +
          (device.online === true ? '在线' : device.online === false ? '离线' : '状态未知')}</small>
      </button>
    )}</div>
    <button id="refresh" disabled={loading} onClick={() => refresh.current()}>刷新设备</button>
  </>;
}
render(<DeviceDirectory />, document.getElementById('root')!);
