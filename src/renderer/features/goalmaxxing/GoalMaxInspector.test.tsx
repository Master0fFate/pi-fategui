import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useUiStore } from '../../stores/uiStore';
import { GoalMaxInspector } from './GoalMaxInspector';

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data = [], itemContent }: { data?: readonly unknown[]; itemContent: (index: number, item: never) => React.ReactNode }) => (
    <div>{data.map((item, index) => <React.Fragment key={index}>{itemContent(index, item as never)}</React.Fragment>)}</div>
  ),
}));

function goal(): GoalMaxState {
  const now = Date.now();
  return {
    schemaVersion: 2, id: 'goal-1', sessionId: 's1', projectPath: '/project', revision: 3,
    objective: 'Debug the GoalMax lifecycle', originalBriefRef: null, originalBriefHash: null,
    status: 'active', phase: 'validation', executionState: 'idle', verificationLevel: 'normal', agentStrategy: 'auto',
    criteria: [{ id: 'criterion-1', title: 'Verified', description: '', required: true, status: 'satisfied', evidenceIds: ['evidence-1'], ownerNodeIds: [], updatedAt: now }],
    budget: { tokenLimit: null, timeLimitMs: null, source: null },
    permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: now },
    progress: { meaningfulTurnCount: 1, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 1, baselineWorkspaceFingerprint: 'a', latestWorkspaceFingerprint: 'b', latestEvidenceAt: now, latestMeaningfulProgressAt: now, lastFailureFingerprint: null },
    evidence: [{ id: 'evidence-1', kind: 'test', title: 'Tests passed', summary: '', criterionIds: ['criterion-1'], source: 'root-tool', timestamp: now, current: true, command: 'pnpm test', exitCode: 0 }],
    continuation: { pending: false, attempt: 1, lastScheduledAt: now, lastSettledAt: now, reason: null },
    steering: [],
    childAssignments: [], tokensUsed: 100, tokenBaseline: 0, elapsedMs: 1_000,
    timeline: [
      { id: 'event-created', type: 'goal.created', summary: 'Goal created', timestamp: now - 2_000, revision: 1 },
      { id: 'event-verifying', type: 'verification.started', summary: 'Verification started', timestamp: now - 1_000, revision: 2 },
      { id: 'event-passed', type: 'verification.passed', summary: 'Verification passed', timestamp: now, revision: 3 },
    ],
    createdAt: now - 2_000, updatedAt: now, startedAt: now - 2_000, completedAt: null, blockedReason: null, failure: null,
  };
}

beforeEach(() => {
  useGoalMaxStore.setState({ projectPath: '/project', sessionId: 's1', goal: goal(), loading: false, selectionGeneration: 1 });
  useUiStore.setState({ inspectorTab: 'goal', toast: null });
});

describe('GoalMax inspector', () => {
  it('renders lifecycle events as an oldest-to-newest linear timeline', async () => {
    const user = userEvent.setup();
    const { container } = render(<GoalMaxInspector />);

    await user.click(screen.getByRole('tab', { name: 'Timeline' }));

    const rows = [...container.querySelectorAll<HTMLElement>('.goalmax-timeline-row')];
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual(['Goal created', 'Verification started', 'Verification passed']);
    expect(rows[0]).toHaveAttribute('data-first', 'true');
    expect(rows[0]).toHaveAttribute('data-tone', 'active');
    expect(rows[1]).not.toHaveAttribute('data-first');
    expect(rows[2]).toHaveAttribute('data-last', 'true');
    expect(rows[2]).toHaveAttribute('data-tone', 'success');
    expect(rows.every((row) => Boolean(row.querySelector('.goalmax-timeline-rail')))).toBe(true);
  });
});
