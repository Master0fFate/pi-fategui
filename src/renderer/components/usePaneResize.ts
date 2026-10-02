import { useCallback, useLayoutEffect, useState } from 'react';
import { clampResizeValue, resizeBounds } from './resizeBounds';

/** Keep the displayed size, interaction limits and separator ARIA in one range. */
export function usePaneResize(minimum: number, reservedHeight: number, defaultHeight = 240) {
  // A callback ref also observes panels mounted after an empty/loading state.
  const [container, panelRef] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState(() => {
    const bounds = resizeBounds(minimum, 900 - reservedHeight);
    return { ...bounds, height: clampResizeValue(defaultHeight, bounds) };
  });

  useLayoutEffect(() => {
    if (!container) return;
    const measure = () => {
      // Hidden or not-yet-laid-out panels have no usable measurement. Retain the
      // last range (or the existing 900px fallback) until they become visible.
      const containerHeight = container.clientHeight;
      if (!Number.isFinite(containerHeight) || containerHeight <= 0) return;
      const bounds = resizeBounds(minimum, containerHeight - reservedHeight);
      setSize((previous) => {
        const height = clampResizeValue(previous.height, bounds);
        return previous.minimum === bounds.minimum && previous.maximum === bounds.maximum && previous.height === height
          ? previous : { ...bounds, height };
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, minimum, reservedHeight]);

  const resize = useCallback((height: number) => {
    setSize((previous) => ({ ...previous, height: clampResizeValue(height, previous) }));
  }, []);

  return { panelRef, ...size, resize };
}
