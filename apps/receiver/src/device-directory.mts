import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { RemoteDevice } from '../../../packages/protocol/devices.js';

type Host = Omit<RemoteDevice, 'scope'>;

export function deviceNameEvent(name: string): string {
  return 'event: device-name\ndata: ' + JSON.stringify(name || '所选设备') + '\n\n';
}

export function createDeviceDirectory(discover: () => Promise<Host[]>) {
  const devices = new Map<string, RemoteDevice>();
  const subscribers = new Map<string, Map<ServerResponse, boolean>>();
  let checkedAt = 0;
  let inflight: Promise<RemoteDevice[]> | undefined;
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

  function list(): Promise<RemoteDevice[]> {
    if (inflight) return inflight;
    inflight = discover().then(hosts => {
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
      checkedAt = 0; closeStreams(false); throw error;
    }).finally(() => { inflight = undefined });
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

