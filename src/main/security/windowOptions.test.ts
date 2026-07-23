import { describe, expect, it } from 'vitest';
import { secureWebPreferences } from './windowOptions';

describe('BrowserWindow security', () => {
  it('keeps renderer privileges isolated and sandboxed', () => {
    expect(secureWebPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });
});
