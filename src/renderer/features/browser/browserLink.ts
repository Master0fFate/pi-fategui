import { normalizeBrowserWebUrl } from '../../../shared/contracts/browser';
import { useBrowserStore } from '../../stores/browserStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

export async function openBrowserLink(value: string): Promise<void> {
  const url = normalizeBrowserWebUrl(value);
  if (!url) return;

  const ui = useUiStore.getState();
  const browser = useBrowserStore.getState();
  const project = useRuntimeStore.getState().runtime.project;
  if (!project?.trusted) {
    ui.showToast({ kind: 'warning', title: 'Browser unavailable', message: 'Open and trust a project before opening links in the Browser workspace.' });
    return;
  }
  if (!('piDesktop' in window) || typeof window.piDesktop.navigateBrowser !== 'function') {
    ui.showToast({ kind: 'error', title: 'Browser unavailable', message: 'The desktop browser bridge is unavailable.' });
    return;
  }
  if (browser.pending) return;

  ui.setBrowserOpen(true);
  browser.setPending('navigation');
  browser.setError(null);
  try {
    browser.hydrate(await window.piDesktop.navigateBrowser(url));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The link could not be opened in the Browser workspace.';
    browser.setError(message);
    ui.showToast({ kind: 'error', title: 'Could not open link', message });
  } finally {
    useBrowserStore.getState().setPending(null);
  }
}
