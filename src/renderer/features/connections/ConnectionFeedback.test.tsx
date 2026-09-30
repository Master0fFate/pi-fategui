import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ConnectionFeedback } from './ConnectionFeedback';
it.each([
  ['ssh-host-verification-required', /SSH host key is unknown or changed/],
  ['ssh-authentication-failed', /SSH authentication failed/],
  ['profile-unhealthy', /Host storage or required services are not ready/],
  ['identity-mismatch', /Server identity does not match/],
  ['workspace-mismatch', /workspace ID or generation changed/],
  ['provider-auth-required', /Host connection verified. Configure provider authorization/],
] as const)('displays the safe stage message %s', (message, expected) => {
  render(<ConnectionFeedback state={{ message, providerStatus: 'auth-required' }} />);
  expect(screen.getByRole('status')).toHaveTextContent(expected);
});
