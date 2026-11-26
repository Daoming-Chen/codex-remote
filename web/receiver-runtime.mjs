import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';

// Node.js Mobile 18 does not expose these browser-compatible globals by default.
if(!globalThis.crypto)globalThis.crypto=webcrypto;
if(!globalThis.WebSocket){
  const requireVendor=createRequire(new URL('./vendor/remote.mjs',import.meta.url));
  globalThis.WebSocket=requireVendor('ws').WebSocket
}
