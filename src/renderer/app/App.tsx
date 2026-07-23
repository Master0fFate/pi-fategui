import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect } from 'react';
import { useRuntimeStore } from '../stores/runtimeStore';
import { AppShell } from './AppShell';

export function App() {
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const applyEvents = useRuntimeStore((state) => state.applyEvents);

  useEffect(() => {
    if (!('piDesktop' in window)) return;
    void window.piDesktop.getRuntimeState().then(setRuntime);
    return window.piDesktop.onEvents(applyEvents);
  }, [applyEvents, setRuntime]);

  return (
    <Tooltip.Provider>
      <AppShell />
    </Tooltip.Provider>
  );
}
