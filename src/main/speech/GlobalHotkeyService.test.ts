import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiohookKey } from 'uiohook-napi';
import { GlobalHotkeyService, parseAccelerator } from './GlobalHotkeyService';
import { startKeyboardHookProcess } from './keyboardHookProcess';

// Parsing accelerators must not load or download an Electron executable.
vi.mock('electron', () => ({ globalShortcut: {} }));

describe('GlobalHotkeyService.parseAccelerator', () => {
  it('maps a CommandOrControl combo to the platform primary modifier', () => {
    // CommandOrControl resolves to Control everywhere except macOS, where it
    // resolves to Command; the assertion must follow the running platform.
    const isMac = process.platform === 'darwin';
    const combo = parseAccelerator('CommandOrControl+Shift+Space', UiohookKey);
    expect(combo).not.toBeNull();
    expect(combo).toMatchObject(isMac
      ? { keycode: UiohookKey.Space, ctrl: false, shift: true, meta: true, alt: false }
      : { keycode: UiohookKey.Space, ctrl: true, shift: true, meta: false, alt: false });
  });

  it('maps explicit Command and Control tokens', () => {
    expect(parseAccelerator('Command+Space', UiohookKey)).toMatchObject({ keycode: UiohookKey.Space, meta: true, ctrl: false });
    expect(parseAccelerator('Control+Alt+N', UiohookKey)).toMatchObject({ keycode: UiohookKey.N, ctrl: true, alt: true });
  });

  it('maps letters, digits, and function keys', () => {
    expect(parseAccelerator('A', UiohookKey)).toMatchObject({ keycode: UiohookKey.A, ctrl: false });
    expect(parseAccelerator('5', UiohookKey)).toMatchObject({ keycode: (UiohookKey as unknown as Record<string, number>)['5'] });
    expect(parseAccelerator('Shift+F5', UiohookKey)).toMatchObject({ keycode: UiohookKey.F5, shift: true });
  });

  it('rejects modifier-only and unrecognized accelerators', () => {
    expect(parseAccelerator('Shift', UiohookKey)).toBeNull();
    expect(parseAccelerator('Ctrl+Alt+Nonsense', UiohookKey)).toBeNull();
    expect(parseAccelerator('', UiohookKey)).toBeNull();
  });
});

describe('GlobalHotkeyService keyboard hook lifetime', () => {
  function fixture() {
    const hook = { keys: UiohookKey as unknown as Record<string, number>, setCombo: vi.fn(), stop: vi.fn() };
    let listener: (event: 'down' | 'up') => void = () => undefined;
    const start = vi.fn(async (next: (event: 'down' | 'up') => void) => { listener = next; return hook; });
    const onStart = vi.fn(); const onStop = vi.fn();
    const service = new GlobalHotkeyService({ write: vi.fn() } as never, onStart, onStop, start);
    return { hook, start, service, onStart, onStop, emit: (event: 'down' | 'up') => listener(event) };
  }
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('does not start the keyboard hook on quit when push-to-talk never used it', async () => {
    const { hook, start, service } = fixture();
    service.dispose();
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(hook.stop).not.toHaveBeenCalled();
  });

  it('starts one hook for push-to-talk, follows its combination, and stops it on quit', async () => {
    const { hook, start, service, onStart, onStop, emit } = fixture();
    await expect(service.register('Control+Space', 'push-to-talk')).resolves.toEqual({ pushToTalkAvailable: true });
    expect(start).toHaveBeenCalledOnce();
    expect(hook.setCombo).toHaveBeenLastCalledWith(expect.objectContaining({ keycode: UiohookKey.Space, ctrl: true }));
    emit('down'); emit('down'); emit('up'); emit('up');
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    service.dispose();
    await settle();
    expect(hook.setCombo).toHaveBeenLastCalledWith(null);
    expect(hook.stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it('does not start the keyboard hook for a registration that arrives after quit began', async () => {
    const { hook, start, service } = fixture();
    service.dispose();
    // A settings save or a late startup step during shutdown.
    await expect(service.applySpeechSettings({ enabled: true, voiceHotkey: 'Control+Space', voiceHotkeyMode: 'push-to-talk' })).resolves.toEqual({ pushToTalkAvailable: true });
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(hook.setCombo).not.toHaveBeenCalled();
  });

  it('stops a hook whose start finished after quit began', async () => {
    const { hook, start, service } = fixture();
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { started = resolve; });
    start.mockImplementationOnce(async () => { await gate; return hook; });
    const registration = service.register('Control+Space', 'push-to-talk');
    service.dispose();
    started();
    await expect(registration).resolves.toEqual({ pushToTalkAvailable: true });
    await settle();
    expect(hook.setCombo).not.toHaveBeenCalled();
    expect(hook.stop).toHaveBeenCalled();
  });

  it('reports push-to-talk unavailable when the hook cannot start', async () => {
    const { start, service } = fixture();
    start.mockResolvedValueOnce(null as never);
    await expect(service.register('Control+Space', 'push-to-talk')).resolves.toMatchObject({ pushToTalkAvailable: false });
  });
});

describe('keyboard hook helper process', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  async function fakeHookModule(start: string): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fate-hook-'));
    roots.push(root);
    const file = path.join(root, 'hook.cjs');
    await writeFile(file, `const handlers = {};
exports.UiohookKey = { Space: 57 };
exports.uIOhook = { on: (name, handler) => { handlers[name] = handler; }, start: () => { ${start} } };`);
    return file;
  }

  it('reports only the registered combination going down and up', async () => {
    // The fake hook presses another key, then Control+Space, again and again.
    const modulePath = await fakeHookModule(`setInterval(() => {
      handlers.keydown({ keycode: 30, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
      handlers.keydown({ keycode: 57, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false });
      handlers.keyup({ keycode: 57 });
    }, 20);`);
    const events: string[] = [];
    const hook = await startKeyboardHookProcess((event) => events.push(event), { modulePath });
    expect(hook).not.toBeNull();
    try {
      expect(hook!.keys).toEqual({ Space: 57 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(events).toEqual([]); // No combination registered: nothing leaves the helper.
      hook!.setCombo({ keycode: 57, ctrl: true, alt: false, shift: false, meta: false });
      await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
      expect(events.slice(0, 2)).toEqual(['down', 'up']);
    } finally { hook!.stop(); }
  }, 20_000);

  it('gives up on a hook whose native start never returns, without blocking the caller', async () => {
    const modulePath = await fakeHookModule('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);');
    const began = Date.now();
    await expect(startKeyboardHookProcess(() => undefined, { modulePath, readyTimeoutMs: 700, attempts: 2 })).resolves.toBeNull();
    expect(Date.now() - began).toBeLessThan(15_000);
  }, 20_000);

  it('reports a hook module that cannot load as unavailable', async () => {
    await expect(startKeyboardHookProcess(() => undefined, { modulePath: path.join(os.tmpdir(), 'no-such-hook-module.cjs'), readyTimeoutMs: 5_000, attempts: 1 })).resolves.toBeNull();
  }, 20_000);
});
