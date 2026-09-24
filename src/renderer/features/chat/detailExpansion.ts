import { useState } from 'react';

/** A command applies to the whole virtualized timeline, including rows not mounted yet. */
export interface DetailExpansionCommand {
  sessionKey: string | null;
  revision: number;
  expanded: boolean;
}

export function useDetailExpansion(command?: DetailExpansionCommand) {
  const [override, setOverride] = useState<DetailExpansionCommand | null>(null);
  const sessionKey = command?.sessionKey ?? null;
  const revision = command?.revision ?? 0;
  const expanded = override !== null && override.sessionKey === sessionKey && override.revision === revision
    ? override.expanded
    : command?.expanded ?? false;

  return {
    expanded,
    toggle: () => setOverride({ sessionKey, revision, expanded: !expanded }),
  };
}
