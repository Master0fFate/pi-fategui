import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';

export function goalMaxStatusLabel(status: GoalMaxState['status']): string {
  switch (status) {
    case 'normalising': return 'Preparing';
    case 'active': return 'Pursuing';
    case 'paused': return 'Paused';
    case 'blocked': return 'Needs input';
    case 'verifying': return 'Checking completion';
    case 'completed': return 'Achieved';
    case 'cancelled': return 'Cancelled';
    case 'budget-limited': return 'Budget reached';
    case 'usage-limited': return 'Usage limited';
    case 'failed': return 'Needs attention';
  }
}
