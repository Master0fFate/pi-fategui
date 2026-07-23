import * as Tooltip from '@radix-ui/react-tooltip';
import { AppShell } from './AppShell';

export function App() {
  return (
    <Tooltip.Provider>
      <AppShell />
    </Tooltip.Provider>
  );
}
