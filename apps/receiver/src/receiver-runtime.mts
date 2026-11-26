import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';

// Node.js Mobile 18 does not expose these browser-compatible globals by default.
if(!globalThis.crypto)globalThis.crypto=webcrypto;
if(!globalThis.WebSocket){
  const requireVendor=createRequire(new URL('./vendor/remote.mjs',import.meta.url));
  globalThis.WebSocket=requireVendor('ws').WebSocket
}


// The APK owns one Node runtime and one private credential directory. Device-scoped
// transport modules share this queue through the canonical runtime module URL.
let refreshTail: Promise<void> = Promise.resolve();
export function withEmbeddedCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = refreshTail.then(operation);
  refreshTail = result.then(() => {}, () => {});
  return result;
}
