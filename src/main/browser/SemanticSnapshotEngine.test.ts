import { describe, expect, it } from 'vitest';
import type { BrowserCdpClient } from './CdpClient';
import { BrowserRefRegistry } from './BrowserRefRegistry';
import { isSecretNode, redactPotentialSecretText, redactSnapshotUrl, SemanticSnapshotEngine } from './SemanticSnapshotEngine';

const cdp: BrowserCdpClient = {
  supports: () => true,
  send: async () => { throw new Error('not used by compact tests'); },
};

describe('SemanticSnapshotEngine', () => {
  it('flushes DOM layout before reading the accessibility tree and viewport', async () => {
    const calls: string[] = [];
    const captureCdp = {
      supports: () => true,
      send: async (method: string) => {
        calls.push(method);
        if (method === 'DOMSnapshot.captureSnapshot') return { strings: [], documents: [] };
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        if (method === 'Target.getTargets') return { targetInfos: [] };
        return {};
      },
    } as unknown as BrowserCdpClient;
    const engine = new SemanticSnapshotEngine(captureCdp, new BrowserRefRegistry());

    const result = await engine.capture({
      tabId: 'tab-1', targetId: 'target-1', documentEpoch: 1,
      url: 'https://example.test/', title: 'Page', mode: 'interactive',
    });

    const domCapture = calls.indexOf('DOMSnapshot.captureSnapshot');
    expect(result.nodeCount).toBe(0);
    expect(calls.indexOf('Accessibility.getFullAXTree')).toBeGreaterThan(domCapture);
    expect(calls.indexOf('Page.getLayoutMetrics')).toBeGreaterThan(domCapture);
  });

  it('redacts password values and sensitive URL components', () => {
    const engine = new SemanticSnapshotEngine(cdp, new BrowserRefRegistry());
    const strings = ['https://example.test/login?token=secret#otp', 'frame-1', 'INPUT', 'type', 'password', 'block', 'visible', '1'];
    const result = engine.compact({
      tabId: 'tab-1', targetId: 'target-1', documentEpoch: 1,
      url: strings[0]!, title: 'Login token=secret-value', mode: 'interactive', canReadOrigin: () => true,
    }, {
      nodes: [{
        nodeId: 'ax-1', backendDOMNodeId: 7, role: { value: 'textbox' }, name: { value: 'Password' },
        value: { value: 'hunter2' }, properties: [{ name: 'protected', value: { value: true } }],
      }],
    }, {
      strings,
      documents: [{
        documentURL: 0, frameId: 1,
        nodes: { backendNodeId: [7], nodeName: [2], attributes: [[3, 4]] },
        layout: { nodeIndex: [0], bounds: [[10, 20, 200, 30]], styles: [[5, 6, 7]] },
      }],
    }, { frameTree: { frame: { id: 'frame-1', loaderId: 'loader-1' } } });

    expect(result.serialized).toContain('filled=true');
    expect(result.serialized).not.toContain('hunter2');
    expect(result.serialized).not.toContain('secret-value');
    expect(result.url).toBe('https://example.test/login');
    expect(result.nodes[0]).not.toHaveProperty('value');
  });

  it('does not expose secret values through semantic query matching', () => {
    const engine = new SemanticSnapshotEngine(cdp, new BrowserRefRegistry());
    const strings = ['https://example.test/login', 'frame-1', 'INPUT', 'type', 'password', 'block', 'visible', '1'];
    const result = engine.compact({
      tabId: 'tab-1', targetId: 'target-1', documentEpoch: 1,
      url: strings[0]!, title: 'Login', mode: 'interactive', query: 'hunter2', canReadOrigin: () => true,
    }, {
      nodes: [{
        nodeId: 'ax-1', backendDOMNodeId: 7, role: { value: 'textbox' }, name: { value: 'Password' },
        value: { value: 'hunter2' }, properties: [{ name: 'protected', value: { value: true } }],
      }],
    }, {
      strings,
      documents: [{
        documentURL: 0, frameId: 1,
        nodes: { backendNodeId: [7], nodeName: [2], attributes: [[3, 4]] },
        layout: { nodeIndex: [0], bounds: [[10, 20, 200, 30]], styles: [[5, 6, 7]] },
      }],
    }, { frameTree: { frame: { id: 'frame-1', loaderId: 'loader-1' } } });

    expect(result.nodeCount).toBe(0);
    expect(result.serialized).not.toContain('hunter2');
  });

  it('omits unreadable same-target frame semantics independently of the top page grant', () => {
    const engine = new SemanticSnapshotEngine(cdp, new BrowserRefRegistry());
    const strings = [
      'https://example.test/', 'frame-root', 'https://frame.test/', 'frame-child',
      'BUTTON', 'block', 'visible', '1',
    ];
    const result = engine.compact({
      tabId: 'tab-1', targetId: 'target-1', documentEpoch: 1,
      url: strings[0]!, title: 'Page', mode: 'interactive',
      canReadOrigin: (origin) => origin === 'https://example.test',
    }, {
      nodes: [
        { nodeId: 'ax-root', backendDOMNodeId: 7, role: { value: 'button' }, name: { value: 'Allowed control' } },
        { nodeId: 'ax-child', backendDOMNodeId: 8, role: { value: 'button' }, name: { value: 'Blocked frame control' } },
      ],
    }, {
      strings,
      documents: [
        {
          documentURL: 0, frameId: 1,
          nodes: { backendNodeId: [7], nodeName: [4], attributes: [[]] },
          layout: { nodeIndex: [0], bounds: [[0, 0, 100, 20]], styles: [[5, 6, 7]] },
        },
        {
          documentURL: 2, frameId: 3,
          nodes: { backendNodeId: [8], nodeName: [4], attributes: [[]] },
          layout: { nodeIndex: [0], bounds: [[0, 30, 100, 20]], styles: [[5, 6, 7]] },
        },
      ],
    }, {
      frameTree: {
        frame: { id: 'frame-root', loaderId: 'loader-root' },
        childFrames: [{ frame: { id: 'frame-child', loaderId: 'loader-child' } }],
      },
    });

    expect(result.serialized).toContain('Allowed control');
    expect(result.serialized).not.toContain('Blocked frame control');
  });

  it('marks deliberately omitted OOPIF semantics without exposing frame content', () => {
    const engine = new SemanticSnapshotEngine(cdp, new BrowserRefRegistry());
    const result = engine.compact({
      tabId: 'tab-1', targetId: 'target-1', documentEpoch: 1,
      url: 'https://example.test/', title: 'Page', mode: 'interactive', oopifOmitted: true,
    }, { nodes: [] }, { strings: [], documents: [] });

    expect(result.serialized).toContain('Out-of-process frame semantics are omitted');
    expect(result.nodeCount).toBe(0);
  });

  it('bounds node text and total serialized output', () => {
    const engine = new SemanticSnapshotEngine(cdp, new BrowserRefRegistry());
    const count = 1_300;
    const strings = ['https://example.test/page', 'frame-1', 'BUTTON', 'block', 'visible', '1'];
    const result = engine.compact({
      tabId: 'tab-1', targetId: 'target-1', documentEpoch: 1,
      url: strings[0]!, title: 'Page', mode: 'full', canReadOrigin: () => true,
    }, {
      nodes: Array.from({ length: count }, (_, index) => ({
        nodeId: `ax-${index}`, backendDOMNodeId: index + 1, role: { value: 'button' }, name: { value: `Button ${index} ${'x'.repeat(2_000)}` },
      })),
    }, {
      strings,
      documents: [{
        documentURL: 0, frameId: 1,
        nodes: {
          backendNodeId: Array.from({ length: count }, (_, index) => index + 1),
          nodeName: Array.from({ length: count }, () => 2), attributes: Array.from({ length: count }, () => []),
        },
        layout: {
          nodeIndex: Array.from({ length: count }, (_, index) => index),
          bounds: Array.from({ length: count }, (_, index) => [0, index * 10, 100, 10]),
          styles: Array.from({ length: count }, () => [3, 4, 5]),
        },
      }],
    }, { frameTree: { frame: { id: 'frame-1', loaderId: 'loader-1' } } });

    expect(result.serialized.length).toBeLessThanOrEqual(48_000);
    expect(result.nodes.every((node) => node.name.length <= 1_000)).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('recognizes password and OTP fields without serializing their values', () => {
    expect(isSecretNode('textbox', 'Code', { autocomplete: 'one-time-code' })).toBe(true);
    expect(isSecretNode('textbox', 'API token', { name: 'credential' })).toBe(true);
    expect(isSecretNode('textbox', 'Card number', { type: 'text' })).toBe(true);
    expect(isSecretNode('textbox', 'Expiry', { autocomplete: 'cc-exp' })).toBe(true);
    expect(isSecretNode('textbox', 'Public search', { type: 'text' })).toBe(false);
    expect(redactSnapshotUrl('https://u:p@example.test/x?a=b#c')).toBe('https://example.test/x');
    expect(redactPotentialSecretText('Bearer abcdefghijklmnop', 1_000)).toBe('Bearer [redacted]');
    expect(redactPotentialSecretText('github_pat_abcdefghijklmnopqrstuvwxyz', 1_000)).toBe('[credential redacted]');
    expect(redactPotentialSecretText('Card 4242 4242 4242 4242', 1_000)).toBe('Card [payment card redacted]');
  });
});
