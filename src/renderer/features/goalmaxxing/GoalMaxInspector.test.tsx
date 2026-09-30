import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useUiStore } from '../../stores/uiStore';
import { currentNetworkScope, useRuntimeStore } from '../../stores/runtimeStore';
import { installFateApi, resetFateApi } from '../../platform/api';
import { alpha, networkFixture } from '../../app/networkFixture.testSupport';
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
  useRuntimeStore.getState().reset();
  useGoalMaxStore.setState({ projectPath: '/project', sessionId: 's1', goal: goal(), loading: false, selectionGeneration: 1,
    networkScopeKey: null, network: { status: 'unavailable' } });
  useUiStore.setState({ inspectorTab: 'goal', toast: null });
});

afterEach(() => {
  resetFateApi();
  useRuntimeStore.getState().reset();
});

describe('GoalMax inspector', () => {
  it('renders the desktop empty goal with no Monitor navigation or network scope', () => {
    useGoalMaxStore.setState({ goal: null });
    expect(useRuntimeStore.getState().networkNavigation).toBeNull();
    expect(currentNetworkScope()).toBeNull();

    render(<GoalMaxInspector />);

    expect(screen.getByText('No active goal')).toBeVisible();
    expect(screen.getByText('Start one with /goalmax followed by an objective.')).toBeInTheDocument();
    expect(screen.queryByText('Selected from Monitor')).not.toBeInTheDocument();
  });

  it.each(['unselected', 'synchronizing', 'disconnected'] as const)('shows an unavailable host goal without navigation in the %s state', (phase) => {
    const f = networkFixture();
    installFateApi({ ...f.api.shared, web: f.api });
    useRuntimeStore.getState().select(phase === 'unselected' ? null : alpha);
    if (phase === 'disconnected') useRuntimeStore.getState().disconnect();
    expect(useRuntimeStore.getState().networkNavigation).toBeNull();
    expect(currentNetworkScope()).toBeNull();

    render(<GoalMaxInspector />);

    expect(screen.getByRole('status')).toHaveTextContent(phase === 'unselected'
      ? 'Goal read unavailable. Refresh this workspace.' : 'Goal is not current; host work may continue.');
    expect(screen.queryByText('No active goal')).not.toBeInTheDocument();
    expect(screen.queryByText('Debug the GoalMax lifecycle')).not.toBeInTheDocument();
    expect(f.api.readGoal).not.toHaveBeenCalled();
    expect(f.api.controlGoal).not.toHaveBeenCalled();
  });

  it('focuses only an explicit criterion target from the current network scope', async () => {
    const f = networkFixture();
    f.host.goal = { id: 'host-goal', revision: 2, objective: 'Host objective', status: 'active', phase: 'implementation', executionState: 'idle',
      criteria: ['criterion-other', 'criterion-target'].map((id) => ({ id, title: id, description: '', required: true, status: 'pending' as const,
        evidenceIds: [], ownerNodeIds: [], updatedAt: 1000 })), evidence: [], continuationPending: false, updatedAt: 1000 };
    installFateApi({ ...f.api.shared, web: f.api });
    await act(async () => {
      await useRuntimeStore.getState().initialize(f.api);
      await useRuntimeStore.getState().refresh(f.api);
      await useGoalMaxStore.getState().loadNetwork(f.api);
    });
    const scope = currentNetworkScope();
    if (!scope) throw new Error('Fixture did not establish a current network scope.');
    const { container } = render(<GoalMaxInspector />);
    expect(useRuntimeStore.getState().networkNavigation).toBeNull();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Host objective')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-network-focus="true"]')).toHaveLength(0);

    const target = { kind: 'goal-criterion', goalId: 'host-goal', criterionId: 'criterion-target' } as const;
    act(() => useRuntimeStore.setState({ networkNavigation: { scopeKey: `${scope.key}:stale`, target } }));
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Selected from Monitor')).not.toBeInTheDocument();

    act(() => useRuntimeStore.setState({ networkNavigation: { scopeKey: scope.key, target } }));
    await waitFor(() => expect(container.querySelector('[data-network-criterion-id="criterion-target"]')).toHaveFocus());
    expect(container.querySelector('[data-network-criterion-id="criterion-target"]')).toHaveAttribute('data-network-focus', 'true');
    expect(container.querySelector('[data-network-criterion-id="criterion-other"]')).not.toHaveAttribute('data-network-focus');
    expect(container.querySelectorAll('[data-network-focus="true"]')).toHaveLength(1);
    expect(f.api.readGoal).toHaveBeenCalledWith(alpha);
    expect(f.api.controlGoal).not.toHaveBeenCalled();
  });

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
