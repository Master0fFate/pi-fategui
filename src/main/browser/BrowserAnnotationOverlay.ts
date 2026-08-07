import type { BrowserAnnotation } from '../../shared/contracts/browser';
import type { BrowserCdpClient } from './CdpClient';

const OVERLAY_KEY = '__fateBrowserAnnotationOverlayV1__';

export class BrowserAnnotationOverlay {
  constructor(private readonly cdp: BrowserCdpClient) {}

  async add(annotation: BrowserAnnotation, label: number): Promise<void> {
    const backendNodeId = annotation.target.backendNodeId;
    if (!backendNodeId || !this.cdp.supports('Runtime')) return;
    const resolved = await this.cdp.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }).catch(() => ({ object: undefined }));
    if (!resolved.object?.objectId) return;
    await this.cdp.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: markerFunction,
      arguments: [
        { value: OVERLAY_KEY },
        { value: annotation.id },
        { value: String(label) },
      ],
      silent: true,
      returnByValue: true,
    }).catch(() => undefined);
  }

  async pulse(id: string): Promise<void> {
    if (!this.cdp.supports('Runtime')) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(OVERLAY_KEY)}]?.pulse(${JSON.stringify(id)})`,
      silent: true,
      returnByValue: true,
    }).catch(() => undefined);
  }

  async remove(id: string): Promise<void> {
    if (!this.cdp.supports('Runtime')) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(OVERLAY_KEY)}]?.remove(${JSON.stringify(id)})`,
      silent: true,
      returnByValue: true,
    }).catch(() => undefined);
  }

  async clear(): Promise<void> {
    if (!this.cdp.supports('Runtime')) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(OVERLAY_KEY)}]?.clear()`,
      silent: true,
      returnByValue: true,
    }).catch(() => undefined);
  }
}

const markerFunction = `function(key, id, label) {
  const target = this;
  let state = globalThis[key];
  if (!state) {
    const root = document.createElement('div');
    root.dataset.piBrowserOverlay = 'annotations';
    root.setAttribute('aria-hidden', 'true');
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646', pointerEvents: 'none',
      contain: 'layout style paint', overflow: 'visible'
    });
    (document.documentElement || document.body).appendChild(root);
    const markers = new Map();
    let frame = 0;
    const update = () => {
      frame = 0;
      for (const marker of markers.values()) {
        if (!marker.target.isConnected) {
          marker.outline.style.display = 'none';
          continue;
        }
        const rect = marker.target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) {
          marker.outline.style.display = 'none';
          continue;
        }
        marker.outline.style.display = 'block';
        marker.outline.style.transform = 'translate(' + rect.left + 'px,' + rect.top + 'px)';
        marker.outline.style.width = rect.width + 'px';
        marker.outline.style.height = rect.height + 'px';
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    addEventListener('scroll', schedule, true);
    addEventListener('resize', schedule, true);
    state = {
      add(targetNode, markerId, markerLabel) {
        this.remove(markerId);
        const outline = document.createElement('div');
        outline.dataset.piBrowserOverlay = 'annotation';
        Object.assign(outline.style, {
          position: 'absolute', left: '0', top: '0', boxSizing: 'border-box',
          border: '2px solid rgb(124,108,255)', borderRadius: '4px',
          background: 'rgba(124,108,255,.10)', boxShadow: '0 0 0 1px rgba(9,11,18,.55)',
          transition: 'opacity 120ms ease-out'
        });
        const badge = document.createElement('span');
        badge.textContent = markerLabel;
        Object.assign(badge.style, {
          position: 'absolute', right: '-8px', top: '-10px', minWidth: '20px', height: '20px',
          padding: '0 5px', boxSizing: 'border-box', display: 'grid', placeItems: 'center',
          borderRadius: '10px', color: '#fff', background: 'rgb(124,108,255)',
          boxShadow: '0 2px 8px rgba(9,11,18,.42)', font: '600 11px/20px ui-sans-serif,system-ui,sans-serif'
        });
        outline.appendChild(badge);
        root.appendChild(outline);
        markers.set(markerId, { target: targetNode, outline });
        schedule();
      },
      remove(markerId) {
        const marker = markers.get(markerId);
        if (!marker) return;
        marker.outline.remove();
        markers.delete(markerId);
      },
      pulse(markerId) {
        const marker = markers.get(markerId);
        if (!marker) return;
        marker.target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        marker.outline.animate(
          [{ opacity: 1, filter: 'brightness(1)' }, { opacity: .45, filter: 'brightness(1.8)' }, { opacity: 1, filter: 'brightness(1)' }],
          { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' }
        );
        schedule();
      },
      clear() {
        for (const marker of markers.values()) marker.outline.remove();
        markers.clear();
        root.remove();
        removeEventListener('scroll', schedule, true);
        removeEventListener('resize', schedule, true);
        delete globalThis[key];
      }
    };
    globalThis[key] = state;
  }
  state.add(target, id, label);
}`;
