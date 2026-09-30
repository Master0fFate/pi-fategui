import { useLayoutEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { NetworkWorkspaceApi } from '../../../client/NetworkWorkspaceApi';
import { useRuntimeStore } from '../../stores/runtimeStore';

/** Identity for local text drafts only. This is not a mutation grant or host lifetime clock. */
export function draftScopeKey(api: NetworkWorkspaceApi | null | undefined): string {
  const state = useRuntimeStore.getState();
  if (!api) return JSON.stringify(['desktop', state.runtime.project?.path, state.runtime.sessionId]);
  const header = state.snapshot?.header;
  return JSON.stringify(['network', api.origin, api.authenticatedSessionId, api.hostId, api.serverEpoch,
    header?.serverEpoch, state.selected?.workspaceId, state.selected?.workspaceGeneration, header?.sessionId]);
}

/** Each caller supplies a typed, bounded text-only cache. No RuntimeState or authority is cached. */
export function useScopedDraft<T>(cache: Map<string, T>, key: string, initial: () => T): readonly [T, Dispatch<SetStateAction<T>>, () => void] {
  const [draft, setDraft] = useState<T>(() => cache.get(key) ?? initial());
  useLayoutEffect(() => { setDraft(cache.get(key) ?? initial()); }, [cache, key]);
  const write: Dispatch<SetStateAction<T>> = (update) => setDraft((previous) => {
    const next = typeof update === 'function' ? (update as (value: T) => T)(previous) : update;
    cache.delete(key); cache.set(key, next);
    while (cache.size > 24) { const first = cache.keys().next().value; if (first === undefined) break; cache.delete(first); }
    return next;
  });
  return [draft, write, () => { cache.delete(key); }] as const;
}
