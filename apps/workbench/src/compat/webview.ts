import 'core-js/modules/es.array.at.js';
import 'core-js/modules/es.array.find-last.js';
import 'core-js/modules/es.array.find-last-index.js';
import 'core-js/modules/es.object.has-own.js';
import 'core-js/modules/es.string.replace-all.js';

if (!crypto.randomUUID) {
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, writable: true, value() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
  }});
}

if (!Element.prototype.replaceChildren) {
  Object.defineProperty(Element.prototype, 'replaceChildren', { configurable: true, writable: true,
    value(this: Element, ...nodes: (Node | string)[]) {
      const children = this.ownerDocument.createDocumentFragment();
      children.append(...nodes);
      this.textContent = '';
      this.appendChild(children);
    },
  });
}

if (!AbortSignal.timeout) {
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, writable: true, value(ms: number) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return controller.signal;
  }});
}
