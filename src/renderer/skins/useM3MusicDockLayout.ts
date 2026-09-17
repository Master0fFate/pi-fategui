import { useLayoutEffect, useSyncExternalStore, type RefObject } from 'react';
import { getAppliedSkin, subscribeSkinChanges } from '../skin';
import { useUiStore } from '../stores/uiStore';

const properties = ['--m3-music-left', '--m3-music-width', '--m3-music-bottom', '--m3-music-reserve'] as const;

/** The player remains mounted (including its audio element); only its geometry changes.
 * Measure instead of assuming the inspector's stored width or the player's content height.
 * Browser-shift and collapsed-inspector layouts keep the existing floating-dock behavior. */
export function useM3MusicDockLayout(panel: RefObject<HTMLElement>, enabled: boolean, open: boolean, browserInset: number): void {
  const skin = useSyncExternalStore(subscribeSkinChanges, getAppliedSkin, getAppliedSkin);
  const collapsed = useUiStore((state) => state.inspectorCollapsed);
  useLayoutEffect(() => {
    if (!enabled || skin.base !== 'm3-expressive' || collapsed || browserInset > 0) return;
    const inspector = document.querySelector<HTMLElement>('.inspector');
    if (!inspector || !panel.current) return;
    const root = document.documentElement;
    const measure = () => {
      const bounds = inspector.getBoundingClientRect();
      const inset = 12;
      const values = [bounds.left + inset, Math.max(0, bounds.width - inset * 2), window.innerHeight - bounds.bottom + inset, open ? panel.current!.offsetHeight + inset * 2 : 0];
      properties.forEach((property, index) => {
        const value = `${values[index]}px`;
        if (root.style.getPropertyValue(property) !== value) root.style.setProperty(property, value);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inspector);
    observer.observe(panel.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      properties.forEach((property) => root.style.removeProperty(property));
    };
  }, [panel, enabled, open, browserInset, collapsed, skin.base]);
}
