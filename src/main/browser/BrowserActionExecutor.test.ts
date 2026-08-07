import { describe, expect, it, vi } from 'vitest';
import { BrowserActionExecutor, type BrowserActionContext } from './BrowserActionExecutor';
import type { BrowserCdpClient } from './CdpClient';
import { BrowserActionGate, BrowserPolicy } from './BrowserPolicy';
import { BrowserRefRegistry, fingerprintHash, type BrowserElementHandle } from './BrowserRefRegistry';

const ACTION_CONTEXT: BrowserActionContext = {
  tabId: 't1',
  targetId: '99',
  documentEpoch: 1,
  url: 'https://example.test/account',
  origin: 'https://example.test',
};

interface SetupOptions {
  tagName?: string;
  formAction?: string;
  formId?: string;
  focused?: boolean;
  omitStable?: readonly string[];
  hoverFormAction?: string;
  baseHref?: string;
  liveAncestorName?: string;
  sensitiveForm?: boolean;
  documentUrl?: string;
  frameOrigin?: string;
  hitTarget?: 'target' | 'click-owner' | 'child-without-node-id';
  clickOwnerName?: string;
}

function setup(attributes: Record<string, string>, name: string, options: SetupOptions = {}) {
  const refs = new BrowserRefRegistry();
  const documentUrl = options.documentUrl ?? ACTION_CONTEXT.url;
  const frameOrigin = options.frameOrigin ?? ACTION_CONTEXT.origin;
  const context = { ...ACTION_CONTEXT, url: documentUrl, origin: frameOrigin };
  const tagName = options.tagName ?? 'button';
  const hasForm = options.formAction !== undefined || options.formId !== undefined;
  const targetAttributes = options.formId ? { ...attributes, form: options.formId } : attributes;
  const handle: BrowserElementHandle = {
    tabId: 't1', targetId: '99', sessionId: '', frameId: 'f1', frameOrigin,
    documentEpoch: 1, frameEpoch: 1, loaderId: 'loader-1', backendNodeId: 7,
    fingerprint: {
      tagName, role: tagName === 'input' ? 'textbox' : 'button', accessibleName: name,
      stableAttributes: Object.fromEntries(Object.entries(targetAttributes).filter(([key]) => [
        'id', 'name', 'type', 'autocomplete', 'href', 'formaction', 'data-testid', 'data-fate-node',
      ].includes(key) && !options.omitStable?.includes(key))),
      nearbyTextHash: fingerprintHash(name), ancestorHash: fingerprintHash('main\nContainer'),
    },
  };
  const ref = refs.register(handle);
  const calls: string[] = [];
  const mouseEvents: string[] = [];
  const keyEvents: Array<Record<string, unknown>> = [];
  const nodes = new Map<number, { backendNodeId: number; nodeId: number; parentId?: number; nodeName: string; attributes?: string[] }>([
    [1, { backendNodeId: 1, nodeId: 1, nodeName: '#document' }],
    [4, { backendNodeId: 4, nodeId: 4, parentId: 1, nodeName: 'DIV', attributes: ['role', 'button', 'tabindex', '0'] }],
    [5, { backendNodeId: 5, nodeId: 5, parentId: 1, nodeName: 'BASE', attributes: options.baseHref === undefined ? [] : ['href', options.baseHref] }],
    [6, {
      backendNodeId: 6,
      nodeId: 6,
      parentId: 1,
      nodeName: 'FORM',
      attributes: Object.entries({ ...(options.formId ? { id: options.formId } : {}), ...(options.formAction !== undefined ? { action: options.formAction } : {}) }).flat(),
    }],
    [7, {
      backendNodeId: 7,
      nodeId: 7,
      parentId: options.hitTarget === 'click-owner' ? 4 : options.formId ? 1 : hasForm ? 6 : 1,
      nodeName: tagName.toUpperCase(),
      attributes: Object.entries(targetAttributes).flat(),
    }],
    [8, { backendNodeId: 8, nodeId: 8, parentId: 7, nodeName: 'SPAN' }],
  ]);
  const cdp: BrowserCdpClient = {
    supports: () => true,
    send: async <T>(method: string, params: Record<string, unknown> = {}) => {
      calls.push(method);
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'f1', loaderId: 'loader-1', url: documentUrl } } } as T;
      }
      if (method === 'DOM.describeNode') {
        const nodeId = Number(params.nodeId ?? params.backendNodeId);
        return { node: nodes.get(nodeId) } as T;
      }
      if (method === 'Accessibility.getPartialAXTree') {
        if (Number(params.backendNodeId) === 4) {
          return { nodes: [{ nodeId: 'ax-owner', backendDOMNodeId: 4, role: { value: handle.fingerprint.role }, name: { value: options.clickOwnerName ?? name } }] } as T;
        }
        return { nodes: [
          { nodeId: 'ax-target', parentId: 'ax-parent', backendDOMNodeId: 7, role: { value: handle.fingerprint.role }, name: { value: name } },
          { nodeId: 'ax-parent', role: { value: 'main' }, name: { value: options.liveAncestorName ?? 'Container' } },
        ] } as T;
      }
      if (method === 'DOM.getDocument') return { root: nodes.get(1) } as T;
      if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [7] } as T;
      if (method === 'DOM.querySelector') {
        if (params.selector === ':focus') return { nodeId: options.focused ? 7 : 0 } as T;
        if (params.selector === 'base[href]') return { nodeId: options.baseHref === undefined ? 0 : 5 } as T;
        if (typeof params.selector === 'string' && params.selector.startsWith('[id=')) return { nodeId: options.formId ? 6 : 0 } as T;
        if (typeof params.selector === 'string' && params.selector.includes('input[type="password"')) {
          return { nodeId: options.sensitiveForm ? 8 : 0 } as T;
        }
        return { nodeId: 0 } as T;
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } } as T;
      if (method === 'DOM.getNodeForLocation') {
        if (options.hitTarget === 'click-owner') return { backendNodeId: 4, nodeId: 4 } as T;
        if (options.hitTarget === 'child-without-node-id') return { backendNodeId: 8 } as T;
        return { backendNodeId: 7, nodeId: 7 } as T;
      }
      if (method === 'Input.dispatchMouseEvent') {
        const type = String(params.type ?? '');
        mouseEvents.push(type);
        if (type === 'mouseMoved' && options.hoverFormAction !== undefined) {
          const form = nodes.get(6);
          if (form) form.attributes = ['action', options.hoverFormAction];
        }
        return {} as T;
      }
      if (method === 'Input.dispatchKeyEvent') {
        keyEvents.push({ ...params });
        return {} as T;
      }
      return {} as T;
    },
  };
  const policy = new BrowserPolicy();
  policy.setControlLevel('interact');
  policy.beginTask('run-1');
  if (frameOrigin.startsWith('http')) {
    policy.setGrant({ origin: frameOrigin, read: true, interact: true, scope: 'task', allowPrivateNetwork: false });
  }
  return { refs, ref, cdp, policy, calls, mouseEvents, keyEvents, context };
}

describe('BrowserActionExecutor enforcement', () => {
  it('dispatches ref-based actions on an authorized local preview document', async () => {
    const token = 'a'.repeat(48);
    const fixture = setup({}, 'Save changes', {
      documentUrl: `fate-local://${token}/index.html`,
      frameOrigin: `fate-local://${token}`,
    });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await executor.click(fixture.context, { ref: fixture.ref });

    expect(fixture.calls).toContain('Input.dispatchMouseEvent');
  });

  it.each([
    ['a clickable ancestor', 'click-owner'],
    ['a descendant returned without a frontend node id', 'child-without-node-id'],
  ] as const)('clicks through %s without asking the model to recover', async (_label, hitTarget) => {
    const fixture = setup({}, 'Category A', { tagName: 'span', hitTarget });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await executor.click(ACTION_CONTEXT, { ref: fixture.ref });

    expect(fixture.mouseEvents).toContain('mousePressed');
  });

  it('rejects a different clickable ancestor instead of misclassifying its consequence', async () => {
    const fixture = setup({}, 'Category A', { tagName: 'span', hitTarget: 'click-owner', clickOwnerName: 'Delete account' });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await expect(executor.click(ACTION_CONTEXT, { ref: fixture.ref })).rejects.toThrow(/unobscured point/iu);

    expect(fixture.mouseEvents).not.toContain('mousePressed');
  });

  it('moves and pulses the page-owned virtual pointer without OS input', async () => {
    const fixture = setup({}, 'Category A');
    const pointer = { move: vi.fn(async () => undefined), click: vi.fn(async () => undefined) };
    const executor = new BrowserActionExecutor(
      fixture.cdp,
      fixture.refs,
      new BrowserActionGate(fixture.policy),
      async () => false,
      () => undefined,
      () => () => undefined,
      pointer,
    );

    await executor.click(ACTION_CONTEXT, { ref: fixture.ref });

    expect(pointer.move).toHaveBeenCalledWith({ x: 50, y: 20 }, 'button "Category A"');
    expect(pointer.click).toHaveBeenCalledWith({ x: 50, y: 20 });
  });

  it('derives and confirms a live ancestor form submission', async () => {
    const fixture = setup({ type: 'submit' }, 'Continue', { formAction: '/finish' });
    const confirm = vi.fn(async () => true);
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy), confirm);

    await executor.click(ACTION_CONTEXT, { ref: fixture.ref });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'submit', consequence: 'account', destinationUrl: 'https://example.test/finish' }),
      expect.any(String),
      expect.objectContaining({ tabId: 't1', documentEpoch: 1, ref: fixture.ref }),
    );
    expect(fixture.calls).toContain('Input.dispatchMouseEvent');
  });

  it('rejects a ref whose live semantic ancestor changed', async () => {
    const fixture = setup({}, 'Continue', { liveAncestorName: 'Different dialog' });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await expect(executor.click(ACTION_CONTEXT, { ref: fixture.ref })).rejects.toThrow(/no longer matches/iu);

    expect(fixture.calls).not.toContain('Input.dispatchMouseEvent');
  });

  it('blocks a live cross-origin href even when it was absent from the snapshot fingerprint', async () => {
    const fixture = setup({ href: 'https://receive.test/path' }, 'Continue', {
      tagName: 'a',
      omitStable: ['href'],
    });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await expect(executor.click(ACTION_CONTEXT, { ref: fixture.ref })).rejects.toThrow(/destination origin is not writable/iu);

    expect(fixture.calls).not.toContain('Input.dispatchMouseEvent');
  });

  it('uses the live document base URL when gating link destinations', async () => {
    const fixture = setup({ href: 'receive' }, 'Continue', {
      tagName: 'a',
      baseHref: 'https://receive.test/root/',
    });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await expect(executor.click(ACTION_CONTEXT, { ref: fixture.ref })).rejects.toThrow(/destination origin is not writable/iu);

    expect(fixture.calls).not.toContain('Input.dispatchMouseEvent');
  });

  it('classifies a live download attribute through the ActionGate', async () => {
    const fixture = setup({ href: '/export', download: 'report.csv' }, 'Export', { tagName: 'a' });
    const confirm = vi.fn(async () => true);
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy), confirm);

    await executor.click(ACTION_CONTEXT, { ref: fixture.ref });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'download', consequence: 'external-data-transfer', destinationUrl: 'https://example.test/export' }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('requires human takeover before submitting a form containing protected fields', async () => {
    const fixture = setup({ type: 'submit' }, 'Sign in', { formAction: '/session', sensitiveForm: true });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await expect(executor.click(ACTION_CONTEXT, { ref: fixture.ref })).rejects.toThrow(/Secrets/u);

    expect(fixture.calls).not.toContain('Input.dispatchMouseEvent');
  });

  it('blocks cross-origin form destinations without a writable destination grant', async () => {
    const fixture = setup({ type: 'submit' }, 'Continue', { formAction: 'https://receive.test/submit' });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await expect(executor.click(ACTION_CONTEXT, { ref: fixture.ref })).rejects.toThrow(/destination origin is not writable/iu);
    expect(fixture.calls).not.toContain('Input.dispatchMouseEvent');
  });

  it('rejects a form destination changed by a hover handler before mouse down', async () => {
    const fixture = setup({ type: 'submit' }, 'Continue', {
      formAction: '/safe',
      hoverFormAction: 'https://receive.test/changed',
    });
    const confirm = vi.fn(async () => true);
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy), confirm);

    await expect(executor.click(ACTION_CONTEXT, { ref: fixture.ref })).rejects.toThrow(/changed after hover/iu);

    expect(fixture.mouseEvents).toContain('mouseMoved');
    expect(fixture.mouseEvents).not.toContain('mousePressed');
  });

  it('confirms an explicitly granted cross-origin form and consumes its once grant', async () => {
    const fixture = setup({ type: 'submit' }, 'Send', { formAction: 'https://receive.test/submit' });
    fixture.policy.setGrant({ origin: 'https://receive.test', read: true, interact: true, scope: 'once', allowPrivateNetwork: false });
    const confirm = vi.fn(async () => true);
    const policyChanged = vi.fn();
    const releaseGuard = vi.fn();
    const beginGuard = vi.fn(() => releaseGuard);
    const executor = new BrowserActionExecutor(
      fixture.cdp,
      fixture.refs,
      new BrowserActionGate(fixture.policy),
      confirm,
      policyChanged,
      beginGuard,
    );

    await executor.click(ACTION_CONTEXT, { ref: fixture.ref });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'submit', destinationUrl: 'https://receive.test/submit' }),
      expect.any(String),
      expect.any(Object),
    );
    expect(fixture.policy.canInteract('https://receive.test')).toBe(false);
    expect(policyChanged).toHaveBeenCalledOnce();
    expect(beginGuard).toHaveBeenCalledWith(expect.objectContaining({ kind: 'submit', destinationUrl: 'https://receive.test/submit' }));
    expect(releaseGuard).toHaveBeenCalledOnce();
  });

  it('resolves form="id" associations before dispatch', async () => {
    const fixture = setup({ type: 'submit' }, 'Save', { formId: 'checkout', formAction: '/checkout' });
    const confirm = vi.fn(async () => true);
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy), confirm);

    await executor.click(ACTION_CONTEXT, { ref: fixture.ref });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'submit', destinationUrl: 'https://example.test/checkout' }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('blocks sensitive fields regardless of a public caller classification', async () => {
    const fixture = setup({ type: 'password' }, 'Password', { tagName: 'input' });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));
    await expect(executor.type(
      ACTION_CONTEXT,
      { ref: fixture.ref, text: 'do-not-send' },
    )).rejects.toThrow(/Secrets/u);
    expect(fixture.calls).not.toContain('Input.insertText');
  });

  it('blocks a live password attribute even when it was absent from the snapshot fingerprint', async () => {
    const fixture = setup({ type: 'password' }, 'Field', { tagName: 'input', omitStable: ['type'] });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await expect(executor.type(ACTION_CONTEXT, { ref: fixture.ref, text: 'do-not-send' })).rejects.toThrow(/Secrets/u);

    expect(fixture.calls).not.toContain('Input.insertText');
  });

  it('blocks payment-card text even when the live field is not marked sensitive', async () => {
    const fixture = setup({ type: 'text' }, 'Notes', { tagName: 'input' });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await expect(executor.type(ACTION_CONTEXT, { ref: fixture.ref, text: '4242 4242 4242 4242' })).rejects.toThrow(/Secrets/u);

    expect(fixture.calls).not.toContain('Input.insertText');
  });

  it('blocks credential-shaped text even when the live field is not marked sensitive', async () => {
    const fixture = setup({ type: 'text' }, 'Notes', { tagName: 'input' });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));
    await expect(executor.type(
      ACTION_CONTEXT,
      { ref: fixture.ref, text: 'Bearer abcdefghijklmnop' },
    )).rejects.toThrow(/Secrets/u);
    expect(fixture.calls).not.toContain('Input.insertText');
  });

  it.each(['TAB', 'tab', 'Tab'])('canonicalizes %s and dispatches a real Tab key', async (key) => {
    const fixture = setup({}, 'Focus target');
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await executor.press(ACTION_CONTEXT, key);

    expect(fixture.keyEvents).toEqual([
      expect.objectContaining({ type: 'keyDown', key: 'Tab', code: 'Tab' }),
      expect.objectContaining({ type: 'keyUp', key: 'Tab', code: 'Tab' }),
    ]);
  });

  it('dispatches modifier chords and printable keys through CDP', async () => {
    const fixture = setup({}, 'Focus target');
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await executor.press(ACTION_CONTEXT, 'Shift+Tab');

    expect(fixture.keyEvents[0]).toMatchObject({ type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8 });
  });

  it('routes Space activation of a focused submit button through destination policy', async () => {
    const fixture = setup({ type: 'submit' }, 'Send', {
      focused: true,
      formAction: 'https://receive.test/submit',
    });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await expect(executor.press(ACTION_CONTEXT, ' ')).rejects.toThrow(/destination origin is not writable/iu);

    expect(fixture.calls).not.toContain('Input.dispatchKeyEvent');
  });

  it.each(['Enter', 'Backspace', 'Delete', ' '])('blocks %s on a focused password field before keyboard dispatch', async (key) => {
    const fixture = setup({ type: 'password' }, 'Password', { tagName: 'input', focused: true });
    const executor = new BrowserActionExecutor(fixture.cdp, fixture.refs, new BrowserActionGate(fixture.policy));

    await expect(executor.press(ACTION_CONTEXT, key)).rejects.toThrow(/Secrets/u);

    expect(fixture.calls).not.toContain('Input.dispatchKeyEvent');
  });
});
