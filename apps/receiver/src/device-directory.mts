import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { RemoteDevice } from '../../../packages/protocol/devices.js';

type Host = Omit<RemoteDevice, 'scope'>;

export function deviceNameEvent(name: string): string {
  return 'event: device-name\ndata: ' + JSON.stringify(name || '所选设备') + '\n\n';
}

const directoryErrors = new Map([
  ['ACCOUNT_AUTH_REQUIRED', 'Remote 要求重新授权此接收端。'],
  ['AUTH_INVALID', 'Remote 已拒绝此接收端的授权。请检查账号的设备授权状态。'],
  ['TOKEN_EXPIRED', 'Remote 授权已过期。请检查账号的设备授权状态。'],
  ['PEER_IDENTITY_MISMATCH', '主机身份与 Remote 授权记录不一致。请在 Remote 中核对主机。'],
  ['SERVER_CREDENTIALS_LOCK_UNSUPPORTED', '接收端无法锁定授权凭据。请检查接收端版本和存储位置。'],
  ['SERVER_CREDENTIALS_BUSY', '接收端正在更新授权凭据。请稍后刷新设备。'],
  ['CONNECTION_FAILED', '无法从 Remote 服务获取设备列表。'],
  ['DIRECTORY_TIMEOUT', '读取 Remote 设备列表超时。'],
  ['INVALID_MESSAGE', 'Remote 返回的设备或授权信息格式异常。'],
]);

export function deviceDirectoryError(error: {code?: unknown; name?: unknown; reason?: unknown} | null) {
  const timeout = error?.name === 'TimeoutError' || (error?.code === 'CONNECTION_FAILED' && error.reason === 'timeout');
  const code = timeout ? 'DIRECTORY_TIMEOUT' : typeof error?.code === 'string' ? error.code : '';
  const message = directoryErrors.get(code);
  return message ? {code, error: message + '（' + code + '）'} :
    {code: 'DEVICE_DIRECTORY_FAILED', error: '读取 Remote 设备列表失败，请刷新设备。'};
}

export function createDeviceDirectory(discover: (signal: AbortSignal) => Promise<Host[]>) {
  const devices = new Map<string, RemoteDevice>();
  const subscribers = new Map<string, Map<ServerResponse, boolean>>();
  let checkedAt = 0;
  let inflight: Promise<RemoteDevice[]> | undefined;
  let latest: Promise<RemoteDevice[]>;
  let active: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stale = () => Date.now() - checkedAt >= 30000;

  function closeStreams(revokedOnly: boolean) {
    for (const [scope, streams] of subscribers) {
      if (revokedOnly && devices.has(scope)) continue;
      for (const [response, directory] of streams) {
        if (revokedOnly && directory && response.headersSent && !response.writableEnded)
          response.end('event: device-access-lost\ndata: revoked\n\n');
        else response.destroy();
      }
    }
  }

  function list(restart = false): Promise<RemoteDevice[]> {
    if (inflight && !restart) return inflight;
    active?.abort();
    const request = new AbortController();
    active = request;
    inflight = discover(request.signal).then(hosts => {
      request.signal.throwIfAborted();
      const next = hosts.map(host => ({
        ...host, name: host.name || '', scope: createHash('sha256').update(host.deviceId).digest('hex'),
      }));
      const previous = new Map(devices);
      devices.clear();
      for (const device of next) {
        devices.set(device.scope, device);
        if (previous.get(device.scope)?.name === device.name) continue;
        for (const [response, directory] of subscribers.get(device.scope) || []) {
          if (directory && response.headersSent && !response.writableEnded) {
            if (response.writableNeedDrain) response.end();
            else response.write(deviceNameEvent(device.name));
          }
        }
      }
      checkedAt = Date.now();
      closeStreams(true);
      return next;
    }).catch(error => {
      if (request.signal.aborted && active !== request) return latest;
      checkedAt = 0; closeStreams(false); throw error;
    }).finally(() => { if (active === request) { inflight = undefined; active = undefined; } });
    latest = inflight;
    return inflight;
  }

  function watch(scope: string, response: ServerResponse, directory: boolean) {
    const streams = subscribers.get(scope) || new Map<ServerResponse, boolean>();
    subscribers.set(scope, streams);
    streams.set(response, directory);
    response.once('close', () => {
      streams.delete(response);
      if (!streams.size) subscribers.delete(scope);
      if (!subscribers.size) { clearInterval(timer); timer = undefined }
    });
    timer ??= setInterval(() => { if (stale()) void list().catch(() => {}) }, 30000).unref();
  }
  return { devices, stale, list, watch };
}

