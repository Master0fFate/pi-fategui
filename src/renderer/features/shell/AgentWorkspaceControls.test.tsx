import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTeam, AgentTeamNode } from '../../../shared/contracts/multiAgent';
import type { RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { AgentWorkspaceDetails } from './AgentWorkspaceControls';

const sourceHead = 'a'.repeat(40);
const targetHead = 'b'.repeat(40);
const child: AgentTeamNode = {
  id: 'worker', teamId: 'team', parentNodeId: 'root', path: '/root/worker', handle: 'worker', displayName: 'Worker', depth: 1,
  role: 'implementer', agentName: 'direct', permissionLevel: 'edit', enabledTools: ['read', 'write', 'edit'],
  model: { provider: 'test', id: 'test', name: 'Test', contextWindow: 100_000, reasoning: true }, thinkingLevel: 'medium', status: 'ready',
  childIds: [], unreadMessages: 0, writer: true, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, createdAt: 1, updatedAt: 1,
  workspace: {
    mode: 'worktree', path: '/managed/worker', parentPath: '/project', commonDirectory: '/project/.git', branch: 'agents/worker', baseRef: 'HEAD', baseCommit: targetHead, state: 'ready',
    review: { sourceHead, targetHead, targetBranch: 'main', dirty: false, targetDirty: false, commits: [{ hash: sourceHead, subject: 'Implement isolated checkout' }], diff: 'diff --git a/file.ts b/file.ts\n+isolated', truncated: false, reviewedAt: 2 },
  },
};
const team: AgentTeam = {
  id: 'team', rootSessionId: 'session', projectPath: '/project', name: 'Implementation', protocolVersion: 2, status: 'active', selected: true, rootNodeId: 'root',
  limits: { maxDepth: 2, maxNodes: 16, maxActiveTurns: 3, maxMessages: 256, maxMessageBytes: 32_768 }, activeTurns: 0, writerNodeId: null,
  usage: child.usage, nodes: [{ ...child, id: 'root', parentNodeId: null, path: '/root', depth: 0, displayName: 'Parent', workspace: undefined }, child],
  tasks: [], envelopes: [], operationReceipts: [], timeline: [], createdAt: 1, updatedAt: 1,
};
const runtime: RuntimeState = {
  status: 'ready', project: { path: '/project', name: 'Project', trusted: true }, sessionId: 'session', sessionFile: '/sessions/root.jsonl',
  permissionLevel: 'edit', streaming: false, model: child.model, models: [child.model], thinkingLevel: 'medium', messages: [], tools: [], sessions: [], commands: [], agentTeams: [team], error: null,
};

async function openDetails() {
  const user = userEvent.setup();
  render(<AgentWorkspaceDetails team={team} node={child} />);
  await user.click(screen.getByLabelText('Workspace for Worker'));
  return user;
}

beforeEach(() => {
  useRuntimeStore.getState().hydrateRuntime(structuredClone(runtime));
  Object.defineProperty(window, 'piDesktop', { value: { controlAgentTeam: vi.fn().mockResolvedValue(runtime) }, configurable: true });
});
afterEach(() => { Reflect.deleteProperty(window, 'piDesktop'); });

describe('agent workspace review', () => {
  it('shows source, target and diff, requiring confirmation and exact HEADs for integration', async () => {
    const user = await openDetails();
    expect(screen.getByText('/managed/worker')).toBeVisible();
    expect(screen.getByLabelText('Workspace diff')).toHaveTextContent('+isolated');
    expect(screen.getByText(/not a security sandbox/u)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Integrate changes' }));
    expect(window.piDesktop.controlAgentTeam).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Integrate into Parent?' });
    await user.click(within(dialog).getByRole('button', { name: 'Integrate' }));
    expect(window.piDesktop.controlAgentTeam).toHaveBeenCalledWith(expect.objectContaining({ action: 'workspace', operation: 'integrate', target: 'worker', strategy: 'ff-only', expectedSourceHead: sourceHead, expectedTargetHead: targetHead }));
  });

  it('requires explicit commit selection for cherry-pick', async () => {
    const user = await openDetails();
    await user.selectOptions(screen.getByLabelText('Integration method'), 'cherry-pick');
    expect(screen.getByRole('button', { name: 'Integrate changes' })).toBeDisabled();
    await user.click(screen.getByLabelText(`Select commit ${sourceHead.slice(0, 12)}`));
    await user.click(screen.getByRole('button', { name: 'Integrate changes' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Integrate' }));
    expect(window.piDesktop.controlAgentTeam).toHaveBeenCalledWith(expect.objectContaining({ strategy: 'cherry-pick', commits: [sourceHead] }));
  });

  it.each(['dirty', 'targetDirty', 'truncated'] as const)('blocks integration when review is %s', async (flag) => {
    const user = userEvent.setup();
    render(<AgentWorkspaceDetails team={team} node={{ ...child, workspace: { ...child.workspace!, review: { ...child.workspace!.review!, [flag]: true } } }} />);
    await user.click(screen.getByLabelText('Workspace for Worker'));
    expect(screen.getByRole('button', { name: 'Integrate changes' })).toBeDisabled();
  });

  it('allows an explicit checkpoint for uncommitted work without changing the parent', async () => {
    const user = userEvent.setup();
    render(<AgentWorkspaceDetails team={team} node={{ ...child, workspace: { ...child.workspace!, review: { ...child.workspace!.review!, dirty: true } } }} />);
    await user.click(screen.getByLabelText('Workspace for Worker'));
    await user.type(screen.getByLabelText('Checkpoint message'), 'Save reviewed implementation');
    await user.click(screen.getByRole('button', { name: 'Commit checkpoint' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Commit checkpoint' }));
    expect(window.piDesktop.controlAgentTeam).toHaveBeenCalledWith(expect.objectContaining({ operation: 'checkpoint', message: 'Save reviewed implementation' }));
    expect(screen.getByRole('status')).toHaveTextContent('Review again before integrating');
  });

  it('requires a closed agent and confirmation to remove a worktree, retaining the branch', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AgentWorkspaceDetails team={team} node={child} />);
    await user.click(screen.getByLabelText('Workspace for Worker'));
    expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeDisabled();
    rerender(<AgentWorkspaceDetails team={team} node={{ ...child, status: 'closed' }} />);
    await user.click(screen.getByRole('button', { name: 'Remove worktree' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('branch and agent history stay available');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove worktree' }));
    expect(window.piDesktop.controlAgentTeam).toHaveBeenCalledWith(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('shows backend failures and preserves the review for recovery', async () => {
    vi.mocked(window.piDesktop.controlAgentTeam).mockRejectedValue(new Error('Parent HEAD changed. Review again.'));
    const user = await openDetails();
    await user.click(screen.getByRole('button', { name: 'Refresh review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Parent HEAD changed');
    expect(screen.getByLabelText('Workspace diff')).toHaveTextContent('+isolated');
  });

  it('does not apply a late response after changing root sessions', async () => {
    let resolve!: (value: RuntimeState) => void;
    vi.mocked(window.piDesktop.controlAgentTeam).mockReturnValue(new Promise((done) => { resolve = done; }));
    const user = await openDetails();
    await user.click(screen.getByRole('button', { name: 'Refresh review' }));
    act(() => useRuntimeStore.getState().hydrateRuntime({ ...runtime, sessionId: 'another-session' }));
    await act(async () => { resolve(runtime); });
    expect(useRuntimeStore.getState().runtime.sessionId).toBe('another-session');
  });

  it('blocks mutations in read-only mode or while the parent is streaming', async () => {
    const user = await openDetails();
    act(() => useRuntimeStore.getState().hydrateRuntime({ ...runtime, streaming: true }));
    expect(screen.getByRole('button', { name: 'Integrate changes' })).toBeDisabled();
    act(() => useRuntimeStore.getState().hydrateRuntime({ ...runtime, permissionLevel: 'read-only' }));
    expect(screen.getByRole('button', { name: 'Integrate changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh review' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Refresh review' }));
    expect(window.piDesktop.controlAgentTeam).toHaveBeenCalledWith(expect.objectContaining({ operation: 'review' }));
  });
});
