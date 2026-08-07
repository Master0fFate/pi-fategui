import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', { value: TestResizeObserver, configurable: true });
if (typeof Element !== 'undefined') {
  Object.defineProperties(Element.prototype, {
    hasPointerCapture: { value: () => false, configurable: true },
    releasePointerCapture: { value: () => undefined, configurable: true },
    scrollIntoView: { value: () => undefined, configurable: true },
    setPointerCapture: { value: () => undefined, configurable: true },
  });
}

afterEach(cleanup);
