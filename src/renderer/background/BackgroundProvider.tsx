import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getAppliedSkin, subscribeSkinChanges } from '../skin';
import { loadBackground, saveBackground, type BackgroundImage } from './storage';

interface BackgroundState {
  record: BackgroundImage | null;
  ready: boolean;
  error: string | null;
  save: (record: BackgroundImage | null) => Promise<void>;
}
const BackgroundContext = createContext<BackgroundState>({ record: null, ready: false, error: null, save: async () => { throw new Error('Background storage is unavailable.'); } });

export function BackgroundProvider({ children }: { children: ReactNode }) {
  const [record, setRecord] = useState<BackgroundImage | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadBackground().then((saved) => { if (active) setRecord(saved); }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Background storage is unavailable.');
    }).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);
  const save = useCallback(async (next: BackgroundImage | null) => {
    await saveBackground(next);
    setRecord(next);
    setError(null);
  }, []);
  return <BackgroundContext.Provider value={{ record, ready, error, save }}>{children}</BackgroundContext.Provider>;
}

export const useBackground = () => useContext(BackgroundContext);

export function WorkspaceBackground() {
  const { record } = useBackground();
  const skin = useSyncExternalStore(subscribeSkinChanges, getAppliedSkin, getAppliedSkin);
  const [url, setUrl] = useState<string | null>(null);
  const image = record?.image;
  useEffect(() => {
    if (!image) { setUrl(null); return; }
    const next = URL.createObjectURL(image);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [image]);
  const background = record && url ? { maskImage: `url("${url}")`, opacity: record.opacity }
    : skin.background ? { maskImage: `url("data:image/png;base64,${skin.background.data}")`, opacity: skin.background.opacity } : null;
  return background ? <div className="workspace-backdrop" aria-hidden="true" data-source={record && url ? 'personal' : 'skin-pack'} style={background} /> : null;
}
