import { Server } from 'lucide-react';
import { IconButton } from '../../components/IconButton';
import { useExecutionHost } from '../../platform/executionHost';
import { useUiStore } from '../../stores/uiStore';
import { connectionMessage, connectionTone } from './ConnectionFeedback';

/**
 * The one host control in the window chrome. It is absent while execution is
 * local and no host is saved, so a local-only user sees no host chrome at all.
 */
export function ExecutionHostButton() {
  const host = useExecutionHost();
  const openSettingsSection = useUiStore((state) => state.openSettingsSection);
  if (!host) return null;
  const { state, error } = host;
  if (!error && state?.kind === 'local' && host.profiles.length === 0) return null;
  const name = state?.kind === 'local' ? 'This computer' : state?.profile?.label ?? 'Selection unconfirmed';
  const tone = error || !state ? 'failed' : state.kind === 'local' ? 'local' : connectionTone(state);
  const detail = error ?? (state ? connectionMessage(state) : 'No local execution until a host is selected.');
  return (
    <IconButton label={`Execution host: ${name}. ${detail}`} terminalLabel="host" className="workspace-host-button"
      data-tone={tone} onClick={() => openSettingsSection('hosts')}>
      <Server size={17} />
    </IconButton>
  );
}
