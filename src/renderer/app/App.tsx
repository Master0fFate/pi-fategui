import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect } from 'react';
import { useRuntimeStore } from '../stores/runtimeStore';
import { AppShell } from './AppShell';

export function App() {
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const applyEvents = useRuntimeStore((state) => state.applyEvents);

  useEffect(() => {
    if (!('piDesktop' in window)) return;
    let cancelled = false;
    let hydrating = true;
    const bufferedEvents: Parameters<typeof applyEvents>[0] = [];
    const unsubscribe = window.piDesktop.onEvents((events) => {
      if (hydrating) bufferedEvents.push(...events);
      else applyEvents(events);
    });

    void window.piDesktop.getRuntimeState().then((runtime) => {
      if (cancelled) return;
      setRuntime(runtime);
      hydrating = false;
      if (bufferedEvents.length > 0) applyEvents(bufferedEvents);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyEvents, setRuntime]);

  return (
    <Tooltip.Provider>
      <AppShell />
    </Tooltip.Provider>
  );
}
