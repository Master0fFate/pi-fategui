import { describe, expect, it } from 'vitest';
import { appInfoSchema, getAppInfoInputSchema, ipcChannels } from './ipc';

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

  it('uses an explicit allowlisted channel name', () => {
    expect(ipcChannels).toEqual({ systemGetInfo: 'system:get-info' });
  });
});
