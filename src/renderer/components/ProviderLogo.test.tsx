import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderLogo, modelsDevLogoUrl, probeLogo, resetLogoProbeCacheForTests, prefetchProviderLogos } from './ProviderLogo';

function installImageProbe(result: 'load' | 'error') {
  const instances: object[] = [];
  // No `src` class field: an own property would shadow the prototype accessor.
  class FakeImage {
    onload?: () => void;
    onerror?: () => void;
    constructor() { instances.push(this); }
  }
  Object.defineProperty(FakeImage.prototype, 'src', {
    set(value: string) {
      (this as { _src?: string })._src = value;
      queueMicrotask(() => (result === 'load' ? this.onload?.() : this.onerror?.()));
    },
    get() { return (this as { _src?: string })._src ?? ''; },
  });
  vi.stubGlobal('Image', FakeImage);
  return instances;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetLogoProbeCacheForTests();
});

describe('modelsDevLogoUrl', () => {
  it('maps pi provider ids onto models.dev logo ids', () => {
    expect(modelsDevLogoUrl('anthropic')).toBe('https://models.dev/logos/anthropic.svg');
    expect(modelsDevLogoUrl('CrofAI')).toBe('https://models.dev/logos/crofai.svg');
    expect(modelsDevLogoUrl('openai-codex')).toBe('https://models.dev/logos/openai.svg');
    expect(modelsDevLogoUrl('bedrock')).toBe('https://models.dev/logos/amazon-bedrock.svg');
  });
});

describe('probeLogo', () => {
  it('resolves true when the logo loads and false on error', async () => {
    installImageProbe('load');
    expect(await probeLogo('https://models.dev/logos/crof.svg')).toBe(true);
    installImageProbe('error');
    expect(await probeLogo('https://models.dev/logos/ghost.svg')).toBe(false);
  });
});

describe('ProviderLogo', () => {
  it('paints the SVG as a mask over currentColor once loaded', async () => {
    installImageProbe('load');
    const { container } = render(<ProviderLogo providerId="crof" size={16} />);
    const box = container.querySelector('.provider-logo') as HTMLElement;
    await waitFor(() => expect(box.style.maskImage).toBe('url(https://models.dev/logos/crof.svg)'));
    expect(box.dataset.loaded).toBe('true');
    // currentColor painting comes from the stylesheet, not inline styles.
    expect(box.style.backgroundColor).toBe('');
    expect(box.querySelector('img')).toBeNull();
  });

  it('renders nothing (no placeholder square) while loading or after an error', async () => {
    installImageProbe('error');
    const { container } = render(<ProviderLogo providerId="crof" size={16} />);
    const box = container.querySelector('.provider-logo') as HTMLElement;
    await waitFor(() => expect(box.style.maskImage).toBe('none'));
    expect(box.dataset.loaded).toBeUndefined();
    expect(box.textContent).toBe('');
  });

  it('re-probes when the provider id changes', async () => {
    installImageProbe('load');
    const { container, rerender } = render(<ProviderLogo providerId="crof" />);
    await waitFor(() => expect((container.querySelector('.provider-logo') as HTMLElement).style.maskImage).toContain('crof.svg'));
    rerender(<ProviderLogo providerId="deepseek" />);
    await waitFor(() => expect((container.querySelector('.provider-logo') as HTMLElement).style.maskImage).toContain('deepseek.svg'));
  });

  it('memoizes probe results so repeated mounts reuse the first outcome', () => {
    const first = installImageProbe('load');
    const { unmount } = render(<ProviderLogo providerId="crof" />);
    unmount();
    render(<ProviderLogo providerId="crof" />);
    // One probe per URL: the second mount reuses the memoized result.
    expect(first.length).toBe(1);
    resetLogoProbeCacheForTests();
    const second = installImageProbe('load');
    render(<ProviderLogo providerId="crof" />);
    expect(second.length).toBe(1);
  });
});

describe('prefetchProviderLogos', () => {
  it('resolves once probes settle', async () => {
    installImageProbe('load');
    await expect(prefetchProviderLogos(['crof', 'deepseek'], 200)).resolves.toBeUndefined();
  });

  it('never exceeds its budget when probes hang', async () => {
    // jsdom Images never fire; the budget is the only resolution path.
    const started = Date.now();
    await prefetchProviderLogos(['slow-one', 'slow-two'], 150);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});
