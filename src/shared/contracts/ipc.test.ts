import { describe, expect, it } from 'vitest';
import { appInfoSchema, getAppInfoInputSchema, ipcChannels, piEventBatchSchema, promptInputSchema, runtimeStateSchema } from './ipc';

describe('IPC contracts', () => {
  it('accepts only an empty object for system info input', () => {
    expect(getAppInfoInputSchema.parse({})).toEqual({});
    expect(() => getAppInfoInputSchema.parse({ unexpected: true })).toThrow();
    expect(() => getAppInfoInputSchema.parse(undefined)).toThrow();
  });

  it('validates normalized app information', () => {
    expect(
      appInfoSchema.parse({ name: 'Pi Desktop', version: '0.1.0', platform: 'win32', packaged: false }),
    ).toEqual({ name: 'Pi Desktop', version: '0.1.0', platform: 'win32', packaged: false });
    expect(() =>
      appInfoSchema.parse({ name: 'Other', version: '', platform: 'browser', packaged: 'no' }),
    ).toThrow();
  });

  it('uses an explicit allowlist without duplicate channels', () => {
    expect(ipcChannels.systemGetInfo).toBe('system:get-info');
    expect(ipcChannels.runtimePrompt).toBe('runtime:prompt');
    expect(new Set(Object.values(ipcChannels)).size).toBe(Object.values(ipcChannels).length);
  });

  it('rejects malformed runtime commands and oversized event batches', () => {
    expect(promptInputSchema.parse({ text: 'hello', behavior: 'prompt' })).toEqual({ text: 'hello', behavior: 'prompt' });
    expect(() => promptInputSchema.parse({ text: '', extra: true })).toThrow();
    expect(() => piEventBatchSchema.parse(Array.from({ length: 101 }, () => ({ type: 'run.started', runId: 'r', timestamp: 1 })))).toThrow();
    expect(() => runtimeStateSchema.parse({ status: 'ready' })).toThrow();
  });
});
