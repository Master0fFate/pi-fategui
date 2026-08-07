import { describe, expect, it } from 'vitest';
import { AnnotationService } from './AnnotationService';
import { BrowserAnnotationRepository } from './BrowserAnnotationRepository';
import type { BrowserCdpEventClient } from './CdpClient';
import { BrowserPolicy } from './BrowserPolicy';
import { BrowserRefRegistry, fingerprintHash } from './BrowserRefRegistry';

function fixture() {
  const policy = new BrowserPolicy();
  policy.beginTask('annotation-test');
  policy.setGrant({
    origin: 'https://example.test',
    read: true,
    interact: false,
    scope: 'task',
    allowPrivateNetwork: false,
  });
  const refs = new BrowserRefRegistry();
  refs.beginDocument('tab-1', 1);
  const ref = refs.register({
    tabId: 'tab-1',
    targetId: 'target-1',
    sessionId: '',
    frameId: 'frame-1',
    frameOrigin: 'https://example.test',
    documentEpoch: 1,
    frameEpoch: 1,
    loaderId: 'loader-1',
    backendNodeId: 7,
    fingerprint: {
      tagName: 'input',
      role: 'textbox',
      accessibleName: 'Email',
      stableAttributes: { id: 'email' },
      nearbyTextHash: fingerprintHash('Email'),
      ancestorHash: fingerprintHash('form'),
    },
  });
  const calls: string[] = [];
  const cdp: BrowserCdpEventClient = {
    supports: (domain) => domain === 'Overlay' || domain === 'CSS',
    waitForEvent: async <T>(method: string) => {
      calls.push(`wait:${method}`);
      return { backendNodeId: 7 } as T;
    },
    send: async <T>(method: string) => {
      calls.push(method);
      if (method === 'DOM.describeNode') {
        return {
          node: {
            nodeId: 7,
            nodeName: 'INPUT',
            frameId: 'frame-1',
            attributes: ['id', 'email', 'class', 'field field--email', 'type', 'text', 'value', 'person@example.test', 'data-token', 'secret-value'],
          },
        } as T;
      }
      if (method === 'Accessibility.queryAXTree') {
        return { nodes: [{ role: { value: 'textbox' }, name: { value: 'Email' } }] } as T;
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { border: [10, 20, 210, 20, 210, 50, 10, 50] } } as T;
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssLayoutViewport: { clientWidth: 1_000, clientHeight: 500 } } as T;
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return {
          strings: ['https://example.test/account?token=hidden#secret', 'frame-1'],
          documents: [{ documentURL: 0, frameId: 1, nodes: { backendNodeId: [7] } }],
        } as T;
      }
      if (method === 'DOM.getOuterHTML') {
        return { outerHTML: '<input class="field field--email" id="email" type="text" value="person@example.test" data-token="secret-value">' } as T;
      }
      if (method === 'CSS.getComputedStyleForNode') {
        return {
          computedStyle: [
            { name: 'display', value: 'block' },
            { name: 'background-color', value: 'rgb(1, 2, 3)' },
            { name: 'background-image', value: 'url(https://secret.test/token)' },
          ],
        } as T;
      }
      return {} as T;
    },
  };
  const repository = new BrowserAnnotationRepository();
  return { policy, refs, ref, cdp, calls, repository };
}

describe('AnnotationService', () => {
  it('stores a structured, redacted element annotation with an existing semantic ref', async () => {
    const { policy, refs, ref, cdp, calls, repository } = fixture();
    const service = new AnnotationService(cdp, policy, repository, refs);

    const annotation = await service.selectElement({
      tabId: 'tab-1',
      documentEpoch: 1,
      pageRevision: 2,
      url: 'https://example.test/account?token=hidden#secret',
    }, 'Use this field');

    expect(annotation.url).toBe('https://example.test/account');
    expect(annotation.origin).toBe('https://example.test');
    expect(annotation.target.semanticRef).toBe(ref);
    expect(annotation.target.rectCssPx).toEqual({ x: 10, y: 20, width: 200, height: 30 });
    expect(annotation.target.rectNormalized).toEqual({ x: 0.01, y: 0.04, width: 0.2, height: 0.06 });
    expect(annotation.target.locatorHints.class).toBe('field field--email');
    expect(annotation.domExcerpt).toContain('class="field field--email"');
    expect(annotation.domExcerpt).toContain('value="[redacted]"');
    expect(annotation.domExcerpt).not.toContain('person@example.test');
    expect(annotation.domExcerpt).not.toContain('secret-value');
    expect(annotation.computedStyle).toEqual({ display: 'block', 'background-color': 'rgb(1, 2, 3)' });
    expect(calls).toContain('Overlay.setInspectMode');
    expect(repository.list('tab-1')).toHaveLength(1);
  });

  it('translates a viewport region through page scroll before DOM intersection', async () => {
    const policy = new BrowserPolicy();
    policy.beginTask('region-test');
    policy.setGrant({ origin: 'https://example.test', read: true, interact: false, scope: 'task', allowPrivateNetwork: false });
    const repository = new BrowserAnnotationRepository();
    const cdp: BrowserCdpEventClient = {
      supports: (domain) => domain === 'Overlay',
      waitForEvent: async <T>() => ({ viewport: { x: 10, y: 20, width: 100, height: 50 } }) as T,
      send: async <T>(method: string) => {
        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: { pageX: 0, pageY: 1_000, clientWidth: 500, clientHeight: 400 } } as T;
        }
        if (method === 'DOMSnapshot.captureSnapshot') {
          return {
            strings: ['https://example.test/page', 'frame-1', 'DIV', 'block', 'visible', '1'],
            documents: [{
              documentURL: 0,
              frameId: 1,
              nodes: { backendNodeId: [7], nodeName: [2] },
              layout: { nodeIndex: [0], bounds: [[10, 1_020, 100, 50]], styles: [[3, 4, 5]] },
            }],
          } as T;
        }
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: [{ backendDOMNodeId: 7, role: { value: 'group' }, name: { value: 'Scrolled card' } }] } as T;
        }
        return {} as T;
      },
    };
    const service = new AnnotationService(cdp, policy, repository, new BrowserRefRegistry());

    const annotation = await service.selectRegion({
      tabId: 'tab-1', documentEpoch: 1, pageRevision: 1, url: 'https://example.test/page',
    }, 'Scrolled selection');

    expect(annotation.target.rectCssPx).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(annotation.domExcerpt).toContain('Scrolled card');
    expect(annotation.semanticCoverage).toBe(1);
  });

  it('reattaches a class-only element after same-document HMR replacement', async () => {
    const policy = new BrowserPolicy();
    policy.beginTask('reattach-test');
    policy.setGrant({ origin: 'https://example.test', read: true, interact: false, scope: 'task', allowPrivateNetwork: false });
    const repository = new BrowserAnnotationRepository();
    const original = repository.save({
      id: 'annotation-1', tabId: 'tab-1', url: 'https://example.test/page', origin: 'https://example.test',
      documentEpoch: 1, pageRevision: 1, kind: 'element',
      target: {
        frameId: 'frame-1', backendNodeId: 7, semanticRef: 'e1', role: 'group', accessibleName: 'Pro plan', tagName: 'div',
        rectCssPx: { x: 10, y: 20, width: 200, height: 100 },
        rectNormalized: { x: 0.01, y: 0.04, width: 0.2, height: 0.2 },
        locatorHints: { class: 'pricing-card pricing-card--pro' },
        fingerprint: { attributesHash: fingerprintHash('old'), nearbyTextHash: fingerprintHash('Pro plan'), ancestorHash: '' },
      },
      comment: 'Update this card', domExcerpt: '<div class="pricing-card pricing-card--pro">',
      semanticCoverage: 1, reattachConfidence: 0.75, createdAt: 1,
    });
    const cdp: BrowserCdpEventClient = {
      supports: () => false,
      waitForEvent: async <T>() => ({} as T),
      send: async <T>(method: string) => {
        if (method === 'DOMSnapshot.captureSnapshot') return {
          strings: ['https://example.test/page', 'frame-1', 'DIV', 'class', 'pricing-card pricing-card--pro'],
          documents: [{
            documentURL: 0, frameId: 1,
            nodes: { backendNodeId: [9], nodeName: [2], attributes: [[3, 4]] },
            layout: { nodeIndex: [0], bounds: [[12, 22, 200, 100]], styles: [[]] },
          }],
        } as T;
        if (method === 'Accessibility.getFullAXTree') return {
          nodes: [{ backendDOMNodeId: 9, role: { value: 'group' }, name: { value: 'Pro plan' } }],
        } as T;
        if (method === 'Page.getLayoutMetrics') return {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1_000, clientHeight: 500 },
        } as T;
        if (method === 'DOM.describeNode') return { node: { nodeId: 9 } } as T;
        if (method === 'DOM.getOuterHTML') return {
          outerHTML: '<div class="pricing-card pricing-card--pro"><strong>Pro plan</strong></div>',
        } as T;
        return {} as T;
      },
    };
    const service = new AnnotationService(cdp, policy, repository, new BrowserRefRegistry());

    const reattached = await service.reattachElement({
      tabId: 'tab-1', documentEpoch: 1, pageRevision: 2, url: 'https://example.test/page',
    }, original);

    expect(reattached.target.backendNodeId).toBe(9);
    expect(reattached.target.semanticRef).toBeUndefined();
    expect(reattached.domExcerpt).toContain('pricing-card--pro');
    expect(reattached.reattachConfidence).toBeGreaterThanOrEqual(0.65);
    expect(reattached.pageRevision).toBe(2);
  });

  it('refuses annotations from a frame without a read grant', async () => {
    const { policy, refs, cdp, repository } = fixture();
    policy.revokeGrant('https://example.test');
    const service = new AnnotationService(cdp, policy, repository, refs);

    await expect(service.selectElement({
      tabId: 'tab-1',
      documentEpoch: 1,
      pageRevision: 1,
      url: 'https://example.test/account',
    }, 'Blocked')).rejects.toThrow(/not readable/iu);

    expect(repository.list()).toHaveLength(0);
  });

  it('allows a user-picked element without granting the agent the rest of the origin', async () => {
    const { policy, refs, cdp, repository } = fixture();
    policy.revokeGrant('https://example.test');
    const service = new AnnotationService(cdp, policy, repository, refs);

    const annotation = await service.selectElement({
      tabId: 'tab-1',
      documentEpoch: 1,
      pageRevision: 1,
      url: 'https://example.test/account',
      explicitUserSelection: true,
    }, 'Only share this field');

    expect(annotation.target.accessibleName).toBe('Email');
    expect(policy.canRead('https://example.test')).toBe(false);
    expect(repository.list()).toHaveLength(1);
  });
});
