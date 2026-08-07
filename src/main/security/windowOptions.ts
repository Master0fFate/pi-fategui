import type { BrowserWindowConstructorOptions } from 'electron';

export const secureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
} as const satisfies BrowserWindowConstructorOptions['webPreferences'];
