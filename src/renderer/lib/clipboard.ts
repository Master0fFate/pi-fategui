export async function writeClipboardText(text: string): Promise<void> {
  if ('piDesktop' in window && typeof window.piDesktop.writeClipboardText === 'function') {
    await window.piDesktop.writeClipboardText(text);
    return;
  }
  if (typeof navigator.clipboard?.writeText !== 'function') {
    throw new Error('The system clipboard is unavailable.');
  }
  await navigator.clipboard.writeText(text);
}
