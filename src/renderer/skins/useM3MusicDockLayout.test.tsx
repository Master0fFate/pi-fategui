import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applySkin } from '../skin';
import { useUiStore } from '../stores/uiStore';
import { useM3MusicDockLayout } from './useM3MusicDockLayout';

function Player({ browserInset = 0 }: { browserInset?: number }) {
  const panel = useRef<HTMLElement | null>(null);
  useM3MusicDockLayout(panel, true, browserInset);
  return <section ref={panel} />;
}

afterEach(() => { cleanup(); document.querySelector('.inspector')?.remove(); applySkin('default'); vi.unstubAllGlobals(); });

describe('M3 dock geometry', () => {
  it('measures equal inspector insets without reserving a footer, and cleans up for other layouts', () => {
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
    useUiStore.setState({ inspectorCollapsed: false });
    const inspector = document.createElement('aside');
    inspector.className = 'inspector';
    inspector.getBoundingClientRect = () => ({ left: 1000, width: 300, bottom: 750 } as DOMRect);
    document.body.append(inspector);
    applySkin('m3-expressive');
    const view = render(<Player />);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--m3-music-left')).toBe('1012px');
    expect(style.getPropertyValue('--m3-music-width')).toBe('276px');
    expect(style.getPropertyValue('--m3-music-bottom')).toBe(`${innerHeight - 750 + 12}px`);
    expect(style.getPropertyValue('--m3-music-reserve')).toBe('');
    view.rerender(<Player browserInset={400} />);
    expect(style.getPropertyValue('--m3-music-width')).toBe('');
    view.rerender(<Player />);
    act(() => { applySkin('default'); });
    expect(style.getPropertyValue('--m3-music-reserve')).toBe('');
    expect(disconnect).toHaveBeenCalled();
  });
});
