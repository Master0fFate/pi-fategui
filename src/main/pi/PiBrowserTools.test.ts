// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { BrowserActionResult, SemanticPageSnapshot } from '../../shared/contracts/browser';
import { createPiBrowserTools, type PiBrowserToolHost } from './PiBrowserTools';

const snapshot: SemanticPageSnapshot = {
  tabId: 'tab-1',
  documentEpoch: 1,
  revision: 2,
  url: 'https://example.test/tasks?token=private#fragment',
  title: 'Tasks',
  mode: 'interactive',
  nodes: [{ ref: 'e1', role: 'button', name: 'Add task', depth: 1 }],
  serialized: 'page tab=tab-1 revision=2\n[e1] button "Add task"',
  nodeCount: 1,
  truncated: false,
};

function action(kind: BrowserActionResult['kind']): BrowserActionResult {
  return { tabId: 'tab-1', kind, target: 'button "Add task"', confirmed: false };
}

function fixture() {
  const host: PiBrowserToolHost = {
    navigate: vi.fn(async () => snapshot),
    snapshot: vi.fn(async () => snapshot),
    click: vi.fn(async () => ({ action: action('click'), snapshot })),
    type: vi.fn(async () => ({ action: action('type'), snapshot })),
    press: vi.fn(async () => ({ action: action('press'), snapshot })),
    scroll: vi.fn(async () => ({ action: action('scroll'), snapshot })),
    tabs: vi.fn(async () => [{ id: 'tab-1', title: 'Tasks', url: snapshot.url, active: true }]),
    createTab: vi.fn(async () => ({ tabId: 'tab-2', snapshot: null })),
    selectTab: vi.fn(async () => [{ id: 'tab-2', title: 'New', url: 'about:blank', active: true }]),
    closeTab: vi.fn(async () => [{ id: 'tab-1', title: 'Tasks', url: snapshot.url, active: true }]),
  };
  const tools = createPiBrowserTools(() => host);
  const context = { sessionManager: { getSessionId: () => 'session-1' } };
  return { host, tools, context };
}

function tool(name: string, tools = fixture().tools) {
  const result = tools.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}

describe('Pi browser tools', () => {
  it('registers only the bounded semantic first-cut surface', () => {
    const names = createPiBrowserTools(() => null).map((candidate) => candidate.name);
    expect(names).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_tabs',
    ]);
    expect(names).not.toContain('browser_evaluate');
  });

  it('binds snapshots to the root session and redacts result URLs', async () => {
    const { host, tools, context } = fixture();
    const result = await tool('browser_snapshot', tools).execute(
      'snapshot-1',
      { mode: 'interactive', scopeRef: 'e1', sinceRevision: 1 },
      undefined,
      undefined,
      context as never,
    );
    expect(host.snapshot).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'interactive', scopeRef: 'e1', sinceRevision: 1, sessionId: 'session-1',
    }));
    expect(result.content).toEqual([{ type: 'text', text: snapshot.serialized }]);
    expect(result.details).toMatchObject({ url: 'https://example.test/tasks', revision: 2 });
  });

  it('redacts secret-shaped tab titles and URL components', async () => {
    const { host, tools, context } = fixture();
    vi.mocked(host.tabs).mockResolvedValue([{
      id: 'tab-1', title: 'Reset token=super-secret-value', url: snapshot.url, active: true,
    }]);

    const result = await tool('browser_tabs', tools).execute('tabs-1', {}, undefined, undefined, context as never);

    expect(JSON.stringify(result)).not.toContain('super-secret-value');
    expect(JSON.stringify(result)).not.toContain('?token=private');
  });

  it('never echoes typed text in its result', async () => {
    const { host, tools, context } = fixture();
    const secretLikeText = 'private-value-that-must-not-be-echoed';
    const result = await tool('browser_type', tools).execute(
      'type-1',
      { ref: 'e1', text: secretLikeText, reason: 'Fill the public task title' },
      undefined,
      undefined,
      context as never,
    );
    expect(host.type).toHaveBeenCalledWith(expect.objectContaining({ ref: 'e1', text: secretLikeText, sessionId: 'session-1' }));
    expect(JSON.stringify(result)).not.toContain(secretLikeText);
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });

  it('creates a new tab through browser_tabs', async () => {
    const { host, tools, context } = fixture();
    const result = await tool('browser_tabs', tools).execute(
      'tabs-create',
      { action: 'create', url: 'https://example.test/new' },
      undefined,
      undefined,
      context as never,
    );
    expect(host.createTab).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.test/new', sessionId: 'session-1',
    }));
    expect(result.details).toMatchObject({ tabId: 'tab-2' });
  });

  it('fails clearly when no live browser host is attached', async () => {
    const browserSnapshot = tool('browser_snapshot', createPiBrowserTools(() => null));
    await expect(browserSnapshot.execute(
      'snapshot-1',
      {},
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => 'session-1' } } as never,
    )).rejects.toThrow('built-in browser is unavailable');
  });
});
