import type { BrowserCdpClient } from './CdpClient';

const POINTER_KEY = '__fateBrowserPointerV1__';

export interface BrowserPointerPoint {
  x: number;
  y: number;
}

/** A page-owned visual pointer driven through CDP. It never moves the OS cursor. */
export class BrowserPointerOverlay {
  constructor(private readonly cdp: BrowserCdpClient) {}

  async move(point: BrowserPointerPoint, target: string): Promise<void> {
    if (!this.cdp.supports('Runtime')) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: `(${movePointerFunction})(${JSON.stringify(POINTER_KEY)},${finite(point.x)},${finite(point.y)},${JSON.stringify(target.slice(0, 120))})`,
      awaitPromise: true,
      silent: true,
      returnByValue: true,
    }).catch(() => undefined);
  }

  async click(point: BrowserPointerPoint): Promise<void> {
    if (!this.cdp.supports('Runtime')) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: `(${clickPointerFunction})(${JSON.stringify(POINTER_KEY)},${finite(point.x)},${finite(point.y)})`,
      silent: true,
      returnByValue: true,
    }).catch(() => undefined);
  }

  async clear(): Promise<void> {
    if (!this.cdp.supports('Runtime')) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(POINTER_KEY)}]?.clear()`,
      silent: true,
      returnByValue: true,
    }).catch(() => undefined);
  }
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

const movePointerFunction = `async function(key, requestedX, requestedY, target) {
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
  const x = clamp(requestedX, 0, Math.max(0, innerWidth - 1));
  const y = clamp(requestedY, 0, Math.max(0, innerHeight - 1));
  let state = globalThis[key];
  if (!state) {
    const root = document.createElement('div');
    root.dataset.piBrowserOverlay = 'agent-pointer';
    root.setAttribute('aria-hidden', 'true');
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none',
      contain: 'layout style paint', overflow: 'hidden'
    });
    const cursor = document.createElement('div');
    cursor.dataset.piBrowserOverlay = 'agent-cursor';
    Object.assign(cursor.style, {
      position: 'absolute', left: '0', top: '0', width: '15px', height: '15px', boxSizing: 'border-box',
      border: '2px solid #ffffff', borderRadius: '50%', background: 'rgb(124,108,255)',
      boxShadow: '0 2px 8px rgba(9,11,18,.48)', opacity: '0', willChange: 'transform',
      transition: 'transform 120ms cubic-bezier(.16,1,.3,1), opacity 80ms ease-out'
    });
    const label = document.createElement('span');
    Object.assign(label.style, {
      position: 'absolute', left: '17px', top: '-3px', maxWidth: '180px', height: '20px', padding: '0 6px',
      overflow: 'hidden', borderRadius: '5px', color: '#fff', background: 'rgba(15,18,28,.92)',
      boxShadow: '0 2px 8px rgba(9,11,18,.35)', font: '600 10px/20px ui-sans-serif,system-ui,sans-serif',
      textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    });
    cursor.appendChild(label);
    root.appendChild(cursor);
    (document.documentElement || document.body).appendChild(root);
    state = {
      root, cursor, label, x: Math.max(0, innerWidth * .5), y: Math.max(0, innerHeight * .5),
      clear() { root.remove(); delete globalThis[key]; }
    };
    cursor.style.transform = 'translate3d(' + (state.x - 7.5) + 'px,' + (state.y - 7.5) + 'px,0)';
    globalThis[key] = state;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  state.label.textContent = target ? 'Pi · ' + target : 'Pi';
  state.cursor.style.opacity = '1';
  state.cursor.style.transform = 'translate3d(' + (x - 7.5) + 'px,' + (y - 7.5) + 'px,0)';
  state.x = x;
  state.y = y;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
}`;

const clickPointerFunction = `function(key, requestedX, requestedY) {
  const state = globalThis[key];
  if (!state || !state.root.isConnected) return;
  const x = Math.min(innerWidth - 1, Math.max(0, requestedX));
  const y = Math.min(innerHeight - 1, Math.max(0, requestedY));
  const ring = document.createElement('div');
  ring.dataset.piBrowserOverlay = 'agent-click';
  Object.assign(ring.style, {
    position: 'absolute', left: (x - 12) + 'px', top: (y - 12) + 'px', width: '24px', height: '24px',
    boxSizing: 'border-box', border: '2px solid rgb(124,108,255)', borderRadius: '50%', opacity: '.9'
  });
  state.root.appendChild(ring);
  const animation = ring.animate(
    [{ transform: 'scale(.45)', opacity: .9 }, { transform: 'scale(1.45)', opacity: 0 }],
    { duration: 360, easing: 'cubic-bezier(.16,1,.3,1)' }
  );
  animation.addEventListener('finish', () => ring.remove(), { once: true });
  setTimeout(() => ring.remove(), 500);
}`;
