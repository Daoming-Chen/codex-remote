export interface RemoteDevice {
  deviceId: string;
  scope: string;
  name: string;
  online: boolean | null;
}

export function isRemoteDevice(value: unknown): value is RemoteDevice {
  if (typeof value !== 'object' || value === null) return false;
  const device = value as Partial<RemoteDevice>;
  return typeof device.deviceId === 'string' && device.deviceId.length > 0 &&
    typeof device.scope === 'string' && /^[a-f0-9]{64}$/.test(device.scope) &&
    typeof device.name === 'string' && (device.online === null || typeof device.online === 'boolean');
}
