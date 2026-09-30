import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FateApi } from '../../src/client/FateApi';
import type { PiDesktopApi } from '../../src/shared/contracts/ipc';
import { createDesktopFateApi } from '../../src/renderer/platform/DesktopFateApi';
import { getDesktopApi, getFateApi, getFateApiOptional, installDesktopFateApi, installFateApi, resetFateApi } from '../../src/renderer/platform/api';

const fake = (onEvents: FateApi['onEvents']): FateApi => ({
  onEvents,
  getRuntimeState: vi.fn(async () => ({ status: 'disconnected', project: null, sessionId: null, sessionFile: null,
    streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null })),
  getMonitorDashboard: vi.fn(),
} as unknown as FateApi);

afterEach(() => { resetFateApi(); vi.unstubAllGlobals(); });

describe('renderer API contract', () => {
  it('uses a fake without a desktop bridge and rejects double installation', async () => {
    const onEvents = vi.fn(() => vi.fn());
    const dispose = installFateApi(fake(onEvents));
    expect(getFateApi().desktop).toBeUndefined();
    expect((await getFateApi().getRuntimeState()).status).toBe('disconnected');
    expect(() => installFateApi(fake(onEvents))).toThrow(/already installed/i);
    dispose();
  });

  it('registers one event sink, revokes it on replacement, and rejects a second sink', () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const first = vi.fn(() => firstCleanup);
    const second = vi.fn(() => secondCleanup);
    const dispose = installFateApi(fake(first));
    const listener = vi.fn();
    const unsubscribe = getFateApi().onEvents(listener);
    expect(() => getFateApi().onEvents(listener)).toThrow(/already subscribed/i);
    expect(first).toHaveBeenCalledTimes(1);
    dispose();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    const disposeSecond = installFateApi(fake(second));
    getFateApi().onEvents(listener);
    disposeSecond();
    expect(secondCleanup).toHaveBeenCalledTimes(1);
  });

  it('bootstraps before rendering and replaces a desktop fixture without stale sinks', () => {
    const firstCleanup = vi.fn();
    const firstBridge = Object.assign(fake(vi.fn(() => firstCleanup)), { getAppInfo: vi.fn() }) as unknown as PiDesktopApi;
    vi.stubGlobal('window', { piDesktop: firstBridge });
    installDesktopFateApi();
    expect(getFateApi().getRuntimeState).toBe(firstBridge.getRuntimeState);
    expect(getDesktopApi().getAppInfo).toBe(firstBridge.getAppInfo);
    expect(getFateApi().onEvents(vi.fn())).toBeTypeOf('function');
    resetFateApi();
    expect(firstCleanup).toHaveBeenCalledOnce();
    const nextCleanup = vi.fn();
    const nextBridge = Object.assign(fake(vi.fn(() => nextCleanup)), { getAppInfo: vi.fn() }) as unknown as PiDesktopApi;
    vi.stubGlobal('window', { piDesktop: nextBridge });
    expect(getFateApiOptional()?.getRuntimeState).toBe(nextBridge.getRuntimeState);
    getFateApi().onEvents(vi.fn());
    vi.stubGlobal('window', { piDesktop: firstBridge });
    expect(getFateApiOptional()?.getRuntimeState).toBe(firstBridge.getRuntimeState);
    expect(nextCleanup).toHaveBeenCalledOnce();
  });

  it('cleans desktop-only listeners as well when the owning facade is replaced', () => {
    const cleanup = vi.fn();
    const onAppCommand = vi.fn(() => cleanup);
    const bridge = Object.assign(fake(vi.fn(() => () => undefined)), { onAppCommand }) as unknown as PiDesktopApi;
    const dispose = installFateApi(createDesktopFateApi(bridge));
    getFateApi().desktop?.onAppCommand(vi.fn());
    expect(onAppCommand).toHaveBeenCalledTimes(1);
    dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('never projects an arbitrary channel from a supplied adapter or preload bridge', () => {
    const sneaky = Object.assign(fake(vi.fn(() => () => undefined)), { invoke: vi.fn() });
    const dispose = installFateApi(sneaky);
    expect('invoke' in getFateApi()).toBe(false);
    dispose();
    const desktop = createDesktopFateApi(sneaky as unknown as PiDesktopApi);
    expect('invoke' in desktop).toBe(false);
    expect('invoke' in desktop.desktop).toBe(false);
    const disposeDesktop = installFateApi(desktop);
    expect('invoke' in getFateApi()).toBe(false);
    expect('invoke' in getDesktopApi()).toBe(false);
    disposeDesktop();
    const disposeInjected = installFateApi({ ...sneaky, desktop: sneaky as unknown as PiDesktopApi });
    expect('invoke' in getFateApi()).toBe(false);
    expect('invoke' in getDesktopApi()).toBe(false);
    disposeInjected();
  });

  it('confines production window bridge reads to platform adapter modules', () => {
    const root = join(process.cwd(), 'src', 'renderer');
    const violations: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { visit(path); continue; }
        if (!/\.(tsx?|jsx?)$/.test(entry.name) || /\.(test|spec)\./.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
        const source = readFileSync(path, 'utf8');
        if (/\bwindow\s*(?:\.\s*piDesktop|\[\s*['"]piDesktop['"]\s*\])|['"]piDesktop['"]\s+in\s+window/.test(source)
          && !relative(root, path).replaceAll('\\', '/').startsWith('platform/')) {
          violations.push(relative(root, path).replaceAll('\\', '/'));
        }
      }
    };
    visit(root);
    expect(violations).toEqual([]);
  });
});
