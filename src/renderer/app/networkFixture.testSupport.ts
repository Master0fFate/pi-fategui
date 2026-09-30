import { vi } from 'vitest';
import type { NetworkWorkspaceApi } from '../../client/NetworkWorkspaceApi';
import { unsupportedWebFateMethods, type PendingPromptReview, type PendingCommandMethod, type WebWorkspace, type WebSnapshot } from '../../client/WebFateApi';
import type { Capability, WireResultOf } from '../../shared/protocol/methods';
import type { OperationMethod } from '../../shared/protocol/hostOperations';
import type { MutationReceipt } from '../../shared/protocol/commandOutcomes';
import type { NetworkMonitor } from '../../shared/protocol/diagnostics';
import type { ThinkingLevel } from '../../shared/contracts/ipc';

export const alpha: WebWorkspace = { workspaceId: '20000000-0000-4000-8000-000000000002', workspaceGeneration: 1, label: 'Alpha' };
export const beta: WebWorkspace = { workspaceId: '30000000-0000-4000-8000-000000000003', workspaceGeneration: 2, label: 'Beta' };
export const hostEpoch = '10000000-0000-4000-8000-000000000001';
export const hostSession = '40000000-0000-4000-8000-000000000004';
export const otherHostSession = '41000000-0000-4000-8000-000000000004';
export const originalRequestId = `${hostEpoch}.1000.90000000-0000-4000-8000-000000000009`;
export const monitorRowId = '00000000000000000000000000000001';
export const sourceHead = 'a'.repeat(40), targetHead = 'b'.repeat(40);

/** Complete structural adapter fixture: real bounded contract shapes, never fake RuntimeState or PiEvents. */
export function networkFixture(authenticatedSessionId = '80000000-0000-4000-8000-000000000008', controlling = false) {
  let pending: PendingPromptReview | null = null;
  let snapshotCounter = 0, mutationCounter = 10;
  const listeners = new Set<() => void>();
  const host = { connected: true, control: controlling ? 7 : null as number | null, epoch: hostEpoch, sessionId: hostSession,
    selectionRevision: 4, running: true, thinking: 'medium' as ThinkingLevel,
    model: { provider: 'fixture', id: 'one' }, selected: alpha, monitorTotal: 26,
    grants: null as Set<Capability> | null,
    goal: null as WireResultOf<'goal.get'>['goal'], tasks: null as WireResultOf<'task.list'>['list'],
    queue: { items: [], held: [], recovered: [] } as Pick<WireResultOf<'runtime.queueRead'>, 'items' | 'held' | 'recovered'>,
    teams: [] as WireResultOf<'team.read'>['teams'], agents: [] as WireResultOf<'agent.read'>['agents'],
    git: { repository: false, branch: '', ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false } as WireResultOf<'git.status'>,
    history: { head: null, commits: [], truncated: false } as WireResultOf<'git.history'>,
    monitorRows: [{ id: monitorRowId, source: 'runs', state: 'attention', title: 'Run', updatedAt: 1000,
      navigation: { kind: 'run', expiresAt: 90000 } }] as NetworkMonitor['items'],
    detail: { kind: 'run', state: 'attention', updatedAt: 1000, title: 'Host run detail', detail: 'Redacted source detail', redacted: true } as Omit<WireResultOf<'workspace.monitorDetail'>, 'id' | 'sessionId' | 'selectionRevision'>,
  };
  const selection = () => ({ sessionId: host.sessionId, selectionRevision: host.selectionRevision });
  const makeSnapshot = (scope: WebWorkspace, text = `Retained ${scope.label}`): WebSnapshot => ({
    header: { version: 1, snapshotId: `50000000-0000-4000-8000-${String(++snapshotCounter).padStart(12, '0')}`,
      capturedAt: 1000, expiresAt: 61000, workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
      serverEpoch: host.epoch, ...selection(), eventCursor: 0, pageIds: ['60000000-0000-4000-8000-000000000006'],
      eventStream: { serverEpoch: host.epoch, workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
        streamId: '61000000-0000-4000-8000-000000000006', sequence: 0 },
      controls: { status: 'ready', streaming: host.running, activeSessionRunning: host.running, runningSessionCount: host.running ? 1 : 0,
        permissionLevel: 'edit', thinkingLevel: host.thinking, model: host.model, pendingModel: null, pendingThinkingLevel: null,
        sessionOperation: false, queue: { steering: 0, followUp: 0, pending: host.queue.items.length, held: host.queue.held.length, recovered: host.queue.recovered.length } },
      goal: host.goal ? { id: host.goal.id, revision: host.goal.revision, status: host.goal.status, phase: host.goal.phase, objective: host.goal.objective.slice(0, 500) } : null,
      taskRevision: host.tasks?.revision ?? null, tasks: [], agents: [],
      omissions: { history: true, media: true, clippedItems: 1, agentRows: false, taskRows: false, goalText: false,
        taskText: false, agentText: false, queueContents: true }, warnings: ['Run may continue on the host'] },
    items: [{ kind: 'message', id: 'message', role: 'assistant', timestamp: 1, text, clipped: true, mediaOmitted: true }],
  });
  const receipt = (operation: OperationMethod): WireResultOf<'goal.create'> => ({ kind: 'operation', operation, outcome: 'applied',
    requestId: `${host.epoch}.1000.90000000-0000-4000-8000-${String(++mutationCounter).padStart(12, '0')}`,
    durability: 'journaled', sessionId: host.sessionId, viewRevision: mutationCounter });
  const promptReceipt: Extract<MutationReceipt, { kind: 'prompt' }> = { kind: 'prompt', outcome: 'accepted', requestId: originalRequestId,
    durability: 'journaled', sessionId: hostSession, runId: 'a0000000-0000-4000-8000-00000000000a', viewRevision: 5 };
  const unavailable = async (): Promise<never> => { throw new Error('This fixture method was not configured.'); };
  const api = {
    origin: 'http://127.0.0.1:49301', authenticatedSessionId, shared: unsupportedWebFateMethods(),
    get serverEpoch() { return host.epoch; }, get isConnected() { return host.connected; }, get reconnectError() { return null; },
    get control() { return host.control; }, get workspace() { return host.selected; }, get estimatedHostTime() { return 1000; },
    supports: vi.fn((capability: Capability) => host.connected && (host.grants === null || host.grants.has(capability))),
    onInvalidate: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, close: vi.fn(),
    listWorkspaces: vi.fn<NetworkWorkspaceApi['listWorkspaces']>(async () => [alpha, beta]),
    readSnapshot: vi.fn<NetworkWorkspaceApi['readSnapshot']>(async (scope) => { host.selected = scope; return makeSnapshot(scope); }),
    readSessions: vi.fn<NetworkWorkspaceApi['readSessions']>(async () => ({ ...selection(), sessions: [hostSession, otherHostSession].map((id, index) => ({
      id, title: index ? 'Second host session' : 'First host session', createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 1, active: id === host.sessionId })) })),
    readModels: vi.fn<NetworkWorkspaceApi['readModels']>(async () => ({ ...selection(), models: [
      { provider: 'fixture', id: 'one', name: 'Fixture One', reasoning: true, contextWindow: 8192 },
      { provider: 'fixture', id: 'two', name: 'Fixture Two', reasoning: true, contextWindow: 8192 }] })),
    readQueue: vi.fn<NetworkWorkspaceApi['readQueue']>(async () => ({ ...selection(), ...host.queue })),
    readGoal: vi.fn<NetworkWorkspaceApi['readGoal']>(async () => ({ ...selection(), goal: host.goal })),
    readTasks: vi.fn<NetworkWorkspaceApi['readTasks']>(async () => ({ ...selection(), list: host.tasks })),
    readTeams: vi.fn<NetworkWorkspaceApi['readTeams']>(async () => ({ ...selection(), teams: host.teams, truncated: false })),
    readAgents: vi.fn<NetworkWorkspaceApi['readAgents']>(async () => ({ ...selection(), agents: host.agents, truncated: false })),
    readGitStatus: vi.fn<NetworkWorkspaceApi['readGitStatus']>(async () => host.git),
    readGitHistory: vi.fn<NetworkWorkspaceApi['readGitHistory']>(async () => host.history),
    readGitDiff: vi.fn<NetworkWorkspaceApi['readGitDiff']>(async (_scope, path) => ({ path, state: 'unavailable', language: 'plaintext', mediaOmitted: false })),
    readGitCombinedDiff: vi.fn<NetworkWorkspaceApi['readGitCombinedDiff']>(async () => ({ patch: '', truncated: false })),
    readGitCommitDetails: vi.fn<NetworkWorkspaceApi['readGitCommitDetails']>(unavailable),
    readMonitor: vi.fn<NetworkWorkspaceApi['readMonitor']>(async (scope, input) => ({ scope, dashboard: { ...selection(),
      revision: `${host.selectionRevision}:${input.section ?? 'overview'}:${input.offset ?? 0}`, checkedAt: 1000, overall: 'unknown',
      sources: { runs: 'partial', teams: 'ready', tasks: 'unknown', activity: 'unknown' }, sourceCheckedAt: { runs: 1000, teams: 1000, tasks: null, activity: null },
      counts: { active: 1, attention: 1, runs: host.monitorTotal, teams: host.teams.length, tasks: host.tasks?.tasks.length ?? 0, activity: 0 },
      section: input.section ?? 'overview', total: host.monitorTotal, offset: input.offset ?? 0, limit: input.limit ?? 25, unchanged: false, items: host.monitorRows } })),
    readMonitorDetail: vi.fn<NetworkWorkspaceApi['readMonitorDetail']>(async (_scope, id) => {
      if (!host.monitorRows.some((row) => row.id === id && row.navigation)) throw new Error('Unknown scoped navigation binding.');
      return { ...selection(), id, ...host.detail };
    }),
    listFiles: vi.fn<NetworkWorkspaceApi['listFiles']>(async () => ({ directoryId: null, entries: [
      { resourceId: '70000000-0000-4000-8000-000000000007', name: 'readme.txt', kind: 'file' }], truncated: false })),
    previewText: vi.fn<NetworkWorkspaceApi['previewText']>(async (scope, fileId) => ({ fileId, content: `Contents for ${scope.label}`, truncated: false })),
    uploadText: vi.fn<NetworkWorkspaceApi['uploadText']>(unavailable), cancelTextAttachment: vi.fn<NetworkWorkspaceApi['cancelTextAttachment']>(unavailable),
    claimControl: vi.fn<NetworkWorkspaceApi['claimControl']>(async () => { host.control = 7; return { generation: 7, expiresAt: 31000 }; }),
    renewControl: vi.fn<NetworkWorkspaceApi['renewControl']>(async () => ({ generation: 7, expiresAt: 31000 })),
    takeOverControl: vi.fn<NetworkWorkspaceApi['takeOverControl']>(async () => { host.control = 8; return { generation: 8, expiresAt: 31000 }; }),
    releaseControl: vi.fn<NetworkWorkspaceApi['releaseControl']>(async () => { host.control = null; }),
    requestPermissionApproval: vi.fn<NetworkWorkspaceApi['requestPermissionApproval']>(unavailable), respondPermissionApproval: vi.fn<NetworkWorkspaceApi['respondPermissionApproval']>(unavailable),
    sendPrompt: vi.fn<NetworkWorkspaceApi['sendPrompt']>(async () => promptReceipt),
    abort: vi.fn<NetworkWorkspaceApi['abort']>(async () => ({ kind: 'abort', requestId: originalRequestId, outcome: 'abort-reported', durability: 'journaled', sessionId: host.sessionId, viewRevision: 5 })),
    createSession: vi.fn<NetworkWorkspaceApi['createSession']>(async () => { host.sessionId = otherHostSession; host.selectionRevision++; return receipt('session.create'); }),
    selectSession: vi.fn<NetworkWorkspaceApi['selectSession']>(async (_scope, id) => { host.sessionId = id; host.selectionRevision++; return {
      kind: 'selection', requestId: originalRequestId, outcome: 'selected', durability: 'journaled', sessionId: id, selectionRevision: host.selectionRevision, viewRevision: 5 }; }),
    setModel: vi.fn<NetworkWorkspaceApi['setModel']>(async (_scope, provider, id) => { host.model = { provider, id }; return receipt('runtime.setModel'); }),
    setThinking: vi.fn<NetworkWorkspaceApi['setThinking']>(async (_scope, level) => { host.thinking = level; return receipt('runtime.setThinking'); }),
    mutateQueue: vi.fn<NetworkWorkspaceApi['mutateQueue']>(async () => receipt('runtime.queue')),
    createGoal: vi.fn<NetworkWorkspaceApi['createGoal']>(async () => receipt('goal.create')), controlGoal: vi.fn<NetworkWorkspaceApi['controlGoal']>(async () => receipt('goal.control')),
    updateGoal: vi.fn<NetworkWorkspaceApi['updateGoal']>(async () => receipt('goal.update')), clearGoal: vi.fn<NetworkWorkspaceApi['clearGoal']>(async () => receipt('goal.clear')),
    editGoalSteering: vi.fn<NetworkWorkspaceApi['editGoalSteering']>(async () => receipt('goal.editSteering')), removeGoalSteering: vi.fn<NetworkWorkspaceApi['removeGoalSteering']>(async () => receipt('goal.removeSteering')),
    createTask: vi.fn<NetworkWorkspaceApi['createTask']>(async () => receipt('task.create')), updateTask: vi.fn<NetworkWorkspaceApi['updateTask']>(async () => receipt('task.update')),
    reorderTasks: vi.fn<NetworkWorkspaceApi['reorderTasks']>(async () => receipt('task.reorder')), deleteTask: vi.fn<NetworkWorkspaceApi['deleteTask']>(async () => receipt('task.delete')), clearTasks: vi.fn<NetworkWorkspaceApi['clearTasks']>(async () => receipt('task.clear')),
    controlAgent: vi.fn<NetworkWorkspaceApi['controlAgent']>(async () => receipt('agent.control')), controlTeam: vi.fn<NetworkWorkspaceApi['controlTeam']>(async () => receipt('team.control')),
    agentWorkspace: vi.fn<NetworkWorkspaceApi['agentWorkspace']>(async () => receipt('agent.workspace')),
    assertPendingReviewStorageAvailable: vi.fn(),
    rememberPendingPromptReview: vi.fn<NetworkWorkspaceApi['rememberPendingPromptReview']>((scope, sessionId, requestId, method: PendingCommandMethod = 'runtime.prompt') => {
      pending = { version: 1, origin: api.origin, authSessionId: authenticatedSessionId, serverEpoch: requestId.split('.')[0]!,
        workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration, sessionId, requestId, method };
    }),
    pendingPromptReview: vi.fn<NetworkWorkspaceApi['pendingPromptReview']>((scope, sessionId) => !pending ? { kind: 'none' }
      : pending.sessionId === sessionId && pending.workspaceId === scope.workspaceId && pending.workspaceGeneration === scope.workspaceGeneration && pending.serverEpoch === host.epoch
        ? { kind: 'match', value: pending } : { kind: 'blocked', reason: 'mismatch', value: pending }),
    clearPendingPromptReview: vi.fn(() => { pending = null; }),
    reviewPromptStatus: vi.fn<NetworkWorkspaceApi['reviewPromptStatus']>(async () => ({ state: 'settled', receipt: promptReceipt, rejectionCode: null })),
  } satisfies NetworkWorkspaceApi & { shared: ReturnType<typeof unsupportedWebFateMethods> };
  return { api, host, makeSnapshot, receipt, promptReceipt,
    disconnect: () => { host.connected = false; host.control = null; for (const listener of listeners) listener(); } };
}
