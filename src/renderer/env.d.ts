/// <reference types="vite/client" />

import type { PiDesktopApi } from '../shared/contracts/ipc';

declare global {
  interface Window {
    readonly piDesktop: PiDesktopApi;
  }
}

export {};
