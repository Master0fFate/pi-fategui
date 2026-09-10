import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { BuiltInSkinId } from '../../shared/skins';
import { defaultComponents } from './default';
import { dreamcoreComponents } from './dreamcore';
import type { SkinComponents } from './types';

const components: Record<BuiltInSkinId, SkinComponents> = { default: defaultComponents, dreamcore: dreamcoreComponents };
const SkinContext = createContext(defaultComponents);
const snapshot = (): BuiltInSkinId => document.documentElement.dataset.skin === 'dreamcore' ? 'dreamcore' : 'default';
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
