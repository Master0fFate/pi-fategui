import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { GoalMaxTaskStrip } from './GoalMaxTaskStrip';

function buildGoal(overrides: Partial<GoalMaxState> = {}): GoalMaxState {
  return {
    schemaVersion: 2, id: 'goal-1', sessionId: 's1', projectPath: '/project', revision: 1,
    objective: 'Ship the GoalMax task strip', originalBriefRef: null, originalBriefHash: null,
    status: 'active', phase: 'implementation', executionState: 'idle', verificationLevel: 'normal', agentStrategy: 'auto',
    criteria: [
      { id: 'criterion-research', title: 'Research dense row layout', description: 'Survey existing dense row patterns', required: true, status: 'satisfied', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 },
      { id: 'criterion-implement', title: 'Build the collapsible strip', description: '', required: true, status: 'active', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 },
      { id: 'criterion-optional', title: 'Optional polish pass', description: '', required: false, status: 'pending', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 },
    ],
    budget: { tokenLimit: null, timeLimitMs: null, source: null },
    permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: 1 },
    progress: { meaningfulTurnCount: 1, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 1, baselineWorkspaceFingerprint: 'a', latestWorkspaceFingerprint: 'b', latestEvidenceAt: null, latestMeaningfulProgressAt: 1, lastFailureFingerprint: null },
    evidence: [], continuation: { pending: false, attempt: 1, lastScheduledAt: 1, lastSettledAt: 1, reason: null }, steering: [], childAssignments: [],
    tokensUsed: 0, tokenBaseline: 0, elapsedMs: 0, timeline: [], createdAt: 1, updatedAt: 1, startedAt: 1, completedAt: null, blockedReason: null, failure: null,
    ...overrides,
  };
}

beforeEach(() => {
  useGoalMaxStore.setState({ projectPath: '/project', sessionId: 's1', goal: buildGoal(), loading: false, selectionGeneration: 1 });
});
afterEach(() => useGoalMaxStore.setState({ goal: null }));

describe('GoalMax task strip', () => {
  it('shows the active criterion and the required satisfied/total count', () => {
    render(<GoalMaxTaskStrip />);
    const strip = screen.getByRole('region', { name: 'GoalMax task strip' });
    expect(strip).toHaveTextContent('Build the collapsible strip');
    expect(strip).toHaveTextContent('1/2 required');
  });

  it('expands to a dense criterion list and collapses again', async () => {
    const user = userEvent.setup();
    render(<GoalMaxTaskStrip />);
    await user.click(screen.getByRole('button', { name: 'Expand goal criteria' }));
    const list = screen.getByRole('list', { name: 'Goal criteria status' });
    expect(list).toHaveTextContent('Research dense row layout');
    expect(list).toHaveTextContent('Survey existing dense row patterns');
    expect(list).toHaveTextContent('Satisfied');
    expect(list).toHaveTextContent('Optional polish pass');
    expect(list).toHaveTextContent('Pending');
    await user.click(screen.getByRole('button', { name: 'Collapse goal criteria' }));
    expect(screen.queryByRole('list', { name: 'Goal criteria status' })).toBeNull();
  });

  it('renders nothing when no goal is active', () => {
    useGoalMaxStore.setState({ goal: null });
    const { container } = render(<GoalMaxTaskStrip />);
    expect(container).toBeEmptyDOMElement();
  });
});
