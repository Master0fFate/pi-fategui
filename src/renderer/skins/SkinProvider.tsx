import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { BuiltInSkinId } from '../../shared/skins';
import { defaultComponents } from './default';
import { dreamcoreComponents } from './dreamcore';
import { m3ExpressiveComponents } from './m3Expressive';
import type { SkinComponents } from './types';

const components: Record<BuiltInSkinId, SkinComponents> = { default: defaultComponents, dreamcore: dreamcoreComponents, 'm3-expressive': m3ExpressiveComponents };
const SkinContext = createContext(defaultComponents);
const snapshot = (): BuiltInSkinId => {
  const skin = document.documentElement.dataset.skin;
  return skin === 'dreamcore' || skin === 'm3-expressive' ? skin : 'default';
};
const serverSnapshot = (): BuiltInSkinId => 'default';
const subscribe = (notify: () => void) => {
  window.addEventListener('fate-skin-change', notify);
  return () => window.removeEventListener('fate-skin-change', notify);
};

export function SkinProvider({ children }: { children: ReactNode }) {
  const skinId = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return <SkinContext.Provider value={components[skinId]}>{children}</SkinContext.Provider>;
}

export const useSkinComponents = () => useContext(SkinContext);
