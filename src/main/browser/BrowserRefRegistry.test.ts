import { describe, expect, it } from 'vitest';
import { BrowserRefRegistry, fingerprintHash } from './BrowserRefRegistry';

const handle = (epoch: number, backendNodeId = 7) => ({
  tabId: 'tab-1', targetId: 'target-1', sessionId: '', frameId: 'frame-1', frameOrigin: 'https://example.test',
  documentEpoch: epoch, frameEpoch: epoch, loaderId: `loader-${epoch}`, backendNodeId,
  fingerprint: {
    tagName: 'button', role: 'button', accessibleName: 'Save', stableAttributes: { id: 'save' },
    nearbyTextHash: fingerprintHash('Save'), ancestorHash: fingerprintHash('main'),
  },
});

describe('BrowserRefRegistry', () => {
  it('reuses a stable ref within one document', () => {
    const refs = new BrowserRefRegistry();
    refs.beginDocument('tab-1', 1);
    expect(refs.register(handle(1))).toBe(refs.register(handle(1)));
  });

  it('rejects refs after a full navigation or loader replacement', () => {
    const refs = new BrowserRefRegistry();
    const ref = refs.register(handle(1));
    refs.invalidateTab('tab-1', 2);
    expect(() => refs.resolve(ref, { tabId: 'tab-1', documentEpoch: 2 })).toThrow(/different document/u);

    const current = refs.register(handle(2));
    expect(() => refs.resolve(current, {
      tabId: 'tab-1', documentEpoch: 2, expectedTargetId: 'target-1', currentLoaderId: 'other-loader',
    })).toThrow(/replaced frame/u);
  });

  it('issues a new ref when a child frame loader changes inside the same top document', () => {
    const refs = new BrowserRefRegistry();
    const first = refs.register(handle(1));
    const replacement = { ...handle(1), frameEpoch: 2, loaderId: 'loader-child-2' };
    const second = refs.register(replacement);

    expect(second).not.toBe(first);
    expect(refs.refForNode('tab-1', 1, 'frame-1', 7)).toBe(second);
    expect(() => refs.resolve(first, {
      tabId: 'tab-1', documentEpoch: 1, currentLoaderId: replacement.loaderId,
    })).toThrow(/replaced frame/u);
  });

  it('rejects cross-tab, cross-target, and cross-origin resolution', () => {
    const refs = new BrowserRefRegistry();
    const ref = refs.register(handle(1));
    expect(() => refs.resolve(ref, { tabId: 'tab-2', documentEpoch: 1 })).toThrow();
    expect(() => refs.resolve(ref, { tabId: 'tab-1', documentEpoch: 1, expectedTargetId: 'target-2' })).toThrow();
    expect(() => refs.resolve(ref, { tabId: 'tab-1', documentEpoch: 1, expectedOrigin: 'https://evil.test' })).toThrow();
  });
});
