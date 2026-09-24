import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ipcChannels } from '../shared/contracts/ipc';

const electron = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: electron }));
import { discardResult, ignoreResult, invoke, subscribe, unwrapResult } from './transport';

const inputSchema = z.object({ text: z.string().trim().default('default') }).strict();
const outputSchema = z.object({ accepted: z.literal(true) }).strict();

beforeEach(() => { vi.resetAllMocks(); });

describe('validated preload transport', () => {
  it('validates and normalizes input before IPC and validates the response', async () => {
    electron.invoke.mockResolvedValue({ accepted: true });
    await expect(invoke(ipcChannels.runtimePrompt, inputSchema, outputSchema, { text: ' hello ' })).resolves.toEqual({ accepted: true });
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.runtimePrompt, { text: 'hello' });
    electron.invoke.mockResolvedValue({ accepted: false });
    await expect(invoke(ipcChannels.runtimePrompt, inputSchema, outputSchema, { text: 'hello' })).rejects.toThrow();
  });

  it('rejects invalid requests asynchronously without invoking Electron', async () => {
    let result: Promise<unknown> | undefined;
    expect(() => { result = invoke(ipcChannels.runtimePrompt, inputSchema, outputSchema, { extra: true }); }).not.toThrow();
    await expect(result).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it('distinguishes pathless calls from an explicitly missing required argument', async () => {
    electron.invoke.mockResolvedValue({ accepted: true });
    await invoke(ipcChannels.runtimePrompt, inputSchema, outputSchema);
    expect(electron.invoke).toHaveBeenCalledWith(ipcChannels.runtimePrompt, { text: 'default' });
    electron.invoke.mockClear();
    await expect(invoke(ipcChannels.runtimePrompt, inputSchema, outputSchema, undefined)).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it('does not JSON-serialize binary inputs', async () => {
    const audio = new ArrayBuffer(16);
    await invoke(ipcChannels.speechStreamFeed, z.object({ audio: z.instanceof(ArrayBuffer) }), ignoreResult, { audio });
    expect(electron.invoke.mock.calls[0]?.[1].audio).toBe(audio);
  });

  it('validates acknowledgments even when their values are discarded', async () => {
    electron.invoke.mockResolvedValue({ accepted: true });
    await expect(invoke(ipcChannels.runtimePrompt, inputSchema, discardResult(outputSchema))).resolves.toBeUndefined();
    electron.invoke.mockResolvedValue({ accepted: false });
    await expect(invoke(ipcChannels.runtimePrompt, inputSchema, discardResult(outputSchema))).rejects.toThrow();
  });

  it('preserves rejected invocations and serialized service errors', async () => {
    const failure = new Error('IPC failed');
    electron.invoke.mockRejectedValue(failure);
    await expect(invoke(ipcChannels.runtimePrompt, inputSchema, outputSchema)).rejects.toBe(failure);
    const error = { code: 'INVALID_REQUEST', message: 'Music disabled', retryable: false };
    expect(() => unwrapResult({ ok: false, error })).toThrow(JSON.stringify(error));
    const value = { tracks: [] };
    expect(unwrapResult({ ok: true, value })).toBe(value);
  });
});

describe('validated subscriptions', () => {
  it('isolates each listener and removes only its own handler', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = subscribe(ipcChannels.windowState, outputSchema, first);
    subscribe(ipcChannels.windowState, outputSchema, second);
    const handler = electron.on.mock.calls[0]?.[1];
    handler({}, { accepted: true });
    expect(first).toHaveBeenCalledWith({ accepted: true });
    expect(second).not.toHaveBeenCalled();
    expect(() => handler({}, { accepted: false })).toThrow();
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith(ipcChannels.windowState, handler);
  });

  it('can drop malformed event batches without swallowing listener failures', () => {
    const listener = vi.fn();
    const invalid = vi.fn();
    subscribe(ipcChannels.runtimeEvents, outputSchema, listener, invalid);
    const handler = electron.on.mock.calls[0]?.[1];
    expect(() => handler({}, { accepted: false })).not.toThrow();
    expect(invalid).toHaveBeenCalledExactlyOnceWith(expect.any(z.ZodError));
    expect(listener).not.toHaveBeenCalled();
    listener.mockImplementation(() => { throw new Error('listener failed'); });
    expect(() => handler({}, { accepted: true })).toThrow('listener failed');
    expect(invalid).toHaveBeenCalledTimes(1);
  });
});
