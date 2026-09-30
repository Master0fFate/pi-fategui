import type { DesktopConnectionState } from '../../../shared/contracts/connections';

const messages: Record<DesktopConnectionState['message'], string> = {
  local: 'Execution stays on this computer.', selected: 'Host selected. Connect to verify it.',
  connecting: 'Authenticating the selected host.', ready: 'Host identity and connection verified.',
  disconnected: 'Connection lost. Host work may continue.', 'connection-failed': 'Connection failed. Check the host and retry.',
  'identity-mismatch': 'Server identity does not match this profile. Verify the host before reconnecting.',
  'protocol-incompatible': 'Server protocol is incompatible. Check the host package version.',
  'refresh-required': 'Refresh the selected workspace before sending new work.',
  'ssh-connecting': 'Opening the SSH tunnel.', 'ssh-unavailable': 'System OpenSSH is unavailable. Install or enable it on this computer.',
  'ssh-host-verification-required': 'SSH host key is unknown or changed. Verify it with your SSH tools before retrying.',
  'ssh-authentication-failed': 'SSH authentication failed. Check the approved SSH alias and key.',
  'ssh-port-collision': 'The local tunnel port is already in use. Choose a free port.',
  'ssh-stop-pending': 'The previous SSH tunnel has not stopped. Wait before opening another connection.',
  'profile-unhealthy': 'Host storage or required services are not ready. Repair the host before sending work.',
  'workspace-mismatch': 'The workspace ID or generation changed. Verify the selected host workspace.',
  'provider-auth-required': 'Host connection verified. Configure provider authorization on the execution host before sending work.',
};
export function ConnectionFeedback({ state }: { state: Pick<DesktopConnectionState, 'message' | 'providerStatus'> }) {
  return <span role="status">{messages[state.message]}
    {state.providerStatus === 'auth-required' && state.message !== 'provider-auth-required' && ' Provider authorization is required on the execution host.'}
  </span>;
}
