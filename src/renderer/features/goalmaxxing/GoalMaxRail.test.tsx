import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import type { PiDesktopApi } from '../../../shared/contracts/ipc';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useUiStore } from '../../stores/uiStore';
import { GoalMaxRail } from './GoalMaxRail';

function goal(status: GoalMaxState['status'] = 'active'): GoalMaxState {
  return {
    schemaVersion: 2, id: 'goal-1', sessionId: 's1', projectPath: '/project', revision: 1, objective: 'Implement the durable goal control plane', originalBriefRef: null, originalBriefHash: null,
    status, phase: 'implementation', executionState: 'idle', verificationLevel: 'normal', agentStrategy: 'auto',
    criteria: [{ id: 'criterion-1', title: 'Implement', description: '', required: true, status: 'active', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 }],
    budget: { tokenLimit: null, timeLimitMs: null, source: null }, permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: 1 },
    progress: { meaningfulTurnCount: 1, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 2, baselineWorkspaceFingerprint: 'a', latestWorkspaceFingerprint: 'b', latestEvidenceAt: null, latestMeaningfulProgressAt: 1, lastFailureFingerprint: null },
    evidence: [], continuation: { pending: false, attempt: 1, lastScheduledAt: 1, lastSettledAt: 1, reason: null }, steering: [], childAssignments: [],
    tokensUsed: 100, tokenBaseline: 0, elapsedMs: 1_000, timeline: [], createdAt: 1, updatedAt: 1, startedAt: 1, completedAt: null, blockedReason: null, failure: null,
  };
}

beforeEach(() => {
  useGoalMaxStore.setState({ projectPath: '/project', sessionId: 's1', goal: goal(), loading: false, selectionGeneration: 1 });
  useUiStore.setState({ inspectorCollapsed: true, inspectorTab: 'changes', goalEditorOpen: false, toast: null });
});
afterEach(() => Reflect.deleteProperty(window, 'piDesktop'));

describe('GoalMax rail', () => {
  it('opens the Flight Deck and exposes compact edit and pause controls', async () => {
    const user = userEvent.setup();
    const paused = { ...goal(), revision: 2, status: 'paused' as const };
    const controlGoalMax = vi.fn(async () => paused);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { controlGoalMax } as unknown as PiDesktopApi });
    render(<GoalMaxRail />);
    expect(screen.getByRole('region', { name: 'Current GoalMax goal' })).toHaveTextContent('Implement the durable goal control plane');
    await user.click(screen.getByRole('button', { name: 'Open Goal Flight Deck' }));
    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'goal', inspectorCollapsed: false });
    await user.click(screen.getByRole('button', { name: 'Pause goal' }));
    await waitFor(() => expect(controlGoalMax).toHaveBeenCalledWith({ action: 'pause' }));
    expect(useGoalMaxStore.getState().goal?.status).toBe('paused');
  });

  it('preserves in-progress edits when live goal events advance the revision', async () => {
    const user = userEvent.setup();
    const updateGoalMax = vi.fn(async () => ({ ...goal(), revision: 3, objective: 'Edited objective' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { updateGoalMax } as unknown as PiDesktopApi });
    render(<GoalMaxRail />);
    await user.click(screen.getByRole('button', { name: 'Edit goal' }));
    const objective = screen.getByRole('textbox', { name: 'Objective' });
    await user.clear(objective);
    await user.type(objective, 'Edited objective');

    expect(screen.getByRole('combobox', { name: 'Goal agent strategy' })).toHaveTextContent('Auto');
    act(() => useGoalMaxStore.getState().setGoal({ ...goal(), revision: 2, tokensUsed: 200 }));
    expect(objective).toHaveValue('Edited objective');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateGoalMax).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1, objective: 'Edited objective', agentStrategy: 'auto' })));
  });

  it('requires confirmation before cancelling and clearing active work', async () => {
    const user = userEvent.setup();
    const clearGoalMax = vi.fn(async () => ({ cleared: true, archivedGoalId: 'goal-1' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { clearGoalMax } as unknown as PiDesktopApi });
    render(<GoalMaxRail />);
    await user.click(screen.getByRole('button', { name: 'Clear goal' }));
    expect(screen.getByRole('dialog', { name: 'Clear this goal?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel & clear' }));
    await waitFor(() => expect(clearGoalMax).toHaveBeenCalledOnce());
    expect(useGoalMaxStore.getState().goal).toBeNull();
  });
});
