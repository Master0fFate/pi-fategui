import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFateApi, resetFateApi, type RendererFateApi } from '../platform/api';
import { desktopHostCapabilities } from '../../shared/protocol/capabilities';
import { writeClipboardText } from './clipboard';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  resetFateApi();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('clipboard capability fallback', () => {
  it('uses the browser clipboard instead of disabled local IPC', async () => {
    const native = vi.fn(async () => undefined);
    const browser = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: browser } });
    const dispose = installFateApi({ desktop: { writeClipboardText: native } } as unknown as RendererFateApi,
      { ...desktopHostCapabilities, supported: { ...desktopHostCapabilities.supported, clipboardText: false } });
    await writeClipboardText('Text only');
    expect(native).not.toHaveBeenCalled();
    expect(browser).toHaveBeenCalledWith('Text only');
    dispose();
  });
});
