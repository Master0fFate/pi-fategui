import { getDesktopApi, getDesktopApiOptional, hasCapability } from '../platform/api';
export async function writeClipboardText(text: string): Promise<void> {
  if (hasCapability('clipboardText') && typeof getDesktopApiOptional()?.writeClipboardText === 'function') {
    await getDesktopApi().writeClipboardText(text);
    return;
  }
  if (typeof navigator.clipboard?.writeText !== 'function') {
    throw new Error('The system clipboard is unavailable.');
  }
  await navigator.clipboard.writeText(text);
}
