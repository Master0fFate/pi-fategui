import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useState } from 'react';

/** A command applies to the whole virtualized timeline, including rows not mounted yet. */
export interface DetailExpansionCommand {
  sessionKey: string | null;
  revision: number;
  expanded: boolean;
}

export const detailSessionKey = (projectPath: string | null, sessionId: string | null) =>
  sessionId === null ? null : JSON.stringify([projectPath, sessionId]);

export function DetailExpansionToggle({ command, onToggle }: { command: DetailExpansionCommand; onToggle: () => void }) {
  return <button className="conversation-detail-toggle" type="button"
    aria-label={command.expanded ? 'Collapse all reasoning and tools' : 'Expand all reasoning and tools'}
    onClick={onToggle}
  >
    {command.expanded ? <ChevronsDownUp size={11} aria-hidden="true" /> : <ChevronsUpDown size={11} aria-hidden="true" />}
    <span>{command.expanded ? 'Collapse details' : 'Expand details'}</span>
  </button>;
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
